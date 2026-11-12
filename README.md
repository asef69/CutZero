# CutZero: High-Speed 2D Irregular Pattern Nesting & Scrap Prevention Engine

[![Track: Rethinking Waste](https://img.shields.io/badge/Arbiter_Hacks_V1-Theme_Track:_Rethinking_Waste-10b981?style=for-the-badge)](#)
[![Engine: C++20](https://img.shields.io/badge/Core_Engine-C++20_FFT_%2B_SA-00599C?style=for-the-badge&logo=cplusplus)](#)
[![Backend: FastAPI](https://img.shields.io/badge/Backend-FastAPI_%2B_uv-009688?style=for-the-badge&logo=fastapi)](#)
[![Frontend: React + Canvas](https://img.shields.io/badge/Studio-React_%2B_HTML5_Canvas-61DAFB?style=for-the-badge&logo=react)](#)

> **Arbiter Hacks V1, Theme Track ("Rethinking Waste"): impact and measurement statement** (full write-up: [SUBMISSION.md](SUBMISSION.md))
> Pre-consumer cutting-room scrap is fabric, leather and sheet material thrown away before a product is ever assembled. **CutZero** attacks it at the source by replacing rectangular bounding-box marker layouts with a real-time **C++20 engine** combining **2D FFT cross-correlation, exact vector compaction and simulated annealing**. Every run is measured deterministically against an industry-baseline First-Fit Decreasing (FFD) bounding-box layout of the same parts on the same roll, on three physical metrics: (1) **material utilization** `η = Σ Area(parts) / (roll width × used length)`, (2) **linear and areal roll saved** (`ΔL` in m, `ΔA` in m²), and (3) **solid scrap prevented** `ΔM = ΔA × GSM / 1000` (kg) with the **embodied carbon** it represents (kg CO2e), per production batch. A separate verifier that shares no code with the engine re-checks every layout for overlaps before the numbers are reported.

---

## 1. What is CutZero? (In plain English)

Imagine rolling out cookie dough and stamping out curved shapes. Line them up carelessly and you waste the dough between the curves. With dough you can squash the scraps back together. **With fabric in a clothing factory or aluminium in a sheet-metal shop, you can't.** Once the blade cuts out sleeves, collars and brackets, the leftover trimmings are scrap.

Simple nesting tools draw an invisible rectangular box around each curved part and pack the boxes. CutZero packs the **real shapes**, sliding sleeves head-to-tail, tucking cuffs into armhole curves and dropping small brackets inside a chassis's window cut-out:

1. **2D FFT radar scan.** The roll and every rotated part become binary grids. One Radix-2 2D FFT cross-correlation tests every position on the roll at once. A placement updates the roll's spectrum in O(N) with a phase shift, with no forward FFT at all.
2. **Exact slide-and-lock.** The best pockets are re-checked on 64-bit vector geometry. Each part slides along −X and ±Y until it touches its neighbours, stopping at exactly the blade's kerf clearance.
3. **Simulated annealing.** Four parallel chains search placement order and rotation with swap, rotation-flip, block-shift, 2-opt, critical-piece and jostle moves under a calibrated Boltzmann schedule, sharing their best layouts. Every improvement streams live over WebSockets to the browser.

---

## 2. Measured results

Industry baseline vs. CutZero, 100-lay batch, kerf 2 mm, 200 iterations, seed 42, on a 12-thread Windows laptop. Reproduce with `uv run --project backend python scripts/benchmark.py`; every row passed the independent verifier first.

| Workload | Pieces | Roll | Rotations | Baseline length | CutZero length | Utilization (`η`) | Roll saved / 100 lays | Scrap prevented | CO2e avoided | Solve |
|---|---:|---:|---|---:|---:|---|---:|---:|---:|---:|
| Men's Dress Shirt (180 GSM cotton) | 28 | 1500 mm | 0/180° (grain) | 3,325 mm | **2,623 mm** | 60.6% → **76.8%** (+16.2) | **70.2 m** (105.3 m²) | **19.0 kg** | 288 kg | 1.65 s |
| Technical Shell Jacket (220 GSM nylon) | 36 | 1400 mm | 0/180° (grain) | 2,788 mm | **2,383 mm** | 67.6% → **79.1%** (+11.5) | **40.4 m** (56.6 m²) | **12.5 kg** | 189 kg | 2.12 s |
| Sheet Metal Enclosure (1 mm aluminium) | 24 | 1200 mm | 90° steps | 2,298 mm | **1,650 mm** | 44.1% → **61.4%** (+17.3) | **64.8 m** (77.8 m²) | **209.9 kg** | 2,414 kg | 1.18 s |

With `--iterations 1000` the shirt reaches **79.9%** (+19.4 points) in about 8 s. Minimum part-to-part gap in every layout: 2.001 to 2.002 mm against a 2 mm kerf.

**With fabric flaws.** The test bench also nests the shirt around three 60 mm flaws: the baseline needs 3,991 mm (50.5%) and CutZero about 2,837 mm (71.0%), with every part at least 2.002 mm from every flaw.

**What the comparison is, and isn't.** The baseline is the best of nine First-Fit Decreasing shelf-packing variants on bounding boxes (three rotation policies × three sort orders), under the same kerf and rotation rules. It represents simple nesting and manual box-style layouts. Commercial marker software (Lectra, Gerber, SigmaNEST) will do better than this baseline, so these gains do not measure CutZero against those products. The garment presets lock rotation to 0/180°, as real cutting rooms do to respect the fabric grain.

### Engine checks (`test_bench`)

| Check | Result |
|---|---|
| FFT correlation vs. direct summation | max error 1.9 × 10⁻⁶ |
| O(N) shift-and-dilate update vs. full forward FFT | max error 1.5 × 10⁻⁵ |
| One full-strip correlation, 128 × 256 grid | 0.32 ms |
| Full 28-piece shirt decode | about 8 ms per layout |
| 200 annealing iterations (MVP target < 3 s) | 1.2 to 2.1 s |
| Overlaps in any layout | 0 |

---

## 3. Features

- **Dual-roll live comparison studio.** The top roll shows the baseline with crimson bounding boxes; the bottom roll animates the live C++ search, with an emerald cut-line and a hatched **saved material zone**.
- **Live telemetry.** Utilization, linear roll saved, scrap prevented and carbon avoided, plus a convergence chart (roll length vs. iteration) and engine stats (FFT ms, decode ms, grid, chains, canvas fps).
- **Fabric flaws.** Click either roll to mark holes, stains or slubs, or scatter sample flaws. Flaws are obstacles inside the engine: they are on the FFT sheet before any part is placed, and the exact checks, compaction and the baseline all keep a full kerf away from them.
- **FFT radar.** Click any part after a run to see every position where it fits, computed by a real FFT correlation, and hover to preview it at any spot.
- **Interlock highlights.** Amber marks where bounding boxes overlap while the parts stay clear, which a box packer can never produce.
- **CNC toolpath preview.** Animates the actual cut order: interior cut-outs before outlines, nearest-neighbour rapids.
- **Production exports.** True-scale nested `.svg`, AutoCAD R12 `.dxf` (layers `CUT_OUTER`, `CUT_INNER`, `DEFECTS`, `ROLL`, in mm) for cutting-room CAM, and `G00`/`G01` `.gcode` with cut length, rapid travel and time estimates.
- **Impact report.** One click opens a printable one-page report: both markers to scale, the savings per lay and per batch, and the verification result.
- **Custom SVG and DXF upload.** SVG paths (every command, including arcs), polygons, polylines, rects, circles and ellipses, with nested transforms and physical units, parsed with `defusedxml`. DXF `LWPOLYLINE`/`POLYLINE` with bulge arcs, `CIRCLE`, `ELLIPSE`, `BLOCK`/`INSERT` (as AAMA/ASTM pattern files use), and loose `LINE`/`ARC` segments chained into closed outlines. Rings inside rings become holes.
- **Independent verification.** A pure-Python (server) or TypeScript (browser) checker rebuilds every part from the raw input and measures clearance from scratch, to every other part and to every flaw.
- **Runs with or without a server.** The same C++ source compiles to a 175 KB WebAssembly module, so the studio still works as a static site; it falls back to WASM automatically if no server answers.
- **Scale to a factory.** Turns one run's measured saving into annual material, scrap, carbon and cost using the user's own assumptions, clearly labelled as a projection.
- **Run history** in PostgreSQL, with automatic SQLite fallback.

---

## 4. System architecture

```text
CutZero/
├── cpp_engine/                  # C++20 computational geometry & optimization engine
│   ├── CMakeLists.txt
│   ├── include/
│   │   ├── geometry.hpp         # Point2D, Polygon2D, Shoelace area, winding containment, exact clearance
│   │   ├── fft2d.hpp            # Radix-2 2D real FFT, correlation, O(N) shift-and-dilate update
│   │   ├── nfp_placer.hpp       # Baseline FFD + hybrid FFT / vector slide-and-lock placer
│   │   └── solver.hpp           # Multi-chain simulated annealing
│   ├── src/
│   │   ├── geometry.cpp  fft2d.cpp  nfp_placer.cpp  solver.cpp
│   │   ├── bindings.cpp         # pybind11 module _cutzero_core (GIL released during solve)
│   │   ├── wasm_api.cpp         # WebAssembly entry points for the browser engine
│   │   └── test_bench.cpp       # Standalone verification & benchmark runner
│   └── testdata/                # Presets exported for the test bench
├── backend/                     # FastAPI + uv + SQLAlchemy (PostgreSQL / SQLite)
│   ├── app/
│   │   ├── main.py              # REST + WS /ws/optimize, serves the built studio
│   │   ├── presets.py           # 3 parametric industrial datasets (Bezier curves, mm)
│   │   ├── svg_parser.py        # Bezier/arc sampler, Douglas-Peucker, hole detection
│   │   ├── exporter.py          # Nested SVG, R12 DXF + CNC G-code
│   │   ├── verify.py            # Independent pure-Python layout verifier (parts and flaws)
│   │   ├── impact.py            # The PRD's waste formulas
│   │   └── database.py          # Run history
│   └── tests/test_api.py
├── frontend/                    # React 18 + TypeScript + Vite + Tailwind + HTML5 Canvas
│   ├── public/cutzero_core.wasm # The engine, compiled to WebAssembly
│   └── src/
│       ├── components/          # DualRollCanvas, TelemetryBar, ControlPanel, ConvergenceChart, InsightPanels
│       ├── engine/              # Server (WebSocket) and browser (WASM worker) engine clients
│       └── lib/                 # Impact, verifier, exporters, report, flaws, browser SVG + DXF import
├── scripts/                     # build_cpp.py, benchmark.py, docker_smoke.py, make_sample_dxf.py
├── Dockerfile                   # One image: engine + studio + API
└── docker-compose.yml           # App + PostgreSQL
```

### API

| Endpoint | Purpose |
|---|---|
| `GET /api/presets` | Presets with geometry and their baseline layout |
| `POST /api/parse-svg` | Multipart `.svg` upload → normalised polygons |
| `POST /api/baseline` | FFD baseline for custom settings (optional `defects`) |
| `POST /api/radar` | One FFT correlation: free-position map for a part (optional `defects`) |
| `GET /api/jobs`, `GET /api/jobs/{id}` | Run history and aggregates |
| `GET /api/jobs/{id}/export-svg` / `export-dxf` / `export-gcode` | Production files |
| `WS /ws/optimize` | Send the PRD's `start_job` payload; receive `start`, `progress`… and `complete` frames. Send `{"type":"stop"}` to end early. Add `"defects": [{"x": 420, "y": 310, "r": 30}, [[x, y], …]]` (circles or polygons in mm) to nest around flaws. |

---

## 5. Quick start

### Option A: Docker (recommended for judges)

```bash
docker compose up --build
```

Open `http://localhost:8000` for the studio; API docs are at `http://localhost:8000/docs`. The image build runs the engine's test bench and refuses to finish if any layout overlaps or the shirt gains less than 14 points.

### Option B: manual setup (`uv` + Node)

Build the engine. It uses CMake with g++ ≥ 10 or clang++ ≥ 12 when present, otherwise the `ziglang` toolchain installed by `uv sync`, so Windows needs no compiler:

```bash
cd backend
uv sync
uv run python ../scripts/build_cpp.py --wasm
```

Run the engine's verification bench (still from `backend/`):

```bash
../cpp_engine/build/test_bench --dir ../cpp_engine/testdata
```

Start the API (from `backend/`):

```bash
uv run uvicorn app.main:app --reload --port 8000
```

Start the studio (from `frontend/`):

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`. Run the API tests with `uv run pytest` from `backend/`.

### Option C: static, serverless

`frontend/` deploys as a static site, for example on Vercel. With no server configured, the studio runs the WebAssembly build of the engine in the visitor's browser: one chain instead of four, so a run takes a few seconds longer. Point `VITE_API_URL` at a running backend to use the native engine instead. Append `?engine=wasm` to force the browser engine, or `?autorun=1` to start a run on load.

---

## 6. Assumptions and limits

- Carbon factors are the project's stated values: 15.2 kg CO2e/kg for woven textiles and 11.5 kg CO2e/kg for sheet aluminium.
- "Scrap prevented" is the roll no longer consumed per lay, multiplied by the batch size. It assumes the saved length would otherwise have become offcut.
- Presets are parametric approximations of real patterns, built to be realistic in shape and size, not copies of any brand's patterns.
- Parts are placed with whole-polygon kerf clearance. Common-line cutting and grain tolerance are out of scope. Fabric flaws are marked by hand (circles or polygons); reading them from roll-inspection cameras is not built.
