// wasm_api.cpp - WebAssembly entry points for the same engine that pybind11 exposes.
//
// All data crosses the boundary as flat arrays of doubles, read and written by
// frontend/src/engine/wasmWorker.ts. That avoids any JSON or string handling in here.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#include "nfp_placer.hpp"
#include "solver.hpp"

using namespace cutzero;

extern "C" {
// Provided by the worker: receives a frame as `count` doubles at `data`.
__attribute__((import_module("env"), import_name("cz_frame"))) int cz_frame(const double* data, int count);
}

namespace {

std::vector<double> g_output;

struct Reader {
    const double* p;
    double next() { return *p++; }
    int next_int() { return static_cast<int>(*p++); }
};

void push_layout(const NestingProblem& problem, const Layout& layout, std::vector<double>& out) {
    out.push_back(layout.length_mm);
    out.push_back(static_cast<double>(layout.placed.size()));
    for (const PlacedPiece& p : layout.placed) {
        out.push_back(p.piece_index);
        out.push_back(p.rotation_deg);
        out.push_back(p.tx);
        out.push_back(p.ty);
    }
    (void)problem;
}

void push_validation(const ValidationReport& v, std::vector<double>& out) {
    out.push_back(v.valid ? 1 : 0);
    out.push_back(v.violations);
    out.push_back(v.min_clearance_mm);
    out.push_back(v.pairs_checked);
    out.push_back(v.interlocks);
}

// Layout: [roll, kerf, iterations, seed, time_limit_ms, n_rot, rot..., n_pieces,
//          (n_rings, (n_vertices, x, y, ...)...)...]
SolverConfig read_problem(Reader& r, std::vector<Piece>& pieces) {
    SolverConfig cfg;
    cfg.roll_width_mm = r.next();
    cfg.kerf_mm = r.next();
    cfg.max_iterations = r.next_int();
    cfg.seed = static_cast<unsigned long long>(r.next());
    cfg.time_limit_ms = r.next();
    cfg.threads = 1;
    const int rotations = r.next_int();
    cfg.allowed_rotations_deg.clear();
    for (int i = 0; i < rotations; ++i) cfg.allowed_rotations_deg.push_back(r.next());
    const int count = r.next_int();
    pieces.resize(count);
    for (int i = 0; i < count; ++i) {
        pieces[i].id = i;
        pieces[i].name = "piece";
        const int rings = r.next_int();
        for (int k = 0; k < rings; ++k) {
            const int vertices = r.next_int();
            Ring ring(vertices);
            for (Point2D& v : ring) {
                v.x = r.next();
                v.y = r.next();
            }
            if (k == 0) {
                pieces[i].polygon.outer = std::move(ring);
            } else {
                pieces[i].polygon.holes.push_back(std::move(ring));
            }
        }
    }
    return cfg;
}

}  // namespace

extern "C" {

__attribute__((export_name("cz_alloc"))) double* cz_alloc(int doubles) {
    return static_cast<double*>(std::malloc(sizeof(double) * doubles));
}

__attribute__((export_name("cz_free"))) void cz_free(double* ptr) { std::free(ptr); }

__attribute__((export_name("cz_output"))) const double* cz_output() { return g_output.data(); }

__attribute__((export_name("cz_output_size"))) int cz_output_size() { return static_cast<int>(g_output.size()); }

// Returns 0 on success. Output: baseline layout, optimized layout, validations, stats.
// A piece that cannot fit on the roll returns 1.
__attribute__((export_name("cz_solve"))) int cz_solve(const double* input) {
    Reader reader{input};
    std::vector<Piece> pieces;
    const SolverConfig cfg = read_problem(reader, pieces);
    NestingProblem problem(std::move(pieces), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) return 1;

    std::vector<double> frame;
    const ProgressCallback bridge = [&](const ProgressFrame& f) -> bool {
        frame.clear();
        frame.push_back(f.phase == "seed" ? 0 : (f.phase == "anneal" ? 1 : 2));
        frame.push_back(f.iteration);
        frame.push_back(f.max_iterations);
        frame.push_back(f.temperature);
        frame.push_back(f.elapsed_ms);
        frame.push_back(f.current_length_mm);
        frame.push_back(static_cast<double>(f.evaluations));
        frame.push_back(static_cast<double>(f.accepted_moves));
        frame.push_back(f.improved ? 1 : 0);
        push_layout(problem, f.layout, frame);
        return cz_frame(frame.data(), static_cast<int>(frame.size())) != 0;
    };

    const SolveResult r = SimulatedAnnealingSolver(cfg).solve(problem, bridge);

    g_output.clear();
    g_output.push_back(problem.total_area_mm2());
    push_layout(problem, r.baseline, g_output);
    push_layout(problem, r.optimized, g_output);
    push_validation(r.baseline_validation, g_output);
    push_validation(r.optimized_validation, g_output);
    const SolveStats& s = r.stats;
    for (const double v : {static_cast<double>(s.evaluations), static_cast<double>(s.accepted_moves),
                           static_cast<double>(s.ffts), static_cast<double>(s.placements), s.avg_fft_ms, s.avg_eval_ms,
                           s.solve_ms, static_cast<double>(s.threads), static_cast<double>(s.grid_rows),
                           static_cast<double>(s.grid_cols), s.cell_mm, static_cast<double>(s.frames),
                           s.cancelled ? 1.0 : 0.0}) {
        g_output.push_back(v);
    }
    return 0;
}

__attribute__((export_name("cz_baseline"))) int cz_baseline(const double* input) {
    Reader reader{input};
    std::vector<Piece> pieces;
    const SolverConfig cfg = read_problem(reader, pieces);
    NestingProblem problem(std::move(pieces), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) return 1;
    const Layout layout = BaselineBoundingBoxPlacer::place(problem);
    g_output.clear();
    g_output.push_back(problem.total_area_mm2());
    push_layout(problem, layout, g_output);
    return 0;
}

// Input: problem, then [n_placed, (piece_index, rotation_deg, tx, ty)..., piece_index, rotation_deg].
// Output: [rows, cols, cell_mm, margin, fft_ms, piece_w, piece_h, free flags...].
__attribute__((export_name("cz_radar"))) int cz_radar(const double* input) {
    Reader reader{input};
    std::vector<Piece> pieces;
    const SolverConfig cfg = read_problem(reader, pieces);
    NestingProblem problem(std::move(pieces), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) return 1;
    const auto& parts = problem.pieces();

    auto rotation_index = [&](int piece, double deg) {
        const auto& rots = parts[piece].rotations;
        for (int r = 0; r < static_cast<int>(rots.size()); ++r) {
            if (std::fabs(rots[r].rotation_deg - deg) < 1e-6) return r;
        }
        return -1;
    };

    const int n_placed = reader.next_int();
    struct Raw { int piece; double deg, tx, ty; };
    std::vector<Raw> raw(n_placed);
    for (Raw& item : raw) {
        item.piece = reader.next_int();
        item.deg = reader.next();
        item.tx = reader.next();
        item.ty = reader.next();
    }
    const int piece = reader.next_int();
    const double piece_deg = reader.next();
    const int rot = rotation_index(piece, piece_deg);
    if (rot < 0) return 2;

    std::vector<PlacedPiece> placed;
    double extent = 0.0;
    for (const Raw& item : raw) {
        if (item.piece == piece) continue;
        const int r = rotation_index(item.piece, item.deg);
        if (r < 0) return 2;
        const PreparedShape& s = parts[item.piece].rotations[r];
        const double x = item.tx - s.norm_x;
        const double y = item.ty - s.norm_y;
        placed.push_back(problem.make_placed(item.piece, r, x, y));
        extent = std::max(extent, x + s.w);
    }

    const int rows = std::clamp(next_power_of_two(static_cast<int>(std::ceil(cfg.roll_width_mm / 6.0))), 32, 256);
    FFTGrid grid(problem, rows, extent + 400.0);
    for (const PlacedPiece& q : placed) grid.ensure(q.piece_index, q.rotation_index);
    grid.ensure(piece, rot);

    HybridFFTVectorPlacer placer(problem, grid);
    std::vector<float> map;
    const auto t0 = std::chrono::steady_clock::now();
    placer.correlation_map(placed, piece, rot, map);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    const FFTGrid::Entry& e = grid.entry(piece, rot);
    const PreparedShape& s = parts[piece].rotations[rot];
    const int cols = grid.cols();
    g_output.clear();
    g_output.reserve(7 + static_cast<std::size_t>(grid.rows()) * cols);
    for (const double v : {static_cast<double>(grid.rows()), static_cast<double>(cols), grid.cell_mm(),
                           static_cast<double>(grid.margin()), ms, s.w, s.h}) {
        g_output.push_back(v);
    }
    for (int dy = 0; dy < grid.rows(); ++dy) {
        const double y = (dy + grid.margin()) * grid.cell_mm();
        const bool row_ok = dy + e.raster_rows <= grid.rows() && y + s.h <= problem.roll_width() - problem.kerf();
        for (int dx = 0; dx < cols; ++dx) {
            const bool ok = row_ok && dx + e.raster_cols <= cols &&
                            map[static_cast<std::size_t>(dy) * cols + dx] < 0.5f;
            g_output.push_back(ok ? 1.0 : 0.0);
        }
    }
    return 0;
}

}  // extern "C"
