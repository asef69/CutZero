"""End-to-end checks of the API, the engine bridge, and the independent verifier."""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.exporter import export_gcode, export_svg  # noqa: E402
from app.impact import compute_impact  # noqa: E402
from app.presets import all_presets  # noqa: E402
from app.svg_parser import SvgParseError, parse_svg  # noqa: E402
from app.verify import verify_layout  # noqa: E402

pytestmark = pytest.mark.skipif(main.core is None, reason="C++ engine not built")


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        yield c


def test_presets_match_the_prd_piece_counts(client):
    presets = {p["id"]: p for p in client.get("/api/presets").json()}
    assert presets["mens_dress_shirt"]["piece_count"] == 28
    assert presets["technical_shell_jacket"]["piece_count"] == 36
    assert presets["sheet_metal_enclosure"]["piece_count"] == 24
    for preset in presets.values():
        assert preset["baseline_length_mm"] > 0
        assert len(preset["baseline_layout"]) == preset["piece_count"]


def test_impact_formulas_reproduce_the_prd_worked_example():
    # PRD worked example: 1500 mm roll, 2480 -> 1915 mm, 180 GSM, 100 lays, 15.2 kg CO2e/kg.
    area = 0.674 * 1500 * 2480
    impact = compute_impact(area, 1500, 2480, 1915, 180, 100, 15.2)
    assert impact["linear_saved_m"] == pytest.approx(0.565)
    assert impact["waste_saved_kg_per_batch"] == pytest.approx(15.255, abs=1e-3)
    assert impact["co2_saved_kg_per_batch"] == pytest.approx(231.876, abs=1e-2)
    assert impact["optimized_utilization_pct"] == pytest.approx(87.29, abs=0.01)


def test_websocket_streams_progress_and_a_verified_result(client):
    with client.websocket_connect("/ws/optimize") as ws:
        # PRD sample payload, including its batch_Count spelling.
        ws.send_json(
            {
                "preset_id": "mens_dress_shirt",
                "roll_width_mm": 1500.0,
                "kerf_mm": 2.0,
                "fabric_gsm": 180.0,
                "batch_Count": 100,
                "allowed_rotations_deg": [0, 180],
                "max_iterations": 200,
            }
        )
        start = ws.receive_json()
        assert start["type"] == "start"
        progress = []
        while True:
            message = ws.receive_json()
            if message["type"] == "complete":
                break
            assert message["type"] == "progress"
            progress.append(message)

    assert len(progress) >= 15, "MVP requires 15+ streamed frames"
    lengths = [m["optimized_length_mm"] for m in progress]
    assert lengths == sorted(lengths, reverse=True), "best length must never get worse"
    assert message["verification"]["valid"]
    assert message["verification"]["min_clearance_mm"] >= 2.0
    assert message["engine_validation"]["violations"] == 0
    assert message["utilization_gain_pct"] >= 14.0, "MVP requires +14 points on the shirt"
    assert message["job_id"]

    job_id = message["job_id"]
    svg = client.get(f"/api/jobs/{job_id}/export-svg")
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert svg.text.count("<path ") == 28
    gcode = client.get(f"/api/jobs/{job_id}/export-gcode").text
    assert "G21" in gcode and "G00" in gcode and "G01" in gcode and gcode.rstrip().endswith("M30 ; end of program")
    assert job_id in {j["id"] for j in client.get("/api/jobs").json()["jobs"]}


def test_websocket_rejects_bad_input(client):
    with client.websocket_connect("/ws/optimize") as ws:
        ws.send_json({"preset_id": "nope"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"preset_id": "mens_dress_shirt", "roll_width_mm": 300})
        error = ws.receive_json()
        assert error["type"] == "error" and "does not fit" in error["message"]


def test_stop_message_ends_a_long_run(client):
    with client.websocket_connect("/ws/optimize") as ws:
        ws.send_json({"preset_id": "technical_shell_jacket", "max_iterations": 20000})
        assert ws.receive_json()["type"] == "start"
        assert ws.receive_json()["type"] == "progress"
        ws.send_json({"type": "stop"})
        while (message := ws.receive_json())["type"] != "complete":
            pass
    assert message["cancelled"] is True
    assert message["verification"]["valid"]


def test_verifier_catches_an_overlap():
    preset = all_presets()["sheet_metal_enclosure"]
    pieces = preset["pieces"][:2]
    good = [
        {"id": pieces[0]["id"], "rotation_deg": 0, "tx": 10, "ty": 10},
        {"id": pieces[1]["id"], "rotation_deg": 0, "tx": 600, "ty": 10},
    ]
    assert verify_layout(pieces, good, 1200, 2)["valid"]
    bad = [good[0], {**good[1], "tx": 20}]
    report = verify_layout(pieces, bad, 1200, 2)
    assert not report["valid"] and report["problems"]


def test_svg_parser_handles_curves_holes_and_units():
    svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="20cm" height="10cm" viewBox="0 0 200 100">
      <path d="M10 10 h80 v80 h-80 Z M30 30 v40 h40 v-40 Z"/>
      <g transform="translate(100 0)"><circle cx="50" cy="50" r="40"/></g>
      <path d="M0 0 C 10 0 20 10 20 20 L 0 20 Z" transform="translate(5 5)"/>
    </svg>"""
    pieces = parse_svg(svg)
    names = sorted(len(p["holes"]) for p in pieces)
    assert names.count(1) == 1, "inner square becomes a hole"
    square = next(p for p in pieces if p["holes"])
    # 1 user unit = 1 mm here (20 cm across 200 units): 80x80 square minus 40x40 hole.
    assert square["area_mm2"] == pytest.approx(80 * 80 - 40 * 40, rel=1e-3)
    circle = max(pieces, key=lambda p: len(p["outer"]))
    assert circle["area_mm2"] == pytest.approx(3.14159 * 40 * 40, rel=0.02)


def test_svg_parser_refuses_entity_expansion():
    bomb = b"""<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>
      <svg xmlns="http://www.w3.org/2000/svg"><title>&b;</title></svg>"""
    with pytest.raises(SvgParseError):
        parse_svg(bomb)


def test_exporters_produce_closed_contours():
    preset = all_presets()["sheet_metal_enclosure"]
    chosen = [p for p in preset["pieces"] if p["name"] in ("Large L-bracket 1", "U-frame 1", "Fan cut-out plate 1")]
    layout = [{"id": p["id"], "rotation_deg": 0, "tx": 10 + 800 * i, "ty": 10} for i, p in enumerate(chosen)]
    job = {
        "name": "unit",
        "roll_width_mm": 1200,
        "optimized_length_mm": 2500,
        "optimized_utilization_pct": 50,
        "kerf_mm": 2,
        "pieces": preset["pieces"],
        "optimized_layout": layout,
    }
    svg = export_svg(job)
    assert svg.count("<path ") == 3
    gcode = export_gcode(job)
    # The fan plate has 5 cut-outs that must be cut before its outline.
    lines = gcode.splitlines()
    first_outline = next(i for i, line in enumerate(lines) if "Fan cut-out plate 1 / outline" in line)
    cutouts = [i for i, line in enumerate(lines) if "Fan cut-out plate 1 / cut-out" in line]
    assert len(cutouts) == 5 and max(cutouts) < first_outline


def _run(ws, payload):
    ws.send_json(payload)
    while (message := ws.receive_json())["type"] not in ("complete", "error"):
        pass
    return message


FLAWS = [{"x": 420, "y": 310, "r": 30}, {"x": 1150, "y": 900, "r": 30}, [[1780, 480], [1840, 480], [1840, 560], [1780, 560]]]


def test_parts_are_nested_around_fabric_defects(client):
    with client.websocket_connect("/ws/optimize") as ws:
        result = _run(ws, {"preset_id": "mens_dress_shirt", "max_iterations": 60, "defects": FLAWS})
    assert result["type"] == "complete"
    assert result["verification"]["valid"], result["verification"]["problems"]
    assert result["verification"]["defects_checked"] == 3
    assert result["engine_validation"]["violations"] == 0
    assert len(result["optimized_layout"]) == 28

    # The SVG and DXF mark the flaws so the cutter can see them.
    svg = client.get(f"/api/jobs/{result['job_id']}/export-svg").text
    assert 'id="defects-do-not-cut"' in svg
    dxf = client.get(f"/api/jobs/{result['job_id']}/export-dxf").text
    assert dxf.count("POLYLINE\n8\nCUT_OUTER\n") == 28 and "DEFECTS" in dxf and dxf.rstrip().endswith("EOF")


def test_verifier_flags_a_part_sitting_on_a_flaw(client):
    preset = {p["id"]: p for p in client.get("/api/presets").json()}["mens_dress_shirt"]
    layout = preset["baseline_layout"]
    first = next(p for p in preset["pieces"] if p["id"] == layout[0]["id"])
    x, y = layout[0]["tx"] + first["outer"][0][0], layout[0]["ty"] + first["outer"][0][1]
    flaw = [[x - 5, y - 5], [x + 5, y - 5], [x + 5, y + 5], [x - 5, y + 5]]
    check = verify_layout(preset["pieces"], layout, preset["roll_width_mm"], 2.0, defects=[flaw])
    assert not check["valid"] and "flaw 1" in check["problems"][0]


def test_bad_defects_are_rejected(client):
    with client.websocket_connect("/ws/optimize") as ws:
        error = _run(ws, {"preset_id": "mens_dress_shirt", "defects": [{"x": 1, "y": 2}]})
    assert error["type"] == "error" and "defect" in error["message"]
