# Minimum Viable Product (MVP) Blueprint: CutZero
**Objective:** Build the vertical "Golden Path" slice first so that `CutZero` is 100% functional, visually compelling, and deployable before adding secondary polish features.

---

## 1. Plain-English Elevator Pitch (For Anyone)
> **The Cookie Dough Analogy:** Imagine rolling out a sheet of cookie dough and stamping out curved stars and crescent moons. If you line them up carelessly without rotating them, you waste massive gaps of dough between the shapes. With dough, you can mash the scraps back into a ball. **With fabric in a clothing factory or sheet metal in a laser shop, you cannot.** Once the blade cuts out curved sleeves and collars, the leftover trimmings between the shapes—**20% of every roll on Earth**—go straight into a landfill.
>
> **CutZero** is a high-speed C++20 math engine that plays grandmaster-level Tetris with irregular curved shapes. Using a signal-processing trick (2D Fast Fourier Transform) and Simulated Annealing, it rotates and slides curved garment and industrial parts so they lock tightly inside each other's curves—slashing roll length by 15–20% in under 3 seconds.

---

## 2. MVP Scope Matrix: What Is In vs. Out

| Component | IN THE CORE MVP (Must Ship First) | POST-MVP POLISH (Phase 4–5) | STRICTLY OUT OF SCOPE (Never Build) |
|---|---|---|---|
| **Pattern Input** | **1 Hardcoded Industrial Preset** (`Men's Dress Shirt — 28 concave/convex polygons`) with exact millimeter coordinates. | +2 presets (`Technical Jacket`, `Sheet Metal Chassis`) + Drag-and-Drop custom `.svg` file parser. | AutoCAD `.dwg`/`.dxf` binary parsers, 3D garment draping, PDF OCR extraction. |
| **C++20 Engine** | `Polygon2D`, `BaselineBoundingBoxPlacer`, `HybridFFTVectorPlacer` (`0°, 90°, 180°, 270°` rotations), and `SimulatedAnnealingSolver`. | Arbitrary `15°` rotation increments, inner polygon holes, OpenMP multi-threaded neighborhood search. | Exact CGAL algebraic curve arrangements or GPU CUDA kernels (prevents easy cloud container deployment). |
| **Python & FastAPI** | `pybind11` extension `_cutzero_core` + `GET /api/presets` + `WS /ws/optimize` real-time streaming endpoint. | PostgreSQL/SQLite run history + `GET /export-svg` + `GET /export-gcode` endpoints. | User authentication (login/signup), billing, multi-user workspaces. |
| **React Studio** | Dark-mode single-screen CAD view: **Dual-Roll HTML5 Canvas** (Top = Baseline, Bottom = Live Optimized) + **4 KPI Cards** + **"Run C++ Optimizer"** button. | Canvas zoom/pan/hover tooltips, live Simulated Annealing convergence chart, CNC toolpath animation overlay. | In-browser vector vertex drawing/editing tool. |

---

## 3. The 15-Second Judge Verification Loop ("The Golden Path")

The MVP is defined around the exact experience a hackathon judge will have during a 2-minute evaluation:

1. **Second 0–2 (Zero-Friction Load):** Judge opens the application URL. No login screen. The `"Men's Dress Shirt (28 Pieces, 1500mm Roll)"` preset is pre-loaded on the Dual-Roll Canvas.
2. **Second 2–5 (Baseline Problem Visualized):** The **Top Roll** immediately displays the industry-standard Bounding-Box First-Fit Decreasing layout (`Used Length: 2,480 mm | Utilization: 67.4%`), with translucent crimson rectangles showing wasted fabric around curved sleeves and armholes.
3. **Second 5–8 (Live C++20 WebSocket Optimization):** Judge clicks **"Run C++ FFT + SA Optimizer"**. Over the next `2.5 seconds`, the **Bottom Roll** animates smoothly at 60 FPS as the C++ engine streams improving layouts over WebSockets—sleeves flip `180°` to interlock diagonally, and collars slide inside curved necklines.
4. **Second 8–12 (Quantified Waste Proof):** The Bottom Roll locks in at `Used Length: 1,915 mm | Utilization: 87.3%`. A glowing emerald zone on the right side of the Bottom Roll highlights the **`565 mm` (`22.8%`) of fabric roll saved**, while the KPI cards display:
   - **Utilization:** `67.4% -> 87.3% (+19.9%)`
   - **Linear Fabric Saved:** `0.565 m / shirt` (`56.5 m` per 100-shirt batch)
   - **Solid Waste Diverted:** `15.25 kg` landfill scrap prevented per batch
   - **Carbon Avoided:** `231.8 kg CO2e`
5. **Second 12–15 (Real-World Feasibility):** Judge clicks **"Download Nested SVG"** or **"Export CNC G-Code"** and inspects the valid production file.

---

## 4. MVP Architecture Diagram

```text
+-------------------------------------------------------------------------+
|                    React 18 + TypeScript Frontend                       |
|  +-------------------------------------------------------------------+  |
|  | Dual-Roll HTML5 Canvas (60 FPS requestAnimationFrame)             |  |
|  | [Top Strip: Baseline FFD (Crimson Waste)]                         |  |
|  | [Bottom Strip: Live CutZero C++ Layout + Emerald Saved Zone (ΔL)] |  |
|  +-------------------------------------------------------------------+  |
|  | Live KPI Cards: Util % | ΔL Saved (m) | Scrap Saved (kg) | CO2e   |  |
|  +-------------------------------------------------------------------+  |
+------------------------------------+------------------------------------+
                                     | WebSocket (WS /ws/optimize)
                                     | JSON Progress Frames (< 5ms)
+------------------------------------v------------------------------------+
|                     FastAPI Backend (Python + uv)                       |
|  - asyncio.to_thread() worker runner                                    |
|  - Thread-safe asyncio.Queue callback bridge                            |
+------------------------------------+------------------------------------+
                                     | pybind11 (GIL Released)
+------------------------------------v------------------------------------+
|                  C++20 Optimization Core (_cutzero_core)                |
|  1. BaselineBoundingBoxPlacer (First-Fit Decreasing Shelf Packer)       |
|  2. Pre-cachedRotatedPolygons + Radix-2 2D FFT Cross-Correlation Grid   |
|  3. Exact Vector Slide-and-Lock Compaction (Binary Search -X / -Y)      |
|  4. SimulatedAnnealingSolver (Swap / Rotate / 2-Opt Sequence Moves)     |
+-------------------------------------------------------------------------+
```

---

## 5. MVP Definition of Done (Acceptance Checklist)
- [ ] `cpp_engine` compiles cleanly with CMake and `-O3 -std=c++20` into `_cutzero_core*.so`.
- [ ] Standalone C++ test bench verifies `0` polygon overlaps (`distance >= kerf_mm`) and achieves at least `+14%` higher utilization than `BaselineBoundingBoxPlacer` on the 28-piece shirt dataset in under `3 seconds`.
- [ ] FastAPI server starts via `uv run uvicorn app.main:app` and streams at least `15+` progressive improvement frames over `WS /ws/optimize` during a 200-iteration run.
- [ ] React Dual-Roll Canvas renders both strips to scale, visually highlights the saved roll region `ΔL`, and updates all 4 waste-reduction KPI cards live.