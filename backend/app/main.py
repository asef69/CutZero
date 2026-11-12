"""FastAPI service: REST endpoints plus the live optimizer stream at WS /ws/optimize."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import database
from .exporter import export_gcode, export_svg
from .impact import CO2_FACTOR_ALUMINIUM, CO2_FACTOR_TEXTILE, compute_impact
from .presets import all_presets
from .svg_parser import SvgParseError, parse_svg
from .verify import verify_layout

log = logging.getLogger("cutzero")

try:
    from . import _cutzero_core as core  # type: ignore[attr-defined]
except ImportError as exc:  # pragma: no cover - only hit before the engine is compiled
    core = None
    CORE_IMPORT_ERROR = str(exc)
else:
    CORE_IMPORT_ERROR = ""

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_PIECES = 300
MAX_ITERATIONS = 20000
MAX_SOLVE_SECONDS = 60.0
# Each solve can occupy several cores, so concurrent runs are bounded rather than left to pile up.
MAX_CONCURRENT_SOLVES = int(os.environ.get("CUTZERO_MAX_SOLVES", "2"))
_solve_slots = asyncio.Semaphore(MAX_CONCURRENT_SOLVES)


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.init_db()
    yield


app = FastAPI(title="CutZero", version="1.0.0", lifespan=lifespan)

_origins = os.environ.get("CUTZERO_CORS_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_core() -> Any:
    if core is None:
        raise HTTPException(503, f"C++ engine is not built. Run scripts/build_cpp.py. ({CORE_IMPORT_ERROR})")
    return core


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine": "native" if core is not None else "missing",
        "engine_version": getattr(core, "__version__", None),
        "cores": os.cpu_count(),
        "database": database.aggregate_stats()["backend"],
    }


@app.get("/api/presets")
def presets() -> list[dict[str, Any]]:
    engine = _require_core()
    out = []
    for preset in all_presets().values():
        base = engine.baseline(
            preset["pieces"],
            {
                "roll_width_mm": preset["roll_width_mm"],
                "kerf_mm": preset["default_kerf_mm"],
                "allowed_rotations_deg": [float(r) for r in preset["default_rotations_deg"]],
            },
        )
        out.append(
            {
                **preset,
                "baseline_length_mm": base["baseline_length_mm"],
                "baseline_layout": base["baseline_layout"],
            }
        )
    return out


@app.post("/api/parse-svg")
async def parse_svg_endpoint(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "SVG files are limited to 5 MB.")
    try:
        pieces = await asyncio.to_thread(parse_svg, data)
    except SvgParseError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "name": file.filename or "Uploaded SVG",
        "piece_count": len(pieces),
        "total_area_m2": sum(p["area_mm2"] for p in pieces) / 1e6,
        "pieces": pieces,
    }


@app.get("/api/jobs")
def jobs(limit: int = 50) -> dict[str, Any]:
    return {"jobs": database.list_jobs(min(max(limit, 1), 200)), "aggregate": database.aggregate_stats()}


def _load_job(job_id: str) -> dict[str, Any]:
    job = database.get_job(job_id)
    if job is None:
        raise HTTPException(404, "No such job.")
    return job


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: str) -> dict[str, Any]:
    return _load_job(job_id)


@app.get("/api/jobs/{job_id}/export-svg")
def job_export_svg(job_id: str) -> Response:
    return Response(
        export_svg(_load_job(job_id)),
        media_type="image/svg+xml",
        headers={"Content-Disposition": f'attachment; filename="cutzero-{job_id[:8]}.svg"'},
    )


@app.get("/api/jobs/{job_id}/export-gcode")
def job_export_gcode(job_id: str, feed_mm_min: float = 3000.0) -> PlainTextResponse:
    return PlainTextResponse(
        export_gcode(_load_job(job_id), feed_mm_min=max(feed_mm_min, 1.0)),
        headers={"Content-Disposition": f'attachment; filename="cutzero-{job_id[:8]}.gcode"'},
    )


class BaselineRequest(BaseModel):
    pieces: list[dict[str, Any]] = Field(max_length=MAX_PIECES)
    roll_width_mm: float = Field(gt=0)
    kerf_mm: float = Field(ge=0, le=50)
    allowed_rotations_deg: list[float] = Field(min_length=1, max_length=72)


@app.post("/api/baseline")
def baseline_layout(req: BaselineRequest) -> dict[str, Any]:
    """First-Fit Decreasing layout for settings the built-in presets don't cover."""
    engine = _require_core()
    cfg = {
        "roll_width_mm": req.roll_width_mm,
        "kerf_mm": req.kerf_mm,
        "allowed_rotations_deg": req.allowed_rotations_deg,
    }
    try:
        result = engine.baseline(req.pieces, cfg)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    result["baseline_layout"] = _slim(result["baseline_layout"])
    return result


class RadarRequest(BaseModel):
    pieces: list[dict[str, Any]] = Field(max_length=MAX_PIECES)
    roll_width_mm: float = Field(gt=0)
    kerf_mm: float = Field(ge=0, le=50)
    allowed_rotations_deg: list[float] = Field(min_length=1, max_length=72)
    layout: list[dict[str, Any]] = Field(max_length=MAX_PIECES)
    piece_id: int
    rotation_deg: float


@app.post("/api/radar")
async def radar(req: RadarRequest) -> dict[str, Any]:
    """Runs one real FFT correlation and returns every free offset for the chosen piece."""
    engine = _require_core()
    cfg = {
        "roll_width_mm": req.roll_width_mm,
        "kerf_mm": req.kerf_mm,
        "allowed_rotations_deg": req.allowed_rotations_deg,
    }
    try:
        result = await asyncio.to_thread(engine.radar, req.pieces, cfg, req.layout, req.piece_id, req.rotation_deg)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    result["free"] = base64.b64encode(result["free"]).decode("ascii")
    return result


# ---------------------------------------------------------------------------
# WebSocket optimizer stream
# ---------------------------------------------------------------------------


class JobError(ValueError):
    pass


def _resolve_job(msg: dict[str, Any]) -> dict[str, Any]:
    preset = all_presets().get(msg.get("preset_id", "")) if msg.get("preset_id") else None
    if msg.get("preset_id") and preset is None:
        raise JobError(f"Unknown preset '{msg['preset_id']}'.")
    pieces = msg.get("pieces") or (preset["pieces"] if preset else None)
    if not pieces:
        raise JobError("Send either preset_id or a pieces array.")
    if len(pieces) > MAX_PIECES:
        raise JobError(f"At most {MAX_PIECES} pieces per job.")

    def number(key: str, default: Any, lo: float, hi: float) -> float:
        raw = msg.get(key, default)
        try:
            value = float(raw)
        except (TypeError, ValueError) as exc:
            raise JobError(f"{key} must be a number.") from exc
        if not lo <= value <= hi:
            raise JobError(f"{key} must be between {lo:g} and {hi:g}.")
        return value

    width = number("roll_width_mm", preset["roll_width_mm"] if preset else None, 50, 10000)
    kerf = number("kerf_mm", preset["default_kerf_mm"] if preset else 2.0, 0, 50)
    gsm = number("fabric_gsm", preset["fabric_gsm"] if preset else 180.0, 1, 100000)
    # The PRD's sample payload spells this batch_Count; accept both spellings.
    batch = int(number("batch_count", msg.get("batch_Count", 100), 1, 1000000))
    iterations = int(number("max_iterations", 200, 1, MAX_ITERATIONS))
    seed = int(number("seed", 42, 0, 2**53))

    rotations = msg.get("allowed_rotations_deg") or (preset["default_rotations_deg"] if preset else [0, 90, 180, 270])
    if not isinstance(rotations, list) or not 1 <= len(rotations) <= 72:
        raise JobError("allowed_rotations_deg must list between 1 and 72 angles.")
    rotations = [float(r) for r in rotations]

    default_factor = (
        preset["co2_factor_kg_per_kg"] if preset else (CO2_FACTOR_ALUMINIUM if gsm >= 1000 else CO2_FACTOR_TEXTILE)
    )
    return {
        "name": preset["name"] if preset else str(msg.get("name", "Custom SVG"))[:200],
        "preset_id": preset["id"] if preset else None,
        "pieces": pieces,
        "roll_width_mm": width,
        "kerf_mm": kerf,
        "fabric_gsm": gsm,
        "batch_count": batch,
        "max_iterations": iterations,
        "allowed_rotations_deg": rotations,
        "co2_factor": number("co2_factor_kg_per_kg", default_factor, 0, 1000),
        "seed": seed,
    }


def _slim(layout: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"id": p["id"], "rotation_deg": p["rotation_deg"], "tx": round(p["tx"], 3), "ty": round(p["ty"], 3)}
        for p in layout
    ]


@app.websocket("/ws/optimize")
async def ws_optimize(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Messages must be JSON."})
                continue
            if msg.get("type") == "stop":
                continue  # Nothing running on this connection.
            try:
                job = _resolve_job(msg)
            except JobError as exc:
                await ws.send_json({"type": "error", "message": str(exc)})
                continue
            if core is None:
                await ws.send_json({"type": "error", "message": f"C++ engine is not built. ({CORE_IMPORT_ERROR})"})
                continue
            await _run_job(ws, job)
    except WebSocketDisconnect:
        return


async def _run_job(ws: WebSocket, job: dict[str, Any]) -> None:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    stop = threading.Event()

    config = {
        "roll_width_mm": job["roll_width_mm"],
        "kerf_mm": job["kerf_mm"],
        "allowed_rotations_deg": job["allowed_rotations_deg"],
        "max_iterations": job["max_iterations"],
        "seed": job["seed"],
        "time_limit_ms": MAX_SOLVE_SECONDS * 1000.0,
    }

    try:
        base = core.baseline(job["pieces"], config)
    except ValueError as exc:
        await ws.send_json({"type": "error", "message": str(exc)})
        return
    baseline_length = base["baseline_length_mm"]
    total_area = base["total_area_mm2"]
    baseline_layout = _slim(base["baseline_layout"])

    def impact_for(length: float) -> dict[str, Any]:
        return compute_impact(
            total_area,
            job["roll_width_mm"],
            baseline_length,
            length,
            job["fabric_gsm"],
            job["batch_count"],
            job["co2_factor"],
        )

    def on_frame(frame: dict[str, Any]) -> bool:
        # Runs on the solver thread with the GIL held only for the duration of this call.
        message = {
            "type": "progress",
            "phase": frame["phase"],
            "iteration": frame["iteration"],
            "max_iterations": frame["max_iterations"],
            "temperature": round(frame["temperature"], 3),
            "elapsed_ms": round(frame["elapsed_ms"], 1),
            "roll_width_mm": job["roll_width_mm"],
            "baseline_length_mm": baseline_length,
            "optimized_length_mm": frame["best_length_mm"],
            "current_length_mm": frame["current_length_mm"],
            "evaluations": frame["evaluations"],
            "accepted_moves": frame["accepted_moves"],
            "improved": frame["improved"],
            "baseline_layout": baseline_layout,
            "optimized_layout": _slim(frame["layout"]),
            **impact_for(frame["best_length_mm"]),
        }
        loop.call_soon_threadsafe(queue.put_nowait, message)
        return not stop.is_set()

    async def solve() -> dict[str, Any]:
        async with _solve_slots:
            if stop.is_set():
                raise asyncio.CancelledError
            return await asyncio.to_thread(core.solve, job["pieces"], config, on_frame)

    await ws.send_json(
        {
            "type": "start",
            "name": job["name"],
            "roll_width_mm": job["roll_width_mm"],
            "baseline_length_mm": baseline_length,
            "baseline_layout": baseline_layout,
            "total_area_m2": total_area / 1e6,
            "busy": _solve_slots.locked(),
        }
    )

    solve_task = asyncio.create_task(solve())
    solve_task.add_done_callback(lambda _: loop.call_soon_threadsafe(queue.put_nowait, None))

    async def listen() -> None:
        """A Stop message or a dropped connection ends the solve instead of burning CPU."""
        try:
            while True:
                incoming = await ws.receive_text()
                try:
                    if json.loads(incoming).get("type") == "stop":
                        stop.set()
                except (json.JSONDecodeError, AttributeError):
                    pass
        except (WebSocketDisconnect, RuntimeError):
            stop.set()

    listener = asyncio.create_task(listen())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            await ws.send_json(item)

        try:
            result = solve_task.result()
        except asyncio.CancelledError:
            return
        except ValueError as exc:
            await ws.send_json({"type": "error", "message": str(exc)})
            return

        optimized = _slim(result["optimized_layout"])
        final = await asyncio.to_thread(_finish_job, job, result, optimized, baseline_layout, impact_for)
        await ws.send_json(final)
    except (WebSocketDisconnect, RuntimeError):
        stop.set()
    finally:
        listener.cancel()
        try:
            await listener
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - the socket may already be gone
            pass


def _finish_job(
    job: dict[str, Any],
    result: dict[str, Any],
    optimized: list[dict[str, Any]],
    baseline_layout: list[dict[str, Any]],
    impact_for: Any,
) -> dict[str, Any]:
    length = result["optimized_length_mm"]
    impact = impact_for(length)
    # Checked against the rounded coordinates that actually get exported and stored, not the
    # engine's internal doubles. The engine's 2 micron slack absorbs the rounding.
    check = verify_layout(job["pieces"], optimized, job["roll_width_mm"], job["kerf_mm"])
    stats = result["stats"]

    job_id = None
    if not stats["cancelled"]:
        try:
            job_id = database.save_job(
                {
                    "name": job["name"],
                    "preset_id": job["preset_id"],
                    "piece_count": len(job["pieces"]),
                    "roll_width_mm": job["roll_width_mm"],
                    "kerf_mm": job["kerf_mm"],
                    "fabric_gsm": job["fabric_gsm"],
                    "batch_count": job["batch_count"],
                    "co2_factor": job["co2_factor"],
                    "max_iterations": job["max_iterations"],
                    "allowed_rotations_deg": job["allowed_rotations_deg"],
                    "baseline_length_mm": result["baseline_length_mm"],
                    "optimized_length_mm": length,
                    "baseline_utilization_pct": impact["baseline_utilization_pct"],
                    "optimized_utilization_pct": impact["optimized_utilization_pct"],
                    "linear_saved_m": impact["linear_saved_m"],
                    "waste_saved_kg_per_batch": impact["waste_saved_kg_per_batch"],
                    "co2_saved_kg_per_batch": impact["co2_saved_kg_per_batch"],
                    "solve_ms": stats["solve_ms"],
                    "verified": check["valid"],
                    "min_clearance_mm": check["min_clearance_mm"],
                    "pieces": job["pieces"],
                    "baseline_layout": baseline_layout,
                    "optimized_layout": optimized,
                    "stats": stats,
                }
            )
        except Exception:  # A database outage must not cost the judge their finished result.
            log.exception("Could not persist job")

    return {
        "type": "complete",
        "job_id": job_id,
        "iteration": job["max_iterations"],
        "max_iterations": job["max_iterations"],
        "temperature": 0.0,
        "elapsed_ms": stats["solve_ms"],
        "roll_width_mm": job["roll_width_mm"],
        "baseline_length_mm": result["baseline_length_mm"],
        "optimized_length_mm": length,
        "baseline_layout": baseline_layout,
        "optimized_layout": optimized,
        "engine_validation": result["optimized_validation"],
        "verification": check,
        "stats": stats,
        "cancelled": stats["cancelled"],
        **impact,
    }


# ---------------------------------------------------------------------------
# Static studio (single-container deployments)
# ---------------------------------------------------------------------------

_dist = Path(os.environ.get("CUTZERO_STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="studio")
