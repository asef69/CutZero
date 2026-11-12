// solver.hpp - multi-chain Simulated Annealing over placement order and rotation.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "nfp_placer.hpp"

namespace cutzero {

struct SolverConfig {
    double roll_width_mm = 1500.0;
    double kerf_mm = 2.0;
    std::vector<double> allowed_rotations_deg{0.0, 90.0, 180.0, 270.0};
    int max_iterations = 200;
    int threads = 0;  // 0 = auto (capped at 8).
    unsigned long long seed = 42;
    double time_limit_ms = 0.0;  // 0 = no limit.
    int grid_rows = 0;           // 0 = auto. Must be a power of two.
    bool polish = true;
    // Regions of the roll no part may touch (fabric flaws, damaged sheet), in roll coordinates.
    std::vector<Polygon2D> defects;
};

struct ProgressFrame {
    std::string phase;  // "seed" | "anneal" | "polish"
    int iteration = 0;
    int max_iterations = 0;
    double temperature = 0.0;
    double elapsed_ms = 0.0;
    double best_length_mm = 0.0;
    double current_length_mm = 0.0;
    long long evaluations = 0;
    long long accepted_moves = 0;
    bool improved = false;
    Layout layout;
};

struct SolveStats {
    long long evaluations = 0;
    long long accepted_moves = 0;
    long long ffts = 0;
    long long placements = 0;
    double avg_fft_ms = 0.0;
    double avg_eval_ms = 0.0;
    double solve_ms = 0.0;
    int threads = 0;
    int grid_rows = 0;
    int grid_cols = 0;
    double cell_mm = 0.0;
    int frames = 0;
    bool cancelled = false;
};

struct SolveResult {
    Layout baseline;
    Layout optimized;
    ValidationReport baseline_validation;
    ValidationReport optimized_validation;
    SolveStats stats;
};

// Return false from the callback to stop the run early.
using ProgressCallback = std::function<bool(const ProgressFrame&)>;

class SimulatedAnnealingSolver {
public:
    explicit SimulatedAnnealingSolver(const SolverConfig& config) : config_(config) {}
    SolveResult solve(const NestingProblem& problem, const ProgressCallback& callback) const;

private:
    SolverConfig config_;
};

}  // namespace cutzero
