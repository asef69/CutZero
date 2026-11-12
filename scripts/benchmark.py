#!/usr/bin/env python3
"""Reproduces the README benchmark table with the compiled engine.

    uv run --project backend python scripts/benchmark.py [--iterations 200] [--seed 42]

Every layout is checked by the independent verifier before its numbers are printed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app import _cutzero_core as core  # noqa: E402
from app.impact import compute_impact  # noqa: E402
from app.presets import all_presets  # noqa: E402
from app.verify import verify_layout  # noqa: E402


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Arrows and degree signs on Windows consoles too.
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--batch", type=int, default=100)
    args = parser.parse_args()

    print(
        "| Workload | Pieces | Roll | Rotations | Baseline length | CutZero length | Utilization | "
        f"Roll saved / {args.batch} lays | Scrap prevented | CO2e avoided | Solve | Min gap |"
    )
    print("|---|---:|---:|---|---:|---:|---|---:|---:|---:|---:|---:|")
    for preset in all_presets().values():
        rotations = [float(r) for r in preset["default_rotations_deg"]]
        cfg = {
            "roll_width_mm": preset["roll_width_mm"],
            "kerf_mm": preset["default_kerf_mm"],
            "allowed_rotations_deg": rotations,
            "max_iterations": args.iterations,
            "seed": args.seed,
            "threads": args.threads,
        }
        result = core.solve(preset["pieces"], cfg)
        layout = [
            {"id": p["id"], "rotation_deg": p["rotation_deg"], "tx": round(p["tx"], 3), "ty": round(p["ty"], 3)}
            for p in result["optimized_layout"]
        ]
        check = verify_layout(preset["pieces"], layout, preset["roll_width_mm"], preset["default_kerf_mm"])
        if not check["valid"]:
            raise SystemExit(f"{preset['id']}: verification failed: {check['problems']}")
        impact = compute_impact(
            result["total_area_mm2"],
            preset["roll_width_mm"],
            result["baseline_length_mm"],
            result["optimized_length_mm"],
            preset["fabric_gsm"],
            args.batch,
            preset["co2_factor_kg_per_kg"],
        )
        rot = "0/180°" if rotations == [0.0, 180.0] else "90° steps" if len(rotations) == 4 else f"{len(rotations)} angles"
        stats = result["stats"]
        print(
            f"| {preset['name']} | {preset['piece_count']} | {preset['roll_width_mm']:.0f} mm | {rot} "
            f"| {result['baseline_length_mm']:,.0f} mm | **{result['optimized_length_mm']:,.0f} mm** "
            f"| {impact['baseline_utilization_pct']:.1f}% → **{impact['optimized_utilization_pct']:.1f}%** "
            f"(+{impact['utilization_gain_pct']:.1f}) "
            f"| {impact['linear_saved_m_per_batch']:.1f} m ({impact['area_saved_m2_per_batch']:.1f} m²) "
            f"| {impact['waste_saved_kg_per_batch']:.1f} kg | {impact['co2_saved_kg_per_batch']:,.0f} kg "
            f"| {stats['solve_ms'] / 1000:.2f} s | {check['min_clearance_mm']:.3f} mm |"
        )


if __name__ == "__main__":
    main()
