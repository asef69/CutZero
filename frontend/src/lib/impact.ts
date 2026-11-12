import type { Impact } from "../types";

// Mirrors backend/app/impact.py so the serverless engine reports identical numbers.
export function computeImpact(
  totalAreaMm2: number,
  rollWidthMm: number,
  baselineLengthMm: number,
  optimizedLengthMm: number,
  gsm: number,
  batchCount: number,
  co2Factor: number,
): Impact {
  const etaBase = baselineLengthMm ? (100 * totalAreaMm2) / (rollWidthMm * baselineLengthMm) : 0;
  const etaOpt = optimizedLengthMm ? (100 * totalAreaMm2) / (rollWidthMm * optimizedLengthMm) : 0;
  const linearSaved = (baselineLengthMm - optimizedLengthMm) / 1000;
  const areaSaved = (rollWidthMm / 1000) * linearSaved;
  const kgPerMarker = areaSaved * (gsm / 1000);
  const kgBatch = kgPerMarker * batchCount;
  return {
    baseline_utilization_pct: etaBase,
    optimized_utilization_pct: etaOpt,
    utilization_gain_pct: etaOpt - etaBase,
    linear_saved_m: linearSaved,
    linear_saved_pct: baselineLengthMm ? (100 * (baselineLengthMm - optimizedLengthMm)) / baselineLengthMm : 0,
    linear_saved_m_per_batch: linearSaved * batchCount,
    area_saved_m2: areaSaved,
    area_saved_m2_per_batch: areaSaved * batchCount,
    waste_saved_kg_per_marker: kgPerMarker,
    waste_saved_kg_per_batch: kgBatch,
    co2_saved_kg_per_batch: kgBatch * co2Factor,
    scrap_area_baseline_m2: Math.max(0, rollWidthMm * baselineLengthMm - totalAreaMm2) / 1e6,
    scrap_area_optimized_m2: Math.max(0, rollWidthMm * optimizedLengthMm - totalAreaMm2) / 1e6,
  };
}
