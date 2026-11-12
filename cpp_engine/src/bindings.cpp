// bindings.cpp - pybind11 module `_cutzero_core`.
//
// The solver runs with the GIL released so the FastAPI event loop keeps serving WebSocket
// frames during a solve. The GIL is re-acquired only for the moment a progress frame is
// handed to Python.
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

#include "nfp_placer.hpp"
#include "solver.hpp"

namespace py = pybind11;
using namespace cutzero;

namespace {

Ring to_ring(const py::handle& seq) {
    Ring ring;
    for (const py::handle& point : seq) {
        auto xy = point.cast<py::sequence>();
        ring.push_back({xy[0].cast<double>(), xy[1].cast<double>()});
    }
    return ring;
}

std::vector<Piece> to_pieces(const py::list& items) {
    std::vector<Piece> pieces;
    pieces.reserve(items.size());
    int index = 0;
    for (const py::handle& item : items) {
        auto dict = item.cast<py::dict>();
        Piece piece;
        piece.id = dict.contains("id") ? dict["id"].cast<int>() : index;
        piece.name = dict.contains("name") ? dict["name"].cast<std::string>() : "piece_" + std::to_string(index);
        piece.polygon.outer = to_ring(dict["outer"]);
        if (piece.polygon.outer.size() < 3) throw std::invalid_argument("Piece '" + piece.name + "' has fewer than 3 vertices.");
        if (dict.contains("holes")) {
            for (const py::handle& hole : dict["holes"]) piece.polygon.holes.push_back(to_ring(hole));
        }
        pieces.push_back(std::move(piece));
        ++index;
    }
    return pieces;
}

SolverConfig to_config(const py::dict& cfg) {
    SolverConfig c;
    c.roll_width_mm = cfg["roll_width_mm"].cast<double>();
    c.kerf_mm = cfg.contains("kerf_mm") ? cfg["kerf_mm"].cast<double>() : 2.0;
    if (cfg.contains("allowed_rotations_deg")) {
        c.allowed_rotations_deg = cfg["allowed_rotations_deg"].cast<std::vector<double>>();
    }
    if (cfg.contains("max_iterations")) c.max_iterations = cfg["max_iterations"].cast<int>();
    if (cfg.contains("threads")) c.threads = cfg["threads"].cast<int>();
    if (cfg.contains("seed")) c.seed = cfg["seed"].cast<unsigned long long>();
    if (cfg.contains("time_limit_ms")) c.time_limit_ms = cfg["time_limit_ms"].cast<double>();
    if (cfg.contains("grid_rows")) c.grid_rows = cfg["grid_rows"].cast<int>();
    if (cfg.contains("polish")) c.polish = cfg["polish"].cast<bool>();
    if (!(c.roll_width_mm > 0.0)) throw std::invalid_argument("roll_width_mm must be positive.");
    if (c.kerf_mm < 0.0) throw std::invalid_argument("kerf_mm must not be negative.");
    return c;
}

py::list layout_to_py(const NestingProblem& problem, const Layout& layout) {
    py::list out;
    for (const PlacedPiece& p : layout.placed) {
        const PreparedShape& s = problem.pieces()[p.piece_index].rotations[p.rotation_index];
        py::dict item;
        item["id"] = problem.pieces()[p.piece_index].id;
        item["rotation_deg"] = p.rotation_deg;
        item["tx"] = p.tx;
        item["ty"] = p.ty;
        item["x"] = p.x;
        item["y"] = p.y;
        item["w"] = s.w;
        item["h"] = s.h;
        out.append(item);
    }
    return out;
}

py::dict validation_to_py(const ValidationReport& v) {
    py::dict d;
    d["valid"] = v.valid;
    d["violations"] = v.violations;
    d["min_clearance_mm"] = v.min_clearance_mm;
    d["pairs_checked"] = v.pairs_checked;
    d["interlocks"] = v.interlocks;
    return d;
}

py::dict solve(const py::list& pieces_py, const py::dict& cfg_py, const py::object& callback) {
    SolverConfig cfg = to_config(cfg_py);
    NestingProblem problem(to_pieces(pieces_py), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) throw std::invalid_argument(problem.error());

    SolveResult result;
    std::string callback_error;
    {
        py::gil_scoped_release release;
        ProgressCallback bridge;
        if (!callback.is_none()) {
            bridge = [&](const ProgressFrame& f) -> bool {
                py::gil_scoped_acquire acquire;
                try {
                    py::dict frame;
                    frame["phase"] = f.phase;
                    frame["iteration"] = f.iteration;
                    frame["max_iterations"] = f.max_iterations;
                    frame["temperature"] = f.temperature;
                    frame["elapsed_ms"] = f.elapsed_ms;
                    frame["best_length_mm"] = f.best_length_mm;
                    frame["current_length_mm"] = f.current_length_mm;
                    frame["evaluations"] = f.evaluations;
                    frame["accepted_moves"] = f.accepted_moves;
                    frame["improved"] = f.improved;
                    frame["layout"] = layout_to_py(problem, f.layout);
                    py::object keep_going = callback(frame);
                    return keep_going.is_none() || keep_going.cast<bool>();
                } catch (py::error_already_set& e) {
                    callback_error = e.what();
                    return false;
                }
            };
        }
        result = SimulatedAnnealingSolver(cfg).solve(problem, bridge);
    }
    if (!callback_error.empty()) throw std::runtime_error(callback_error);

    py::dict stats;
    stats["evaluations"] = result.stats.evaluations;
    stats["accepted_moves"] = result.stats.accepted_moves;
    stats["ffts"] = result.stats.ffts;
    stats["placements"] = result.stats.placements;
    stats["avg_fft_ms"] = result.stats.avg_fft_ms;
    stats["avg_eval_ms"] = result.stats.avg_eval_ms;
    stats["solve_ms"] = result.stats.solve_ms;
    stats["threads"] = result.stats.threads;
    stats["grid_rows"] = result.stats.grid_rows;
    stats["grid_cols"] = result.stats.grid_cols;
    stats["cell_mm"] = result.stats.cell_mm;
    stats["frames"] = result.stats.frames;
    stats["cancelled"] = result.stats.cancelled;

    py::dict out;
    out["total_area_mm2"] = problem.total_area_mm2();
    out["baseline_length_mm"] = result.baseline.length_mm;
    out["optimized_length_mm"] = result.optimized.length_mm;
    out["baseline_layout"] = layout_to_py(problem, result.baseline);
    out["optimized_layout"] = layout_to_py(problem, result.optimized);
    out["baseline_validation"] = validation_to_py(result.baseline_validation);
    out["optimized_validation"] = validation_to_py(result.optimized_validation);
    out["stats"] = stats;
    return out;
}

py::dict baseline(const py::list& pieces_py, const py::dict& cfg_py) {
    SolverConfig cfg = to_config(cfg_py);
    NestingProblem problem(to_pieces(pieces_py), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) throw std::invalid_argument(problem.error());
    const Layout layout = BaselineBoundingBoxPlacer::place(problem);
    py::dict out;
    out["total_area_mm2"] = problem.total_area_mm2();
    out["baseline_length_mm"] = layout.length_mm;
    out["baseline_layout"] = layout_to_py(problem, layout);
    out["baseline_validation"] = validation_to_py(problem.validate(layout));
    return out;
}

// One live FFT scan: which offsets are free for this piece, given everything else on the roll?
py::dict radar(const py::list& pieces_py, const py::dict& cfg_py, const py::list& layout_py, int piece_id,
               double rotation_deg) {
    SolverConfig cfg = to_config(cfg_py);
    NestingProblem problem(to_pieces(pieces_py), cfg.roll_width_mm, cfg.kerf_mm, cfg.allowed_rotations_deg);
    if (!problem.error().empty()) throw std::invalid_argument(problem.error());
    const auto& pieces = problem.pieces();

    auto index_of = [&](int id) {
        for (int i = 0; i < static_cast<int>(pieces.size()); ++i) {
            if (pieces[i].id == id) return i;
        }
        throw std::invalid_argument("Unknown piece id " + std::to_string(id));
    };
    auto rotation_index = [&](int piece, double deg) {
        const auto& rots = pieces[piece].rotations;
        for (int r = 0; r < static_cast<int>(rots.size()); ++r) {
            if (std::fabs(rots[r].rotation_deg - deg) < 1e-6) return r;
        }
        throw std::invalid_argument("Rotation not allowed for this piece.");
    };

    std::vector<PlacedPiece> placed;
    double extent = 0.0;
    for (const py::handle& item : layout_py) {
        auto d = item.cast<py::dict>();
        const int id = d["id"].cast<int>();
        if (id == piece_id) continue;
        const int p = index_of(id);
        const int r = rotation_index(p, d["rotation_deg"].cast<double>());
        const PreparedShape& s = pieces[p].rotations[r];
        const double x = d["tx"].cast<double>() - s.norm_x;
        const double y = d["ty"].cast<double>() - s.norm_y;
        placed.push_back(problem.make_placed(p, r, x, y));
        extent = std::max(extent, x + s.w);
    }

    const int p = index_of(piece_id);
    const int r = rotation_index(p, rotation_deg);
    const int rows = next_power_of_two(static_cast<int>(std::ceil(cfg.roll_width_mm / 6.0)));
    FFTGrid grid(problem, std::clamp(rows, 32, 256), extent + 400.0);
    for (const PlacedPiece& q : placed) grid.ensure(q.piece_index, q.rotation_index);
    grid.ensure(p, r);

    HybridFFTVectorPlacer placer(problem, grid);
    std::vector<float> map;
    const auto t0 = std::chrono::steady_clock::now();
    placer.correlation_map(placed, p, r, map);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    const FFTGrid::Entry& e = grid.entry(p, r);
    const PreparedShape& s = pieces[p].rotations[r];
    const int cols = grid.cols();
    std::string free_bytes(static_cast<std::size_t>(grid.rows()) * cols, '\0');
    const double kerf = problem.kerf();
    for (int dy = 0; dy < grid.rows(); ++dy) {
        const double y = (dy + grid.margin()) * grid.cell_mm();
        const bool row_ok = dy + e.raster_rows <= grid.rows() && y + s.h <= problem.roll_width() - kerf;
        for (int dx = 0; dx < cols; ++dx) {
            const bool col_ok = dx + e.raster_cols <= cols;
            free_bytes[static_cast<std::size_t>(dy) * cols + dx] =
                (row_ok && col_ok && map[static_cast<std::size_t>(dy) * cols + dx] < 0.5f) ? 1 : 0;
        }
    }

    py::dict out;
    out["rows"] = grid.rows();
    out["cols"] = cols;
    out["cell_mm"] = grid.cell_mm();
    out["margin"] = grid.margin();
    out["fft_ms"] = ms;
    out["piece_w"] = s.w;
    out["piece_h"] = s.h;
    out["free"] = py::bytes(free_bytes);
    return out;
}

}  // namespace

PYBIND11_MODULE(_cutzero_core, m) {
    m.doc() = "CutZero C++20 nesting engine: Radix-2 2D FFT + exact vector compaction + simulated annealing.";
    m.def("solve", &solve, py::arg("pieces"), py::arg("config"), py::arg("callback") = py::none(),
          "Runs the full optimizer. callback(frame) may return False to stop early.");
    m.def("baseline", &baseline, py::arg("pieces"), py::arg("config"), "First-Fit Decreasing bounding-box layout.");
    m.def("radar", &radar, py::arg("pieces"), py::arg("config"), py::arg("layout"), py::arg("piece_id"),
          py::arg("rotation_deg"), "Free-offset map for one piece from a single FFT correlation.");
    m.attr("__version__") = "1.0.0";
}
