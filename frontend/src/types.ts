export type Pt = [number, number];

export interface Piece {
  id: number;
  name: string;
  outer: Pt[];
  holes: Pt[][];
  area_mm2: number;
}

export interface Placement {
  id: number;
  rotation_deg: number;
  tx: number;
  ty: number;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  category: "textile" | "metal" | "custom";
  material: string;
  roll_width_mm: number;
  fabric_gsm: number;
  co2_factor_kg_per_kg: number;
  default_rotations_deg: number[];
  default_kerf_mm: number;
  default_batch_count: number;
  piece_count: number;
  total_area_m2: number;
  pieces: Piece[];
  baseline_length_mm?: number;
  baseline_layout?: Placement[];
}

export interface Impact {
  baseline_utilization_pct: number;
  optimized_utilization_pct: number;
  utilization_gain_pct: number;
  linear_saved_m: number;
  linear_saved_pct: number;
  linear_saved_m_per_batch: number;
  area_saved_m2: number;
  area_saved_m2_per_batch: number;
  waste_saved_kg_per_marker: number;
  waste_saved_kg_per_batch: number;
  co2_saved_kg_per_batch: number;
  scrap_area_baseline_m2: number;
  scrap_area_optimized_m2: number;
}

export interface Verification {
  valid: boolean;
  verifier: string;
  pieces_checked: number;
  pairs_checked: number;
  min_clearance_mm: number | null;
  kerf_mm: number;
  problems: string[];
}

export interface EngineStats {
  evaluations: number;
  accepted_moves: number;
  ffts: number;
  placements: number;
  avg_fft_ms: number;
  avg_eval_ms: number;
  solve_ms: number;
  threads: number;
  grid_rows: number;
  grid_cols: number;
  cell_mm: number;
  frames: number;
  cancelled: boolean;
}

export interface EngineValidation {
  valid: boolean;
  violations: number;
  min_clearance_mm: number;
  pairs_checked: number;
  interlocks: number;
}

export interface ProgressFrame extends Impact {
  type: "progress";
  phase: "seed" | "anneal" | "polish";
  iteration: number;
  max_iterations: number;
  temperature: number;
  elapsed_ms: number;
  roll_width_mm: number;
  baseline_length_mm: number;
  optimized_length_mm: number;
  current_length_mm: number;
  evaluations: number;
  accepted_moves: number;
  improved: boolean;
  baseline_layout: Placement[];
  optimized_layout: Placement[];
}

export interface CompleteFrame extends Impact {
  type: "complete";
  job_id: string | null;
  iteration: number;
  max_iterations: number;
  elapsed_ms: number;
  roll_width_mm: number;
  baseline_length_mm: number;
  optimized_length_mm: number;
  baseline_layout: Placement[];
  optimized_layout: Placement[];
  engine_validation: EngineValidation;
  verification: Verification;
  stats: EngineStats;
  cancelled: boolean;
}

export interface JobRequest {
  name: string;
  preset_id: string | null;
  pieces: Piece[];
  roll_width_mm: number;
  kerf_mm: number;
  fabric_gsm: number;
  batch_count: number;
  co2_factor_kg_per_kg: number;
  allowed_rotations_deg: number[];
  max_iterations: number;
  seed: number;
}

export interface RadarResult {
  rows: number;
  cols: number;
  cell_mm: number;
  margin: number;
  fft_ms: number;
  piece_w: number;
  piece_h: number;
  free: Uint8Array;
}

export interface JobSummary {
  id: string;
  name: string;
  created_at: string;
  piece_count: number;
  baseline_utilization_pct: number;
  optimized_utilization_pct: number;
  linear_saved_m: number;
  waste_saved_kg_per_batch: number;
  co2_saved_kg_per_batch: number;
  solve_ms: number;
  verified: boolean;
}

export interface JobHistory {
  jobs: JobSummary[];
  aggregate: {
    runs: number;
    waste_saved_kg: number;
    co2_saved_kg: number;
    avg_utilization_gain_pct: number;
    backend: string;
  };
}
