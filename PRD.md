# Product Requirements Document (PRD): CutZero
**Project Name:** CutZero — High-Speed 2D Irregular Pattern Nesting & Pre-Consumer Scrap Prevention Engine  
**Competition:** Arbiter Hacks V1 (Deadline: December 20, 2026 @ 9:00 PM PST)  
**Target Track:** Theme Track — *Rethinking Waste*  
**Architecture Stack:** C++20 (`pybind11` + CMake), Python 3.12 (`FastAPI` + `uv`), PostgreSQL (`SQLAlchemy`), React 18 + TypeScript + Vite + Tailwind CSS + HTML5 Canvas  

---

## 1. Executive Summary
Pre-consumer cutting-room waste ("marker fallout") accounts for **15% to 25% of all raw fabric, leather, composite, and sheet-metal material consumed** in global manufacturing. Because garment patterns and industrial parts are irregular, concave 2D polygons, basic nesting tools wrap shapes in rectangular bounding boxes—leaving massive dead-air gaps that are shredded or landfilled before a single product is assembled.

**CutZero** is a full-stack computational geometry and combinatorial optimization platform that eliminates pre-consumer cutting waste at the source. Powered by a custom **C++20 engine** combining **2D Radix-2 Fast Fourier Transform (FFT) Cross-Correlation**, **Exact Vector Slide-and-Lock Compaction**, and **Simulated Annealing**, CutZero nests irregular 2D polygons directly inside each other's concave pockets and streams 60 FPS visual telemetry over WebSockets to an interactive browser CAD studio.

---

## 2. Problem Statement & Rubric Alignment

### 2.1 The Industrial Waste Bottleneck
1. **Geometric Complexity (NP-Hard):** The 2D Irregular Strip Packing Problem requires simultaneously choosing the placement sequence of `N` polygons, their rotation angles `theta`, and continuous `(x, y)` coordinates on a fixed-width roll `W` such that total used roll length `L` is minimized and zero polygons intersect.
2. **Prohibitive Commercial Lock-In:** Enterprise CAD marker-making suites (Lectra, Gerber, SigmaNEST) cost $15,000–$35,000/year per seat. Small-to-medium garment factories, sheet-metal shops, and hardware makers fall back on manual mouse placement or naive First-Fit Decreasing (FFD) bounding-box layouts.
3. **Irreversible Source Waste:** Unlike post-consumer recycling, pre-consumer cutting scrap consists of thousands of millimeter-thin irregular trimmings that cannot be re-woven or re-rolled. Every 1% gain in nesting utilization directly prevents raw material extraction, dyeing, and landfill disposal.

### 2.2 Arbiter Hacks V1 Theme Track Rubric Mapping
| Criterion | Weight | CutZero Engineering Delivery |
|---|---|---|
| **Impact on Waste Problem** | **35%** | Directly attacks pre-consumer industrial scrap. Computes deterministic A/B physical waste metrics (`m²` material saved, `kg` landfill scrap prevented, `kg CO2e` avoided) against an industry-baseline FFD bounding-box layout on the same screen. |
| **Technical Execution** | **25%** | Zero-dependency C++20 Radix-2 2D FFT convolution engine + exact polygon intersection & vector compaction + Simulated Annealing, bridged to FastAPI via `pybind11` with GIL-released multi-threading. |
| **Feasibility** | **20%** | Accepts real SVG CAD markers and outputs production-ready nested `.svg` cutting layouts and standard CNC/laser `.gcode` (`G00`/`G01`) toolpaths. |
| **Presentation & Demo Clarity** | **20%** | Dual-Roll 60 FPS HTML5 Canvas where judges visually compare the crimson wasted bounding boxes on the Top Roll against tightly interlocked polygons on the Bottom Roll in under 5 seconds. |

---

## 3. User Personas
1. **Apparel Marker Planner (Garment Factory):** Uploads a 28-piece shirt or 36-piece jacket marker onto a `1500 mm` wide cotton/nylon roll, locks grainline rotations to `0° / 180°`, sets `2 mm` blade kerf spacing, and exports a nested marker that saves `0.50+ meters` of fabric per garment.
2. **CNC Laser / Sheet-Metal Fabrication Engineer:** Selects a 24-piece aluminum chassis preset on a `1200 mm` sheet, enables `0° / 90° / 180° / 270°` (or `15°` step) rotations, and exports a ready-to-cut `.gcode` file.
3. **Sustainability Auditor / Hackathon Judge:** Launches the live web URL without login, clicks one button to run a live benchmark, inspects real-time convergence charts and waste-saved telemetry, and verifies deterministic waste prevention.

---

## 4. Deterministic Mathematical & Waste Formulas

Every optimization run evaluates and logs the following exact physical quantities:

1. **Exact Polygon Area (Shoelace Formula):**
   For each closed counter-clockwise polygon `P` with vertices `(x_0, y_0), ..., (x_{k-1}, y_{k-1})`:
   `Area(P) = 0.5 * |Sum_{i=0..k-1} (x_i * y_{i+1} - x_{i+1} * y_i)|` (in `mm²`)
   Total true part area: `A_total = Sum_{p=1..N} Area(P_p)` (converted to `m²` via `A_total / 1,000,000`).

2. **Material Utilization Efficiency (`η`):**
   - Baseline Utilization: `η_base = (A_total / (W * L_base)) * 100%`
   - Optimized Utilization: `η_opt = (A_total / (W * L_opt)) * 100%`
   - Efficiency Gain: `Δη = η_opt - η_base`

3. **Linear & Areal Material Saved:**
   - Linear Roll Saved: `ΔL = (L_base - L_opt) / 1000.0` (in meters)
   - Sheet Area Saved: `ΔA = (W / 1000.0) * ΔL` (in `m²`)

4. **Prevented Solid Waste Mass (`ΔM_waste`):**
   `ΔM_waste = ΔA * (ρ_GSM / 1000.0) * Batch_Multiplier` (in `kg`)
   where `ρ_GSM` is material areal density in grams per square meter (e.g., `180 GSM` cotton shirting, `220 GSM` ripstop nylon, `2700 GSM` 1mm aluminum sheet).

5. **Avoided Lifecycle Carbon Emissions (`ΔCO2e`):**
   `ΔCO2e = ΔM_waste * EF_material` (in `kg CO2e`)
   where `EF_material` is the embodied carbon factor (`15.2 kg CO2e/kg` for woven textiles; `11.5 kg CO2e/kg` for sheet aluminum).

---

## 5. Functional Requirements (FR)

### 5.1 Input & Geometry Pre-Processing
- **FR-1 (Built-In Industrial Presets — P0):** Include 3 mathematically rich industrial presets out of the box:
  1. `mens_dress_shirt`: 28 concave/convex pieces (front panels with curved armholes, back yoke, bodice, tapered sleeves, collar stands, cuffs) on a `1500 mm` roll (`180 GSM`).
  2. `technical_shell_jacket`: 36 irregular articulated gore, hood, and storm-flap panels on a `1400 mm` roll (`220 GSM`).
  3. `sheet_metal_enclosure`: 24 L-brackets, U-frames, and fan-cutout plates on a `1200 mm` sheet (`2700 GSM`).
- **FR-2 (Custom SVG Parser & Curve Flattener — P0):** Parse uploaded `.svg` files (`<path>`, `<polygon>`, `<polyline>`, `<rect>`), sample cubic/quadratic Bézier curves into discrete vertex loops, apply Douglas-Peucker simplification (`epsilon = 0.25 mm`, targeting `30–80` vertices per polygon), and enforce counter-clockwise winding.

### 5.2 C++20 Core Optimization Engine (`_cutzero_core`)
- **FR-3 (Industry Baseline FFD Placer — P0):** Implement `BaselineBoundingBoxPlacer` in C++20 using First-Fit Decreasing (FFD) shelf/skyline rectangular bounding-box packing to establish `L_base` and `η_base`.
- **FR-4 (2D Radix-2 FFT Cross-Correlation Overlap Engine — P0):** Discretize the active strip and rotated candidate polygon onto binary grids (`cell_size = 2.0 mm` to `4.0 mm`). Execute 2D FFT Cross-Correlation (`IFFT2D(FFT2D(Sheet) * FFT2D(Piece_Reversed))`) in `O(N log N)` time to identify collision-free bottom-left `(x, y)` pocket candidates across the entire roll in under `3 ms`.
- **FR-5 (Exact Vector Slide-and-Lock Compaction — P0):** Refine the top FFT pocket candidates using exact 64-bit floating-point segment-segment intersection and Point-in-Polygon checks, binary-searching along `-X` and `-Y` axes so polygons nest flush inside concave curves while strictly respecting minimum `kerf_mm` clearance.
- **FR-6 (Simulated Annealing Metaheuristic Loop — P0):** Search over piece placement permutations and allowed rotation angles using swap, rotation-flip, block-shift, and 2-opt sequence reversal moves under an adaptive Boltzmann cooling schedule (`T_{k+1} = alpha * T_k`). Emit every improved layout state via a GIL-released `pybind11` callback.

### 5.3 Backend API, Persistence & Export (`FastAPI` + `PostgreSQL`)
- **FR-7 (Real-Time WebSocket Optimizer Stream — P0):** Expose `WS /ws/optimize` to stream live iteration progress frames (`iteration`, `temperature`, `optimized_length_mm`, `optimized_utilization_pct`, `waste_mass_saved_kg`, `placed_pieces`) at low latency.
- **FR-8 (Production SVG & CNC G-Code Exporter — P1):** Expose `GET /api/jobs/{job_id}/export-svg` and `GET /api/jobs/{job_id}/export-gcode` to download nested vector cutting layouts and `G00`/`G01` CNC laser toolpaths.
- **FR-9 (PostgreSQL Telemetry & Run History — P1):** Persist completed benchmark runs and aggregate waste-saved statistics in PostgreSQL via SQLAlchemy (with automatic SQLite fallback if `DATABASE_URL` is unset).

### 5.4 Frontend Interactive CAD Studio (`React` + `HTML5 Canvas`)
- **FR-10 (Dual-Roll 60 FPS Comparison Canvas — P0):** Render a synchronized split-screen HTML5 Canvas:
  - **Top Strip:** Industry Baseline (Bounding-Box FFD) with translucent crimson bounding boxes highlighting wasted space and a cut-line marker at `L_base`.
  - **Bottom Strip:** Live CutZero C++20 layout with color-coded polygons, concave nesting highlights, a glowing emerald cut-line at `L_opt`, and a shaded **"SAVED MATERIAL ZONE (`ΔL`)"** between `L_opt` and `L_base`.
- **FR-11 (Live Telemetry KPI Bar & Convergence Chart — P0):** Display real-time metric cards (`Utilization %`, `Linear Roll Saved (m)`, `Solid Waste Prevented (kg)`, `Carbon Avoided (kg CO2e)`) and a live Simulated Annealing convergence curve (`Roll Length vs. Iteration`).

---

## 6. Non-Functional Requirements (NFR)
- **NFR-1 (C++ Throughput):** Full placement evaluation of a 28-piece garment marker must complete in `< 15 ms` on a single core (`-O3 -std=c++20`), completing `200` Simulated Annealing iterations in `< 3.0 seconds`.
- **NFR-2 (Geometric Validity Guarantee):** Zero polygon-polygon or polygon-boundary overlaps (`distance >= kerf_mm`) verified by an automated post-placement assertion check.
- **NFR-3 (Zero-Friction Judge Evaluation):** No authentication wall. Judges must be able to open the URL and trigger a live C++ optimization run within `3 seconds` of page load.

---

## 7. API & WebSocket Specification

### 7.1 REST Endpoints
- `GET /api/presets` — Returns metadata and initial polygon geometry for all built-in industrial presets.
- `POST /api/parse-svg` — Accepts `multipart/form-data` `.svg` upload; returns normalized `Polygon2D[]` JSON.
- `GET /api/jobs` — Lists historical optimization runs stored in PostgreSQL/SQLite.
- `GET /api/jobs/{job_id}/export-svg` — Returns downloadable `image/svg+xml` nested marker.
- `GET /api/jobs/{job_id}/export-gcode` — Returns downloadable `text/plain` CNC `.gcode` file.

### 7.2 WebSocket Protocol (`WS /ws/optimize`)
**Client -> Server (`start_job` payload):**
```json
{
  "preset_id": "mens_dress_shirt",
  "roll_width_mm": 1500.0,
  "kerf_mm": 2.0,
  "fabric_gsm": 180.0,
  "batch_Count": 100,
  "allowed_rotations_deg": [0, 90, 180, 270],
  "max_iterations": 200
}
```

**Server -> Client (`progress` / `complete` frame):**
```json
{
  "type": "progress",
  "iteration": 84,
  "max_iterations": 200,
  "temperature": 14.2,
  "elapsed_ms": 940.5,
  "roll_width_mm": 1500.0,
  "baseline_length_mm": 2480.0,
  "optimized_length_mm": 1915.0,
  "baseline_utilization_pct": 67.4,
  "optimized_utilization_pct": 87.3,
  "linear_saved_m": 0.565,
  "waste_saved_kg_per_batch": 15.25,
  "co2_saved_kg_per_batch": 231.8,
  "baseline_layout": [...],
  "optimized_layout": [...]
}
```

---

## 8. Technical Risks & Mitigations
| Risk | Impact | Mitigation Strategy |
|---|---|---|
| **Floating-point colinearity bugs in exact Minkowski NFP** | High (crashes or infinite loops on degenerate SVG edges) | Use **Hybrid 2D FFT Raster + Binary-Search Vector Sliding** instead of fragile symbolic Minkowski orbital construction. Always stable and deterministic. |
| **Python GIL blocking WebSocket frames during C++ solve** | High (UI freezes until solve finishes) | Use `py::gil_scoped_release` on `solve()`, run solver via `asyncio.to_thread()`, and push progress frames into an `asyncio.Queue` via `loop.call_soon_threadsafe()`. |
| **Raster grid size exceeding power-of-2 FFT bounds** | Medium | Automatically pad grid dimensions `(W_grid, L_grid)` to the next power of 2 (`512x1024`) and cache forward FFTs of rotated candidate polygons at job start. |