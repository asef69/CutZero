"""The PRD's deterministic waste formulas. No estimation, no randomness."""

from __future__ import annotations

from typing import Any

# Embodied-carbon factors from the PRD, kg CO2e per kg of material.
CO2_FACTOR_TEXTILE = 15.2
CO2_FACTOR_ALUMINIUM = 11.5


def compute_impact(
    total_area_mm2: float,
    roll_width_mm: float,
    baseline_length_mm: float,
    optimized_length_mm: float,
    fabric_gsm: float,
    batch_count: int,
    co2_factor: float,
) -> dict[str, Any]:
    eta_base = 100.0 * total_area_mm2 / (roll_width_mm * baseline_length_mm) if baseline_length_mm else 0.0
    eta_opt = 100.0 * total_area_mm2 / (roll_width_mm * optimized_length_mm) if optimized_length_mm else 0.0

    linear_saved_m = (baseline_length_mm - optimized_length_mm) / 1000.0
    area_saved_m2 = (roll_width_mm / 1000.0) * linear_saved_m
    kg_saved_per_marker = area_saved_m2 * (fabric_gsm / 1000.0)
    kg_saved_batch = kg_saved_per_marker * batch_count
    co2_saved_batch = kg_saved_batch * co2_factor

    scrap_area_base = max(0.0, roll_width_mm * baseline_length_mm - total_area_mm2) / 1e6
    scrap_area_opt = max(0.0, roll_width_mm * optimized_length_mm - total_area_mm2) / 1e6

    return {
        "baseline_utilization_pct": eta_base,
        "optimized_utilization_pct": eta_opt,
        "utilization_gain_pct": eta_opt - eta_base,
        "linear_saved_m": linear_saved_m,
        "linear_saved_pct": 100.0 * (baseline_length_mm - optimized_length_mm) / baseline_length_mm
        if baseline_length_mm
        else 0.0,
        "linear_saved_m_per_batch": linear_saved_m * batch_count,
        "area_saved_m2": area_saved_m2,
        "area_saved_m2_per_batch": area_saved_m2 * batch_count,
        "waste_saved_kg_per_marker": kg_saved_per_marker,
        "waste_saved_kg_per_batch": kg_saved_batch,
        "co2_saved_kg_per_batch": co2_saved_batch,
        "scrap_area_baseline_m2": scrap_area_base,
        "scrap_area_optimized_m2": scrap_area_opt,
    }
