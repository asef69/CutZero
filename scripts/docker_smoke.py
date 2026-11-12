"""End-to-end smoke test for a running CutZero container (used by CI after `docker compose up`).

    python scripts/docker_smoke.py [http://localhost:8000]

Checks the studio, the native engine, PostgreSQL, a full optimisation over the WebSocket,
the run history and both production exports. Needs only `websockets` on the client side.
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

import websockets

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"


def get(path: str) -> tuple[int, bytes]:
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return response.status, response.read()


def get_json(path: str) -> dict:
    status, body = get(path)
    assert status == 200, f"{path} -> {status}"
    return json.loads(body)


def wait_for_health(timeout_s: float = 180) -> dict:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return get_json("/api/health")
        except Exception as exc:  # noqa: BLE001 - still starting
            if time.monotonic() > deadline:
                raise SystemExit(f"server never became healthy: {exc}")
            time.sleep(2)


async def optimise() -> dict:
    url = BASE.replace("http", "ws", 1) + "/ws/optimize"
    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({
            "preset_id": "mens_dress_shirt",
            "roll_width_mm": 1500.0,
            "kerf_mm": 2.0,
            "fabric_gsm": 180.0,
            "batch_count": 100,
            "max_iterations": 200,
        }))
        frames = 0
        while True:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
            assert message["type"] != "error", message
            if message["type"] == "progress":
                frames += 1
            if message["type"] == "complete":
                message["_progress_frames"] = frames
                return message


def main() -> None:
    health = wait_for_health()
    print("health:", health)
    assert health["engine"] == "native", "C++ engine module did not load"
    expected_db = os.environ.get("EXPECT_DB", "postgresql")
    assert health["database"] == expected_db, f"database is {health['database']}, expected {expected_db}"

    status, page = get("/")
    assert status == 200 and b'id="root"' in page, "studio index.html not served"
    status, wasm = get("/cutzero_core.wasm")
    assert status == 200 and wasm[:4] == b"\0asm", "WASM engine not served"
    print(f"studio: index.html ok, wasm {len(wasm) / 1024:.0f} KB")

    presets = get_json("/api/presets")
    items = presets if isinstance(presets, list) else presets.get("presets", [])
    assert len(items) == 3, f"expected 3 presets, got {len(items)}"
    print("presets:", ", ".join(p["id"] for p in items))

    started = time.perf_counter()
    result = asyncio.run(optimise())
    elapsed = time.perf_counter() - started
    base, opt = result["baseline_utilization_pct"], result["optimized_utilization_pct"]
    print(
        f"optimise: {base:.1f}% -> {opt:.1f}% in {elapsed:.2f}s, "
        f"{result['_progress_frames']} progress frames, job {result['job_id']}"
    )
    assert result["verification"]["valid"], result["verification"]
    assert opt - base >= 14, "shirt gained less than 14 points"
    assert result["job_id"], "run was not saved"

    get_json(f"/api/jobs/{result['job_id']}")
    status, svg = get(f"/api/jobs/{result['job_id']}/export-svg")
    assert status == 200 and b"<svg" in svg
    status, gcode = get(f"/api/jobs/{result['job_id']}/export-gcode")
    assert status == 200 and b"G01" in gcode
    lines = gcode.count(b"\n")
    print(f"exports: svg {len(svg) / 1024:.0f} KB, gcode {lines} lines")

    history = get_json("/api/jobs")
    print("history:", history["aggregate"])
    assert history["aggregate"]["runs"] >= 1
    print("DOCKER SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
