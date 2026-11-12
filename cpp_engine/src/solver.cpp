#include "solver.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <numeric>
#include <utility>

#ifndef CUTZERO_NO_THREADS
#include <thread>
#endif

namespace cutzero {

namespace {

using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

// Own PRNG so runs are bit-for-bit reproducible across compilers and platforms.
class Rng {
public:
    explicit Rng(std::uint64_t seed) : state_(seed) {}
    std::uint64_t next() {
        std::uint64_t z = (state_ += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    int below(int n) { return static_cast<int>(next() % static_cast<std::uint64_t>(n)); }
    double uniform() { return static_cast<double>(next() >> 11) * (1.0 / 9007199254740992.0); }

private:
    std::uint64_t state_;
};

// Energy adds a small area-weighted profile term to the roll length. Length alone is a
// plateau: most moves leave it unchanged, so annealing would have no gradient to follow.
double layout_energy(const NestingProblem& problem, const Layout& layout) {
    const auto& pieces = problem.pieces();
    double weighted = 0.0;
    for (const PlacedPiece& p : layout.placed) {
        const Piece& piece = pieces[p.piece_index];
        weighted += piece.area * (p.x + piece.rotations[p.rotation_index].w);
    }
    return layout.length_mm + 0.25 * weighted / std::max(1.0, problem.total_area_mm2());
}

struct Solution {
    std::vector<int> sequence;
    std::vector<int> rotation;
    Layout layout;
    double energy = std::numeric_limits<double>::infinity();
};

class AnnealingChain {
public:
    AnnealingChain(const NestingProblem& problem, const FFTGrid& grid, std::uint64_t seed)
        : problem_(problem), placer_(problem, grid), rng_(seed) {}

    void seed_from(const std::vector<int>& order) {
        current_.sequence = order;
        current_.layout = placer_.decode_greedy_rotation(order, current_.rotation);
        current_.energy = layout_energy(problem_, current_.layout);
        best_ = current_;
        placer_.invalidate_from(0);
    }

    void adopt(const Solution& solution) {
        current_ = solution;
        placer_.invalidate_from(0);
    }

    // Average uphill move, used to start at a temperature that accepts a useful share of them.
    double sample_uphill(int samples) {
        double total = 0.0;
        int uphill = 0;
        for (int i = 0; i < samples; ++i) {
            Solution candidate = current_;
            const int changed = mutate(candidate);
            candidate.layout = placer_.decode(candidate.sequence, candidate.rotation, changed);
            ++evaluations_;
            placer_.invalidate_from(changed);
            const double delta = layout_energy(problem_, candidate.layout) - current_.energy;
            if (delta > 0) {
                total += delta;
                ++uphill;
            }
        }
        return uphill > 0 ? total / uphill : 10.0;
    }

    void run(int iterations, double& temperature, double alpha) {
        for (int i = 0; i < iterations; ++i) {
            candidate_ = current_;
            const int changed = mutate(candidate_);
            candidate_.layout = placer_.decode(candidate_.sequence, candidate_.rotation, changed);
            candidate_.energy = layout_energy(problem_, candidate_.layout);
            ++evaluations_;

            const double delta = candidate_.energy - current_.energy;
            if (delta <= 0.0 || rng_.uniform() < std::exp(-delta / std::max(temperature, 1e-9))) {
                std::swap(current_, candidate_);
                ++accepted_;
                if (current_.energy < best_.energy) best_ = current_;
            } else {
                placer_.invalidate_from(changed);
            }
            temperature *= alpha;
        }
    }

    const Solution& best() const { return best_; }
    const Solution& current() const { return current_; }
    long long evaluations() const { return evaluations_; }
    long long accepted() const { return accepted_; }
    const PlacerStats& placer_stats() const { return placer_.stats(); }
    HybridFFTVectorPlacer& placer() { return placer_; }

private:
    // Applies one move and returns the first sequence position it could have affected.
    int mutate(Solution& s) {
        const int n = static_cast<int>(s.sequence.size());
        if (n < 2) return 0;
        const double r = rng_.uniform();

        if (r < 0.30) {  // Swap two pieces, biased toward nearby positions.
            const int i = rng_.below(n);
            int j = i;
            if (rng_.uniform() < 0.5) {
                j = std::clamp(i + rng_.below(9) - 4, 0, n - 1);
            }
            while (j == i) j = rng_.below(n);
            std::swap(s.sequence[i], s.sequence[j]);
            return std::min(i, j);
        }
        if (r < 0.58) {  // Rotation flip of a single piece.
            const int pos = rng_.below(n);
            const int piece = s.sequence[pos];
            const int count = static_cast<int>(problem_.pieces()[piece].rotations.size());
            if (count > 1) {
                int next = rng_.below(count - 1);
                if (next >= s.rotation[piece]) ++next;
                s.rotation[piece] = next;
            }
            return pos;
        }
        if (r < 0.72) {  // Block shift: move a run of pieces elsewhere in the order.
            const int len = 1 + rng_.below(std::min(4, n - 1));
            const int from = rng_.below(n - len + 1);
            std::vector<int> block(s.sequence.begin() + from, s.sequence.begin() + from + len);
            s.sequence.erase(s.sequence.begin() + from, s.sequence.begin() + from + len);
            const int to = rng_.below(static_cast<int>(s.sequence.size()) + 1);
            s.sequence.insert(s.sequence.begin() + to, block.begin(), block.end());
            return std::min(from, to);
        }
        if (r < 0.82) {  // 2-opt: reverse a stretch of the order.
            int i = rng_.below(n);
            int j = rng_.below(n);
            if (i > j) std::swap(i, j);
            if (i == j) j = std::min(n - 1, i + 1);
            std::reverse(s.sequence.begin() + i, s.sequence.begin() + j + 1);
            return i;
        }
        if (r < 0.94) {  // Critical piece: pull whatever defines the roll length earlier.
            int critical = 0;
            double extent = -1.0;
            for (int i = 0; i < static_cast<int>(s.layout.placed.size()); ++i) {
                const PlacedPiece& p = s.layout.placed[i];
                const double right = p.x + problem_.pieces()[p.piece_index].rotations[p.rotation_index].w;
                if (right > extent) {
                    extent = right;
                    critical = i;
                }
            }
            if (critical == 0) return 0;
            const int to = rng_.below(critical);
            const int piece = s.sequence[critical];
            s.sequence.erase(s.sequence.begin() + critical);
            s.sequence.insert(s.sequence.begin() + to, piece);
            return to;
        }
        // Jostle: replay the pieces in reverse order of where they ended up, which refills
        // the gaps the previous pass left along the far edge.
        std::vector<std::pair<double, int>> keyed;
        keyed.reserve(n);
        for (const PlacedPiece& p : s.layout.placed) {
            keyed.emplace_back(p.x + problem_.pieces()[p.piece_index].rotations[p.rotation_index].w, p.piece_index);
        }
        std::sort(keyed.begin(), keyed.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
        for (int i = 0; i < n; ++i) s.sequence[i] = keyed[i].second;
        return 0;
    }

    const NestingProblem& problem_;
    HybridFFTVectorPlacer placer_;
    Rng rng_;
    Solution current_;
    Solution candidate_;
    Solution best_;
    long long evaluations_ = 0;
    long long accepted_ = 0;
};

int pick_rows(const NestingProblem& problem, int requested) {
    if (requested > 0) return next_power_of_two(requested);
    // Coarse grid for the search: exact sliding recovers what the raster gives up.
    const int rows = next_power_of_two(static_cast<int>(std::ceil(problem.roll_width() / 12.0)));
    return std::clamp(rows, 32, 256);
}

template <typename Fn>
void parallel_for(int count, Fn fn) {
#ifndef CUTZERO_NO_THREADS
    if (count > 1) {
        std::vector<std::thread> pool;
        pool.reserve(count - 1);
        for (int i = 1; i < count; ++i) pool.emplace_back(fn, i);
        fn(0);
        for (std::thread& t : pool) t.join();
        return;
    }
#endif
    for (int i = 0; i < count; ++i) fn(i);
}

}  // namespace

SolveResult SimulatedAnnealingSolver::solve(const NestingProblem& problem, const ProgressCallback& callback) const {
    const auto start = Clock::now();
    SolveResult result;
    const int n = static_cast<int>(problem.pieces().size());

    result.baseline = BaselineBoundingBoxPlacer::place(problem);
    result.baseline_validation = problem.validate(result.baseline);

    int thread_count = config_.threads;
#ifdef CUTZERO_NO_THREADS
    thread_count = 1;
#else
    if (thread_count <= 0) {
        thread_count = std::clamp(static_cast<int>(std::thread::hardware_concurrency()), 1, 4);
    }
#endif

    const auto& pieces = problem.pieces();
    const int rows = pick_rows(problem, config_.grid_rows);

    // A short scout decode sizes the strip. Every doubling of the FFT costs real time per
    // placement, so the grid should cover what a nest needs, not the whole baseline.
    double horizon = result.baseline.length_mm * 1.1 + 200.0;
    if (n > 1) {
        FFTGrid scout_grid(problem, rows, horizon);
        std::vector<int> order(n);
        std::iota(order.begin(), order.end(), 0);
        std::stable_sort(order.begin(), order.end(),
                         [&](int a, int b) { return pieces[a].area > pieces[b].area; });
        for (int i = 0; i < n; ++i) scout_grid.ensure(i, 0);
        HybridFFTVectorPlacer scout(problem, scout_grid);
        const std::vector<int> first_rotation(n, 0);
        // Slightly under the scout's length: good layouts are shorter than this greedy one, and a
        // piece that falls past the horizon is still placed exactly, just without the FFT.
        horizon = std::min(horizon, scout.decode(order, first_rotation).length_mm * 0.98 + 50.0);
    }
    // A defect that starts inside the horizon must fit in it whole, or its raster would wrap.
    for (const Obstacle& o : problem.obstacles()) {
        if (o.x < horizon) horizon = std::max(horizon, o.x + o.shape.w + 40.0);
    }

    FFTGrid grid(problem, rows, horizon);
    grid.ensure_all();

    std::vector<std::vector<int>> seeds;
    {
        std::vector<int> base(n);
        std::iota(base.begin(), base.end(), 0);
        auto sorted_by = [&](auto key) {
            std::vector<int> order = base;
            std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return key(a) > key(b); });
            return order;
        };
        seeds.push_back(sorted_by([&](int i) { return pieces[i].area; }));
        seeds.push_back(sorted_by([&](int i) {
            const PreparedShape& s = pieces[i].rotations[0];
            return std::max(s.w, s.h);
        }));
        seeds.push_back(sorted_by([&](int i) {
            const PreparedShape& s = pieces[i].rotations[0];
            return s.w * s.h;
        }));
        seeds.push_back(sorted_by([&](int i) { return pieces[i].rotations[0].h; }));
    }

    std::vector<std::unique_ptr<AnnealingChain>> chains;
    chains.reserve(thread_count);
    for (int i = 0; i < thread_count; ++i) {
        chains.push_back(std::make_unique<AnnealingChain>(problem, grid, config_.seed * 1000003ULL + i * 7919ULL + 1ULL));
    }

    int frames = 0;
    bool cancelled = false;
    Layout best_layout;
    double best_energy = std::numeric_limits<double>::infinity();
    Solution global_best;

    auto emit = [&](const char* phase, int iteration, double temperature, double current_length, bool improved) {
        if (!callback) return;
        ProgressFrame frame;
        frame.phase = phase;
        frame.iteration = iteration;
        frame.max_iterations = config_.max_iterations;
        frame.temperature = temperature;
        frame.elapsed_ms = ms_since(start);
        frame.best_length_mm = best_layout.length_mm;
        frame.current_length_mm = current_length;
        frame.improved = improved;
        for (const auto& c : chains) {
            frame.evaluations += c->evaluations();
            frame.accepted_moves += c->accepted();
        }
        frame.layout = best_layout;
        ++frames;
        if (!callback(frame)) cancelled = true;
    };

    auto absorb = [&](const Solution& s) {
        if (s.layout.length_mm < best_layout.length_mm - 1e-9 ||
            (best_layout.placed.empty()) ||
            (s.layout.length_mm <= best_layout.length_mm + 1e-9 && s.energy < best_energy)) {
            const bool shorter = best_layout.placed.empty() || s.layout.length_mm < best_layout.length_mm - 0.01;
            best_layout = s.layout;
            best_energy = s.energy;
            global_best = s;
            return shorter;
        }
        return false;
    };

    parallel_for(thread_count, [&](int i) {
        chains[i]->seed_from(seeds[i % seeds.size()]);
    });
    for (const auto& c : chains) absorb(c->best());
    emit("seed", 0, 0.0, best_layout.length_mm, true);

    // Calibrate the Boltzmann schedule: start where a typical uphill move has P(accept) ~ 0.4.
    const int calibration = std::max(4, std::min(16, config_.max_iterations / 16));
    double uphill = chains[0]->sample_uphill(calibration);
    const double t0 = std::clamp(-uphill / std::log(0.4), 1.0, 0.1 * best_layout.length_mm);
    const double t_end = std::max(0.25, t0 * 0.01);
    const int total = std::max(1, config_.max_iterations);
    const double alpha = std::pow(t_end / t0, 1.0 / total);

    // Rounds give deterministic synchronisation points for streaming and migration.
    const int round_size = std::max(1, total / 48);
    std::vector<double> temperatures(thread_count, t0);
    int iteration = 0;
    int stalled_rounds = 0;
    while (iteration < total && !cancelled) {
        if (config_.time_limit_ms > 0.0 && ms_since(start) > config_.time_limit_ms) break;
        const int batch = std::min(round_size, total - iteration);
        parallel_for(thread_count, [&](int i) { chains[i]->run(batch, temperatures[i], alpha); });
        iteration += batch;

        bool improved = false;
        for (const auto& c : chains) improved = absorb(c->best()) || improved;
        stalled_rounds = improved ? 0 : stalled_rounds + 1;

        // Island migration: the weakest chain restarts from the global best every so often.
        if (thread_count > 1 && stalled_rounds >= 6) {
            int worst = 0;
            for (int i = 1; i < thread_count; ++i) {
                if (chains[i]->current().energy > chains[worst]->current().energy) worst = i;
            }
            chains[worst]->adopt(global_best);
            // Reheat so the transplanted chain can leave the basin it landed in.
            temperatures[worst] = std::min(t0 * 0.5, temperatures[worst] * 2.0);
            stalled_rounds = 0;
        }

        emit("anneal", iteration, temperatures[0], chains[0]->current().layout.length_mm, improved);
    }

    if (!cancelled && config_.polish && n > 0) {
        // Exact compaction of the winner, then one replay on a finer grid that can see
        // narrower pockets than the search raster could.
        Layout compacted = best_layout;
        compact_layout(problem, compacted, 4);
        if (compacted.length_mm < best_layout.length_mm - 1e-9 && problem.validate(compacted).valid) {
            best_layout = compacted;
            emit("polish", iteration, 0.0, best_layout.length_mm, true);
        }
        if (config_.time_limit_ms <= 0.0 || ms_since(start) < config_.time_limit_ms) {
            FFTGrid fine(problem, std::min(rows * 2, 512), horizon);
            for (int piece : global_best.sequence) fine.ensure(piece, global_best.rotation[piece]);
            HybridFFTVectorPlacer placer(problem, fine);
            Layout replay = placer.decode(global_best.sequence, global_best.rotation, 0);
            compact_layout(problem, replay, 4);
            if (replay.length_mm < best_layout.length_mm - 1e-9 && problem.validate(replay).valid) {
                best_layout = replay;
                emit("polish", iteration, 0.0, best_layout.length_mm, true);
            }
            // Re-seat the pieces that define the roll length in any pocket that remains.
            // Large angle sets stay on the search grid: spectra for every angle on the fine
            // grid would cost hundreds of megabytes.
            const bool use_fine = problem.allowed_rotations().size() <= 8;
            if (use_fine) fine.ensure_all();
            HybridFFTVectorPlacer search_placer(problem, grid);
            HybridFFTVectorPlacer& reinserter = use_fine ? placer : search_placer;
            for (int pass = 0; pass < 3; ++pass) {
                Layout trial = best_layout;
                if (!reinserter.reinsert_critical(trial)) break;
                compact_layout(problem, trial, 2);
                if (trial.length_mm >= best_layout.length_mm - 1e-9 || !problem.validate(trial).valid) break;
                best_layout = trial;
                emit("polish", iteration, 0.0, best_layout.length_mm, true);
            }
        }
    }

    result.optimized = best_layout;
    result.optimized_validation = problem.validate(result.optimized);

    SolveStats& stats = result.stats;
    double fft_seconds = 0.0;
    for (const auto& c : chains) {
        stats.evaluations += c->evaluations();
        stats.accepted_moves += c->accepted();
        stats.ffts += c->placer_stats().ffts;
        stats.placements += c->placer_stats().placements;
        fft_seconds += c->placer_stats().fft_seconds;
    }
    stats.avg_fft_ms = stats.ffts > 0 ? 1000.0 * fft_seconds / stats.ffts : 0.0;
    stats.solve_ms = ms_since(start);
    stats.avg_eval_ms = stats.evaluations > 0 ? stats.solve_ms * thread_count / stats.evaluations : 0.0;
    stats.threads = thread_count;
    stats.grid_rows = grid.rows();
    stats.grid_cols = grid.cols();
    stats.cell_mm = grid.cell_mm();
    stats.frames = frames;
    stats.cancelled = cancelled;

    // A cancelled run still reports the best complete layout so far, and a final frame
    // always reflects exactly what was returned.
    return result;
}

}  // namespace cutzero
