# CutZero: Arbiter Hacks V1 submission

**Track:** Theme Track, Rethinking Waste
**Repository:** https://github.com/asef69/CutZero
**Demo video:** _add the YouTube or Vimeo link here_

---

## Theme Track: the waste problem and how we measure it

CutZero targets **pre-consumer cutting-room waste**: the fabric, leather and sheet metal left between parts when a factory cuts irregular shapes from a roll or sheet. This scrap is thrown away before a product even exists, and it can't be woven or rolled back into stock. Much of it comes from simple nesting tools and manual layouts that treat every curved part as a rectangle, so the gaps around sleeves, collars and brackets become waste. We measure success on every run against an industry-style First-Fit Decreasing bounding-box layout of the same parts on the same roll with the same blade clearance, using three numbers from deterministic formulas: **material utilization** (true part area ÷ roll area used), **roll length and area saved** per lay and per batch, and **scrap mass prevented** (area saved × material weight per m²), with its embodied carbon in kg CO2e. A separate verifier that shares no code with the optimizer re-measures every layout and confirms no two parts come closer than the kerf, so a saving only counts if the layout can actually be cut. In a real factory, the same test would be the metres of roll consumed per order, and the kilograms of offcut weighed in the scrap bins, before and after switching to CutZero markers.

---

## What it does

CutZero is a nesting engine and browser studio that packs irregular 2D parts, such as shirt panels, jacket gores and sheet-metal brackets, as tightly as it can on a roll or sheet. Instead of packing bounding boxes, it fits the real shapes into each other's curves: sleeves lie head to tail, cuffs tuck into armhole curves, and small brackets drop inside a chassis's window cut-out.

Open the studio and you see two rolls drawn to scale. The top roll is the industry baseline, with every wasted bounding box shaded crimson. Press **Run** and the bottom roll comes alive as the C++ engine streams improving layouts in real time, until it locks in with a green cut-line and a hatched **saved material zone**. Live cards show utilization, metres of roll saved, kilograms of scrap prevented and kg CO2e avoided, next to a convergence chart and engine telemetry.

On the built-in benchmarks (200 iterations, 1–2 seconds each, 2 mm kerf, 100-lay batch):

| Workload | Utilization | Roll saved / 100 lays | Scrap prevented / 100 lays |
|---|---|---|---|
| Men's dress shirt, 28 pieces, 180 GSM cotton | 60.6% → **76.8%** | 70.2 m | 19.0 kg |
| Technical shell jacket, 36 pieces, 220 GSM nylon | 67.6% → **79.1%** | 40.4 m | 12.5 kg |
| Sheet-metal enclosure, 24 parts, 1 mm aluminium | 44.1% → **61.4%** | 64.8 m | 209.9 kg |

Every layout is ready to cut. You can download a true-scale nested **SVG** or **CNC G-code** (G00/G01), with interior cut-outs ordered before outlines and an animated preview of the toolpath. You can also upload your own SVG pattern. The **FFT radar** view shows every spot where a chosen part could still fit, and a **factory scale-up** panel turns one run's saving into yearly material, scrap, carbon and cost from your own assumptions.

## How we built it

- **C++20 engine (`cpp_engine/`), zero dependencies.**
  - The roll and each rotated part are rasterised, and a hand-written **Radix-2 2D real FFT** cross-correlates them. One inverse FFT tests every position on the roll at once.
  - Placing a part updates the roll's spectrum with an O(N) phase shift rather than a new forward FFT, so a full correlation takes about 0.2 ms.
  - The best pockets are re-checked on **exact 64-bit vector geometry**: winding-number containment, segment-distance clearance, and support for holes. Each part slides until it touches its neighbours at exactly the kerf distance.
  - **Simulated annealing** runs four parallel chains over placement order and rotation, with swap, rotation-flip, block-shift, 2-opt, critical-piece and jostle moves. It finishes with exact compaction and a re-seating pass.
  - A standalone test bench checks the FFT against direct summation, checks the geometry, and refuses any layout with an overlap.
- **Python bridge (`backend/`).** A **pybind11** module releases the GIL during the solve, so **FastAPI** keeps streaming WebSocket frames from the solver thread. Run history is stored in **PostgreSQL** through SQLAlchemy, falling back to SQLite. The backend also handles SVG parsing (Bezier and arc sampling, Douglas-Peucker simplification, hole detection, `defusedxml`), the SVG and G-code exporters, and an independent pure-Python verifier.
- **Studio (`frontend/`).** React 18, TypeScript, Vite and Tailwind, with a hand-written HTML5 Canvas renderer that tweens every part's position and rotation between frames. Zoom, pan, hover details, the FFT radar, interlock highlights and the toolpath animation all live on the same canvas.
- **One engine, two runtimes.** The same C++ source also compiles to a 169 KB **WebAssembly** module that runs in a Web Worker. If no server answers, the studio runs the engine in the visitor's browser, so the demo still works from a static host.
- **Shipping.** One Docker image builds the engine, runs its test bench as a build gate, builds the studio and serves everything from FastAPI. Docker Compose adds PostgreSQL.

## What we'd do next

1. **Real factory data.** Run CutZero on production markers from a partner cutting room and compare it with their current tool, not only with our bounding-box baseline. Commercial marker software beats that baseline, and the honest test is against what factories use today.
2. **Better nesting quality.** Add no-fit-polygon refinement for the final layout, finer rotation steps for metal, and common-line cutting, where neighbouring parts share one cut.
3. **Real cutting-room rules.** Fabric grain tolerance, matching stripes and plaids, flaw zones on hides and rolls, and multi-size markers built from size ratios.
4. **Remnant reuse.** Track the leftover offcut shapes and nest the next order's small parts into them, so scrap from one job becomes stock for the next.
5. **Direct machine output.** DXF export and post-processors for specific cutters (Lectra, Gerber, Zünd) and laser controllers.
