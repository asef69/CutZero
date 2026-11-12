// test_bench.cpp - standalone verification and benchmark runner.
//
//   test_bench [--dir cpp_engine/testdata] [--iters 200] [--threads 0] [--seed 42] [--rows 0]
//              [--only preset_id] [--require-gain 14]
//
// Exit code is non-zero if any self-test fails, any layout has an overlap, or (with
// --require-gain) any preset falls short of that many percentage points of gain.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "fft2d.hpp"
#include "geometry.hpp"
#include "nfp_placer.hpp"
#include "solver.hpp"

using namespace cutzero;

namespace {

struct Dataset {
    std::string id;
    double width = 0, kerf = 0, gsm = 0, ef = 0;
    std::vector<double> rotations;
    std::vector<Piece> pieces;
};

bool load_dataset(const std::string& path, Dataset& data) {
    std::ifstream in(path);
    if (!in) return false;
    in >> data.id >> data.width >> data.kerf >> data.gsm >> data.ef;
    int rotation_count = 0;
    in >> rotation_count;
    data.rotations.resize(rotation_count);
    for (double& r : data.rotations) in >> r;
    int count = 0;
    in >> count;
    data.pieces.resize(count);
    for (int i = 0; i < count; ++i) {
        Piece& piece = data.pieces[i];
        piece.id = i;
        piece.name = "piece_" + std::to_string(i);
        int rings = 0;
        in >> rings;
        for (int r = 0; r < rings; ++r) {
            int vertices = 0;
            in >> vertices;
            Ring ring(vertices);
            for (Point2D& p : ring) in >> p.x >> p.y;
            if (r == 0) {
                piece.polygon.outer = std::move(ring);
            } else {
                piece.polygon.holes.push_back(std::move(ring));
            }
        }
    }
    return static_cast<bool>(in);
}

int g_failures = 0;
#define CHECK(cond, ...)                         \
    do {                                         \
        if (!(cond)) {                           \
            std::printf("  FAIL: " __VA_ARGS__); \
            std::printf("\n");                   \
            ++g_failures;                        \
        }                                        \
    } while (0)

void test_shoelace_and_containment() {
    std::printf("[self-test] shoelace, winding, clearance\n");
    Polygon2D square;
    square.outer = {{0, 0}, {100, 0}, {100, 100}, {0, 100}};
    square.holes.push_back({{25, 25}, {75, 25}, {75, 75}, {25, 75}});
    square.normalize_winding();
    CHECK(std::fabs(square.area() - 7500.0) < 1e-9, "area with hole = %f", square.area());

    PreparedShape frame = PreparedShape::build(square, 0);
    CHECK(frame.contains(10, 10), "solid point not contained");
    CHECK(!frame.contains(50, 50), "hole point reported as solid");
    CHECK(!frame.contains(150, 50), "outside point reported as solid");

    Polygon2D small;
    small.outer = {{0, 0}, {20, 0}, {20, 20}, {0, 20}};
    PreparedShape chip = PreparedShape::build(small, 0);
    CHECK(shapes_clear(chip, 40, 40, frame, 0, 0, 2.0), "part nested in hole should be clear");
    CHECK(!shapes_clear(chip, 5, 5, frame, 0, 0, 2.0), "part embedded in solid should collide");
    CHECK(!shapes_clear(chip, 26, 40, frame, 0, 0, 2.0), "part 1 mm from hole wall should violate 2 mm kerf");
    CHECK(shapes_clear(chip, 28, 40, frame, 0, 0, 2.0), "part 3 mm from hole wall should pass");
    CHECK(shapes_clear(chip, 101.5, 40, frame, 0, 0, 1.0), "1.5 mm gap with 1 mm kerf should pass");
    CHECK(!shapes_clear(chip, 101.5, 40, frame, 0, 0, 2.0), "1.5 mm gap with 2 mm kerf should fail");
    CHECK(std::fabs(shapes_distance(chip, 103, 40, frame, 0, 0) - 3.0) < 1e-9, "distance should be 3");

    Polygon2D giant;
    giant.outer = {{0, 0}, {300, 0}, {300, 300}, {0, 300}};
    PreparedShape big = PreparedShape::build(giant, 0);
    CHECK(!shapes_clear(chip, 100, 100, big, 0, 0, 2.0), "part fully inside solid must collide");
    CHECK(!shapes_clear(big, 0, 0, chip, 100, 100, 2.0), "containment must be symmetric");
}

void test_fft_against_direct() {
    std::printf("[self-test] FFT correlation vs direct summation\n");
    const int rows = 32, cols = 64;
    RealFFT2D fft(rows, cols);
    std::mt19937 rng(7);
    std::vector<float> sheet(rows * cols, 0.0f), piece(rows * cols, 0.0f);
    for (float& v : sheet) v = (rng() % 100) < 25 ? 1.0f : 0.0f;
    for (int y = 0; y < 6; ++y)
        for (int x = 0; x < 9; ++x) piece[y * cols + x] = (rng() % 100) < 70 ? 1.0f : 0.0f;

    Spectrum fs, fp, product;
    fft.forward(sheet.data(), fs);
    fft.forward(piece.data(), fp);
    fft.correlate(fs, fp, product);
    std::vector<float> fast(rows * cols);
    fft.inverse(product, fast.data(), rows);

    double worst = 0.0;
    for (int dy = 0; dy < rows; ++dy) {
        for (int dx = 0; dx < cols; ++dx) {
            double direct = 0.0;
            for (int y = 0; y < 6; ++y)
                for (int x = 0; x < 9; ++x)
                    direct += piece[y * cols + x] * sheet[((y + dy) % rows) * cols + (x + dx) % cols];
            worst = std::max(worst, std::fabs(direct - fast[dy * cols + dx]));
        }
    }
    std::printf("  worst correlation error: %.2e\n", worst);
    CHECK(worst < 1e-2, "FFT correlation disagrees with direct sum by %f", worst);

    // The shift-and-dilate fast path must equal transforming the shifted raster directly.
    Spectrum accumulated;
    accumulated.resize(fft.spectrum_size());
    fft.add_shifted_dilated(fp, 5, 3, accumulated);
    std::vector<float> dilated(rows * cols, 0.0f);
    for (int y = 0; y < 6; ++y) {
        for (int x = 0; x < 9; ++x) {
            const float v = piece[y * cols + x];
            for (int oy = 0; oy < 2; ++oy)
                for (int ox = 0; ox < 2; ++ox) dilated[(y + 3 + oy) * cols + x + 5 + ox] += v;
        }
    }
    Spectrum expect;
    fft.forward(dilated.data(), expect);
    double worst_spec = 0.0;
    for (std::size_t i = 0; i < expect.re.size(); ++i) {
        worst_spec = std::max(worst_spec, static_cast<double>(std::fabs(expect.re[i] - accumulated.re[i])));
        worst_spec = std::max(worst_spec, static_cast<double>(std::fabs(expect.im[i] - accumulated.im[i])));
    }
    std::printf("  worst shift+dilate error: %.2e\n", worst_spec);
    CHECK(worst_spec < 1e-2, "shift+dilate disagrees by %f", worst_spec);
}

void write_svg(const std::string& path, const NestingProblem& problem, const Layout& layout) {
    std::ofstream out(path);
    out << "<svg xmlns='http://www.w3.org/2000/svg' viewBox='-10 -10 " << layout.length_mm + 20 << " "
        << problem.roll_width() + 20 << "'><rect x='0' y='0' width='" << layout.length_mm << "' height='"
        << problem.roll_width() << "' fill='#123' stroke='#0f8'/>";
    for (const PlacedPiece& p : layout.placed) {
        const PreparedShape& s = problem.pieces()[p.piece_index].rotations[p.rotation_index];
        out << "<path fill='#6ad' fill-rule='evenodd' stroke='#fff' stroke-width='1' d='";
        double px = 1e18, py = 1e18;
        for (const Edge& e : s.edges) {
            if (e.ax != px || e.ay != py) out << "M" << e.ax + p.x << " " << e.ay + p.y << " ";
            out << "L" << e.bx + p.x << " " << e.by + p.y << " ";
            px = e.bx;
            py = e.by;
        }
        out << "'/>";
    }
    out << "</svg>";
}

void report_fft_speed() {
    std::printf("[benchmark] one full-strip correlation (correlate + inverse):\n");
    for (auto [rows, cols] : {std::pair{128, 256}, std::pair{256, 512}, std::pair{512, 1024}}) {
        RealFFT2D fft(rows, cols);
        std::vector<float> a(static_cast<std::size_t>(rows) * cols, 0.0f);
        for (int y = 0; y < rows / 2; ++y)
            for (int x = 0; x < cols / 2; ++x) a[static_cast<std::size_t>(y) * cols + x] = 1.0f;
        Spectrum fa, work;
        fft.forward(a.data(), fa);
        std::vector<float> out(a.size());
        const auto start = std::chrono::steady_clock::now();
        int runs = 0;
        double elapsed = 0.0;
        do {
            fft.correlate(fa, fa, work);
            fft.inverse(work, out.data(), rows);
            ++runs;
            elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        } while (elapsed < 200.0);
        std::printf("  %4d x %4d: %8.3f ms\n", rows, cols, elapsed / runs);
    }
}

}  // namespace

int main(int argc, char** argv) {
    std::string dir = "cpp_engine/testdata";
    std::string only;
    int iters = 200, threads = 0, rows = 0;
    unsigned long long seed = 42;
    double require_gain = 0.0;
    bool fine_rotations = false;
    std::string svg_dir;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto value = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
        if (a == "--dir") dir = value();
        else if (a == "--iters") iters = std::atoi(value());
        else if (a == "--threads") threads = std::atoi(value());
        else if (a == "--rows") rows = std::atoi(value());
        else if (a == "--seed") seed = std::strtoull(value(), nullptr, 10);
        else if (a == "--only") only = value();
        else if (a == "--require-gain") require_gain = std::atof(value());
        else if (a == "--free-rotation") fine_rotations = true;
        else if (a == "--svg") svg_dir = value();
    }

    test_shoelace_and_containment();
    test_fft_against_direct();
    report_fft_speed();

    std::printf("\n%-24s %5s %6s | %9s %6s | %9s %6s %6s | %7s %7s | %8s %7s %6s %7s\n", "preset", "parts", "rot",
                "base mm", "base%", "opt mm", "opt%", "gain", "min clr", "overlap", "time ms", "eval ms", "fft ms",
                "frames");

    for (const char* id : {"mens_dress_shirt", "technical_shell_jacket", "sheet_metal_enclosure"}) {
        if (!only.empty() && only != id) continue;
        Dataset data;
        if (!load_dataset(dir + "/" + id + ".txt", data)) {
            std::printf("  FAIL: could not read %s/%s.txt\n", dir.c_str(), id);
            ++g_failures;
            continue;
        }
        if (fine_rotations) data.rotations = {0, 90, 180, 270};
        NestingProblem problem(data.pieces, data.width, data.kerf, data.rotations);
        CHECK(problem.error().empty(), "%s", problem.error().c_str());

        SolverConfig cfg;
        cfg.roll_width_mm = data.width;
        cfg.kerf_mm = data.kerf;
        cfg.allowed_rotations_deg = data.rotations;
        cfg.max_iterations = iters;
        cfg.threads = threads;
        cfg.seed = seed;
        cfg.grid_rows = rows;

        const SolveResult r = SimulatedAnnealingSolver(cfg).solve(problem, nullptr);
        const double area = problem.total_area_mm2();
        const double eta_base = 100.0 * area / (data.width * r.baseline.length_mm);
        const double eta_opt = 100.0 * area / (data.width * r.optimized.length_mm);

        std::printf("%-24s %5zu %6zu | %9.1f %6.2f | %9.1f %6.2f %+6.2f | %7.3f %7d | %8.0f %7.2f %6.3f %7d\n", id,
                    data.pieces.size(), data.rotations.size(), r.baseline.length_mm, eta_base, r.optimized.length_mm,
                    eta_opt, eta_opt - eta_base, r.optimized_validation.min_clearance_mm,
                    r.optimized_validation.violations, r.stats.solve_ms, r.stats.avg_eval_ms, r.stats.avg_fft_ms,
                    r.stats.frames);

        if (!svg_dir.empty()) {
            write_svg(svg_dir + "/" + id + ".svg", problem, r.optimized);
            write_svg(svg_dir + "/" + id + "_baseline.svg", problem, r.baseline);
        }

        CHECK(r.baseline_validation.valid, "%s baseline has %d violations", id, r.baseline_validation.violations);
        CHECK(r.optimized_validation.valid, "%s optimized has %d violations", id, r.optimized_validation.violations);
        CHECK(r.optimized.placed.size() == data.pieces.size(), "%s lost pieces", id);
        if (require_gain > 0.0) {
            CHECK(eta_opt - eta_base >= require_gain, "%s gain %.2f < required %.2f", id, eta_opt - eta_base,
                  require_gain);
        }
    }

    std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL CHECKS PASSED" : "CHECKS FAILED", g_failures,
                g_failures == 1 ? "" : "s");
    return g_failures == 0 ? 0 : 1;
}
