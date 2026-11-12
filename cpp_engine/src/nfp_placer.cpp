#include "nfp_placer.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
#include <utility>

namespace cutzero {

namespace {
// Placement holds kerf + 2 microns so a layout stays valid after coordinates are rounded to
// 3 decimals for export (two parts can each move at most 0.0007 mm).
constexpr double kSlack = 0.002;
constexpr int kCandidates = 4;

double slide_along(const NestingProblem& problem, const PreparedShape& shape,
                   const std::vector<const PreparedShape*>& others, const std::vector<PlacedPiece>& placed,
                   const std::vector<int>& near, double x, double y, double dx, double dy, double max_dist,
                   double step);
}  // namespace

// ---------------------------------------------------------------------------
// NestingProblem
// ---------------------------------------------------------------------------

NestingProblem::NestingProblem(std::vector<Piece> pieces, double roll_width_mm, double kerf_mm,
                               std::vector<double> allowed_rotations_deg, const std::vector<Polygon2D>& defects)
    : pieces_(std::move(pieces)),
      roll_width_mm_(roll_width_mm),
      kerf_mm_(kerf_mm),
      rotations_(std::move(allowed_rotations_deg)) {
    if (rotations_.empty()) rotations_.push_back(0.0);
    for (Piece& piece : pieces_) {
        piece.polygon.normalize_winding();
        piece.area = piece.polygon.area();
        total_area_mm2_ += piece.area;
        piece.rotations.clear();
        for (double deg : rotations_) {
            PreparedShape shape = PreparedShape::build(piece.polygon, deg);
            if (shape.h + 2.0 * (kerf_mm_ + kSlack) <= roll_width_mm_) {
                piece.rotations.push_back(std::move(shape));
            }
        }
        if (piece.rotations.empty()) {
            error_ = "Piece '" + piece.name + "' does not fit across the " +
                     std::to_string(static_cast<int>(roll_width_mm_)) + " mm roll at any allowed rotation.";
        }
    }
    for (Polygon2D defect : defects) {
        if (defect.outer.size() < 3) continue;
        defect.normalize_winding();
        Obstacle o;
        o.shape = PreparedShape::build(defect, 0.0);
        o.x = -o.shape.norm_x;
        o.y = -o.shape.norm_y;
        obstacles_.push_back(std::move(o));
    }
}

PlacedPiece NestingProblem::make_placed(int piece_index, int rotation_index, double x, double y) const {
    const PreparedShape& shape = pieces_[piece_index].rotations[rotation_index];
    PlacedPiece placed;
    placed.piece_index = piece_index;
    placed.rotation_index = rotation_index;
    placed.rotation_deg = shape.rotation_deg;
    placed.x = x;
    placed.y = y;
    placed.tx = x + shape.norm_x;
    placed.ty = y + shape.norm_y;
    return placed;
}

double NestingProblem::layout_length(const std::vector<PlacedPiece>& placed) const {
    double extent = 0.0;
    for (const PlacedPiece& p : placed) {
        const PreparedShape& shape = pieces_[p.piece_index].rotations[p.rotation_index];
        extent = std::max(extent, p.x + shape.w);
    }
    return placed.empty() ? 0.0 : extent + kerf_mm_;
}

ValidationReport NestingProblem::validate(const Layout& layout) const {
    ValidationReport report;
    report.min_clearance_mm = std::numeric_limits<double>::infinity();
    const std::size_t n = layout.placed.size();
    const double tolerance = 1e-7;

    for (std::size_t i = 0; i < n; ++i) {
        const PlacedPiece& a = layout.placed[i];
        const PreparedShape& sa = pieces_[a.piece_index].rotations[a.rotation_index];
        // Roll boundaries.
        const double wall = std::min({a.x, a.y, roll_width_mm_ - (a.y + sa.h)});
        report.min_clearance_mm = std::min(report.min_clearance_mm, wall);
        if (wall < kerf_mm_ - tolerance) ++report.violations;

        for (std::size_t j = i + 1; j < n; ++j) {
            const PlacedPiece& b = layout.placed[j];
            const PreparedShape& sb = pieces_[b.piece_index].rotations[b.rotation_index];
            const double gap_x = std::max(b.x - (a.x + sa.w), a.x - (b.x + sb.w));
            const double gap_y = std::max(b.y - (a.y + sa.h), a.y - (b.y + sb.h));
            const double gap = std::max(gap_x, gap_y);
            if (gap >= kerf_mm_ + 50.0) continue;  // Provably clear, and never the closest pair.
            ++report.pairs_checked;
            const double d = shapes_distance(sa, a.x, a.y, sb, b.x, b.y);
            report.min_clearance_mm = std::min(report.min_clearance_mm, d);
            if (d < kerf_mm_ - tolerance) ++report.violations;
            if (gap < 0.0 && d >= kerf_mm_ - tolerance) ++report.interlocks;
        }
        // Defects: no part may touch a flaw.
        for (const Obstacle& o : obstacles_) {
            const double gap_x = std::max(o.x - (a.x + sa.w), a.x - (o.x + o.shape.w));
            const double gap_y = std::max(o.y - (a.y + sa.h), a.y - (o.y + o.shape.h));
            if (std::max(gap_x, gap_y) >= kerf_mm_ + 50.0) continue;
            ++report.pairs_checked;
            const double d = shapes_distance(sa, a.x, a.y, o.shape, o.x, o.y);
            report.min_clearance_mm = std::min(report.min_clearance_mm, d);
            if (d < kerf_mm_ - tolerance) ++report.violations;
        }
    }
    if (n == 0) report.min_clearance_mm = 0.0;
    report.valid = report.violations == 0;
    return report;
}

// ---------------------------------------------------------------------------
// BaselineBoundingBoxPlacer
// ---------------------------------------------------------------------------

Layout BaselineBoundingBoxPlacer::place(const NestingProblem& problem) {
    const auto& pieces = problem.pieces();
    const double kerf = problem.kerf() + kSlack;
    const double width = problem.roll_width();
    const int n = static_cast<int>(pieces.size());

    struct Shelf {
        double x;
        double depth;   // Extent along the roll.
        double filled;  // Used across the roll.
    };

    Layout best;
    best.length_mm = std::numeric_limits<double>::infinity();

    // A bounding box collides with a defect when the boxes come closer than the kerf.
    const auto& obstacles = problem.obstacles();
    auto blocker = [&](double x, double y, double w, double h) -> const Obstacle* {
        for (const Obstacle& o : obstacles) {
            if (x < o.x + o.shape.w + kerf && o.x < x + w + kerf && y < o.y + o.shape.h + kerf && o.y < y + h + kerf) {
                return &o;
            }
        }
        return nullptr;
    };

    // Rotation policy: 0 = first allowed, 1 = shortest along the roll, 2 = narrowest across it.
    for (int policy = 0; policy < 3; ++policy) {
        std::vector<int> rotation(n, 0);
        for (int i = 0; i < n; ++i) {
            const auto& rots = pieces[i].rotations;
            for (int r = 1; r < static_cast<int>(rots.size()); ++r) {
                const PreparedShape& cand = rots[r];
                const PreparedShape& cur = rots[rotation[i]];
                if (policy == 1 && cand.w < cur.w - 1e-9) rotation[i] = r;
                if (policy == 2 && cand.h < cur.h - 1e-9) rotation[i] = r;
            }
        }
        // Sort key: 0 = depth along the roll, 1 = bbox height across it, 2 = bbox area.
        for (int key = 0; key < 3; ++key) {
            std::vector<int> order(n);
            std::iota(order.begin(), order.end(), 0);
            auto measure = [&](int i) {
                const PreparedShape& s = pieces[i].rotations[rotation[i]];
                if (key == 0) return s.w;
                if (key == 1) return s.h;
                return s.w * s.h;
            };
            std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return measure(a) > measure(b); });

            std::vector<Shelf> shelves;
            std::vector<PlacedPiece> placed;
            double next_x = kerf;
            for (int i : order) {
                const PreparedShape& s = pieces[i].rotations[rotation[i]];
                bool done = false;
                for (Shelf& shelf : shelves) {
                    if (s.w > shelf.depth) continue;
                    double y = shelf.filled;
                    // Step over any defect in this shelf's column.
                    while (y + s.h + kerf <= width) {
                        const Obstacle* o = blocker(shelf.x, y, s.w, s.h);
                        if (o == nullptr) break;
                        y = o->y + o->shape.h + kerf;
                    }
                    if (y + s.h + kerf <= width) {
                        placed.push_back(problem.make_placed(i, rotation[i], shelf.x, y));
                        shelf.filled = y + s.h + kerf;
                        done = true;
                        break;
                    }
                }
                if (!done) {
                    // New shelf: walk across the roll, and past any defect that fills the column.
                    double x = next_x, y = kerf, column_right = next_x;
                    for (int guard = 0; guard < 10000; ++guard) {
                        if (y + s.h + kerf > width) {
                            x = column_right;
                            y = kerf;
                            continue;
                        }
                        const Obstacle* o = blocker(x, y, s.w, s.h);
                        if (o == nullptr) break;
                        column_right = std::max(column_right, o->x + o->shape.w + kerf);
                        y = o->y + o->shape.h + kerf;
                    }
                    placed.push_back(problem.make_placed(i, rotation[i], x, y));
                    shelves.push_back(Shelf{x, s.w, y + s.h + kerf});
                    next_x = x + s.w + kerf;
                }
            }
            const double length = problem.layout_length(placed);
            if (length < best.length_mm) {
                best.length_mm = length;
                best.placed = std::move(placed);
            }
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// FFTGrid
// ---------------------------------------------------------------------------

FFTGrid::FFTGrid(const NestingProblem& problem, int rows, double horizon_mm) : problem_(problem), rows_(rows) {
    cell_ = problem.roll_width() / static_cast<double>(rows_ - 1);
    cols_ = next_power_of_two(static_cast<int>(std::ceil(horizon_mm / cell_)) + 2);
    margin_ = std::max(1, static_cast<int>(std::ceil((problem.kerf() * 0.5 + kSlack) / cell_)));
    fft_ = std::make_unique<RealFFT2D>(rows_, cols_);
    const auto& pieces = problem.pieces();
    entries_.resize(pieces.size());
    for (std::size_t i = 0; i < pieces.size(); ++i) entries_[i].resize(pieces[i].rotations.size());
    obstacle_entries_.resize(problem.obstacles().size());
    std::vector<float> raster;
    for (std::size_t i = 0; i < obstacle_entries_.size(); ++i) {
        Entry& e = obstacle_entries_[i];
        rasterize(problem.obstacles()[i].shape, raster, e.raster_cols, e.raster_rows);
        fft_->forward(raster.data(), e.spectrum);
        e.ready = true;
    }
}

void FFTGrid::rasterize(const PreparedShape& shape, std::vector<float>& out, int& raster_cols,
                        int& raster_rows) const {
    // Raster cell i covers local coordinates [(i - margin) * cell, (i - margin + 1) * cell).
    const double c = cell_;
    const double pad = problem_.kerf() * 0.5 + kSlack;
    const int m = margin_;
    raster_cols = std::min(cols_, static_cast<int>(std::ceil((shape.w + pad) / c)) + m);
    raster_rows = std::min(rows_, static_cast<int>(std::ceil((shape.h + pad) / c)) + m);
    out.assign(static_cast<std::size_t>(rows_) * cols_, 0.0f);

    auto mark = [&](int row, int from, int to) {
        if (row < 0 || row >= raster_rows) return;
        from = std::max(from, 0);
        to = std::min(to, raster_cols - 1);
        float* base = out.data() + static_cast<std::size_t>(row) * cols_;
        for (int i = from; i <= to; ++i) base[i] = 1.0f;
    };

    // Boundary: mark every cell an edge, inflated by half the kerf, can touch.
    for (const Edge& e : shape.edges) {
        const double lo_y = std::min(e.ay, e.by) - pad;
        const double hi_y = std::max(e.ay, e.by) + pad;
        const int row_lo = static_cast<int>(std::floor(lo_y / c)) + m;
        const int row_hi = static_cast<int>(std::floor(hi_y / c)) + m;
        for (int row = row_lo; row <= row_hi; ++row) {
            const double band_lo = (row - m) * c - pad;
            const double band_hi = (row - m + 1) * c + pad;
            double x0, x1;
            const double dy = e.by - e.ay;
            if (std::fabs(dy) < 1e-12) {
                x0 = std::min(e.ax, e.bx);
                x1 = std::max(e.ax, e.bx);
            } else {
                double t0 = std::clamp((band_lo - e.ay) / dy, 0.0, 1.0);
                double t1 = std::clamp((band_hi - e.ay) / dy, 0.0, 1.0);
                x0 = e.ax + t0 * (e.bx - e.ax);
                x1 = e.ax + t1 * (e.bx - e.ax);
                if (x0 > x1) std::swap(x0, x1);
            }
            mark(row, static_cast<int>(std::floor((x0 - pad) / c)) + m,
                 static_cast<int>(std::floor((x1 + pad) / c)) + m);
        }
    }

    // Interior: even-odd fill sampled at each row's centre line.
    std::vector<double> crossings;
    for (int row = 0; row < raster_rows; ++row) {
        const double y = (row - m + 0.5) * c;
        crossings.clear();
        for (const Edge& e : shape.edges) {
            if ((e.ay <= y) != (e.by <= y)) {
                crossings.push_back(e.ax + (y - e.ay) / (e.by - e.ay) * (e.bx - e.ax));
            }
        }
        std::sort(crossings.begin(), crossings.end());
        for (std::size_t i = 0; i + 1 < crossings.size(); i += 2) {
            const int from = static_cast<int>(std::ceil(crossings[i] / c - 0.5)) + m;
            const int to = static_cast<int>(std::floor(crossings[i + 1] / c - 0.5)) + m;
            mark(row, from, to);
        }
    }
}

void FFTGrid::ensure(int piece_index, int rotation_index) {
    Entry& e = entries_[piece_index][rotation_index];
    if (e.ready) return;
    std::vector<float> raster;
    rasterize(problem_.pieces()[piece_index].rotations[rotation_index], raster, e.raster_cols, e.raster_rows);
    fft_->forward(raster.data(), e.spectrum);
    e.ready = true;
}

void FFTGrid::ensure_all() {
    for (std::size_t p = 0; p < entries_.size(); ++p) {
        for (std::size_t r = 0; r < entries_[p].size(); ++r) ensure(static_cast<int>(p), static_cast<int>(r));
    }
}

// ---------------------------------------------------------------------------
// HybridFFTVectorPlacer
// ---------------------------------------------------------------------------

HybridFFTVectorPlacer::HybridFFTVectorPlacer(const NestingProblem& problem, const FFTGrid& grid)
    : problem_(problem), grid_(grid) {
    sheet_.resize(grid_.fft().spectrum_size());
    corr_.resize(static_cast<std::size_t>(grid_.rows()) * grid_.cols());
    leftmost_.resize(grid_.rows());
    order_.resize(grid_.rows());
    checkpoints_.resize(problem_.pieces().size() + 1);
    for (Spectrum& s : checkpoints_) s.resize(grid_.fft().spectrum_size());
    fixed_ = static_cast<int>(problem_.obstacles().size());
}

void HybridFFTVectorPlacer::reset() {
    placed_.clear();
    placed_shapes_.clear();
    extent_ = 0.0;
    std::fill(sheet_.re.begin(), sheet_.re.end(), 0.0f);
    std::fill(sheet_.im.begin(), sheet_.im.end(), 0.0f);
    // Defects go onto the sheet first, so every FFT scan already sees them as occupied.
    const double c = grid_.cell_mm();
    const auto& obstacles = problem_.obstacles();
    for (int i = 0; i < fixed_; ++i) {
        const Obstacle& o = obstacles[i];
        const FFTGrid::Entry& e = grid_.obstacle_entry(i);
        const int sx = static_cast<int>(std::floor(o.x / c)) - grid_.margin();
        const int sy = static_cast<int>(std::floor(o.y / c)) - grid_.margin();
        // A defect past the grid's horizon would wrap around the circular correlation; the exact
        // vector check still keeps parts clear of it.
        if (sx + e.raster_cols <= grid_.cols()) grid_.fft().add_shifted_dilated(e.spectrum, sx, sy, sheet_);
        PlacedPiece p;
        p.piece_index = -1;
        p.x = o.x;
        p.y = o.y;
        placed_.push_back(p);
        placed_shapes_.push_back(&o.shape);
    }
}

Layout HybridFFTVectorPlacer::pieces_only() const {
    Layout layout;
    layout.placed.assign(placed_.begin() + fixed_, placed_.end());
    layout.length_mm = problem_.layout_length(layout.placed);
    return layout;
}

void HybridFFTVectorPlacer::invalidate_from(int from) {
    checkpoints_valid_ = std::min(checkpoints_valid_, from);
}

Layout HybridFFTVectorPlacer::decode(const std::vector<int>& sequence, const std::vector<int>& rotation,
                                     int first_changed) {
    const int n = static_cast<int>(sequence.size());
    // Longest prefix still described by the checkpoints.
    int reuse = std::min({first_changed, checkpoints_valid_, static_cast<int>(placed_.size()) - fixed_});
    if (static_cast<int>(last_sequence_.size()) != n) reuse = 0;
    if (reuse > 0) {
        int same = 0;
        while (same < reuse && last_sequence_[same] == sequence[same] &&
               last_rotation_[last_sequence_[same]] == rotation[sequence[same]]) {
            ++same;
        }
        reuse = same;
    }

    if (reuse == 0) {
        reset();
    } else {
        placed_.resize(fixed_ + reuse);
        placed_shapes_.resize(fixed_ + reuse);
        extent_ = 0.0;
        for (int i = fixed_; i < fixed_ + reuse; ++i) extent_ = std::max(extent_, placed_[i].x + placed_shapes_[i]->w);
        sheet_.re = checkpoints_[reuse].re;
        sheet_.im = checkpoints_[reuse].im;
    }

    for (int i = reuse; i < n; ++i) {
        place(sequence[i], rotation[sequence[i]]);
        checkpoints_[i + 1].re = sheet_.re;
        checkpoints_[i + 1].im = sheet_.im;
    }
    checkpoints_valid_ = n;
    last_sequence_ = sequence;
    last_rotation_ = rotation;
    return pieces_only();
}

Layout HybridFFTVectorPlacer::decode_greedy_rotation(const std::vector<int>& sequence, std::vector<int>& rotation) {
    reset();
    const auto& pieces = problem_.pieces();
    rotation.assign(pieces.size(), 0);
    for (int piece_index : sequence) {
        const int count = static_cast<int>(pieces[piece_index].rotations.size());
        const int step = std::max(1, count / 8);  // Fine angle sets sample a subset when seeding.
        int best_r = 0;
        PlacedPiece best{};
        double best_score = std::numeric_limits<double>::infinity();
        for (int r = 0; r < count; r += step) {
            const PlacedPiece cand = find_position(piece_index, r);
            const PreparedShape& s = pieces[piece_index].rotations[r];
            const double score = cand.x + s.w + 0.2 * (cand.x + s.center_x);
            if (score < best_score) {
                best_score = score;
                best_r = r;
                best = cand;
            }
        }
        rotation[piece_index] = best_r;
        commit(best);
    }
    checkpoints_valid_ = 0;
    return pieces_only();
}

void HybridFFTVectorPlacer::correlation_map(const std::vector<PlacedPiece>& placed, int piece_index,
                                            int rotation_index, std::vector<float>& out) {
    reset();
    for (const PlacedPiece& p : placed) commit(p);
    const FFTGrid::Entry& e = grid_.entry(piece_index, rotation_index);
    grid_.fft().correlate(sheet_, e.spectrum, work_);
    out.resize(static_cast<std::size_t>(grid_.rows()) * grid_.cols());
    grid_.fft().inverse(work_, out.data(), grid_.rows());
}

bool HybridFFTVectorPlacer::reinsert_critical(Layout& layout) {
    const auto& pieces = problem_.pieces();
    const int n = static_cast<int>(layout.placed.size());
    if (n < 2) return false;

    std::vector<int> order(n);
    std::iota(order.begin(), order.end(), 0);
    auto right_edge = [&](const PlacedPiece& p) { return p.x + pieces[p.piece_index].rotations[p.rotation_index].w; };
    std::sort(order.begin(), order.end(),
              [&](int a, int b) { return right_edge(layout.placed[a]) > right_edge(layout.placed[b]); });

    const double before = layout.length_mm;
    const int attempts = std::min(n, std::max(4, n / 3));
    for (int k = 0; k < attempts; ++k) {
        const int idx = order[k];
        const PlacedPiece original = layout.placed[idx];
        reset();
        for (int i = 0; i < n; ++i) {
            if (i != idx) commit(layout.placed[i]);
        }
        const double old_right = right_edge(original);
        PlacedPiece best = original;
        double best_right = old_right;
        const int count = static_cast<int>(pieces[original.piece_index].rotations.size());
        for (int r = 0; r < count; ++r) {
            const PlacedPiece cand = find_position(original.piece_index, r);
            const double right = right_edge(cand);
            if (right < best_right - 0.05) {
                best_right = right;
                best = cand;
            }
        }
        layout.placed[idx] = best;
    }
    checkpoints_valid_ = 0;
    layout.length_mm = problem_.layout_length(layout.placed);
    return layout.length_mm < before - 1e-9;
}

void HybridFFTVectorPlacer::commit(const PlacedPiece& p) {
    const PreparedShape& shape = problem_.pieces()[p.piece_index].rotations[p.rotation_index];
    const FFTGrid::Entry& e = grid_.entry(p.piece_index, p.rotation_index);
    const double c = grid_.cell_mm();
    const int sx = static_cast<int>(std::floor(p.x / c)) - grid_.margin();
    const int sy = static_cast<int>(std::floor(p.y / c)) - grid_.margin();
    grid_.fft().add_shifted_dilated(e.spectrum, sx, sy, sheet_);
    placed_.push_back(p);
    placed_shapes_.push_back(&shape);
    extent_ = std::max(extent_, p.x + shape.w);
    ++stats_.placements;
}

void HybridFFTVectorPlacer::place(int piece_index, int rotation_index) {
    commit(find_position(piece_index, rotation_index));
}

void HybridFFTVectorPlacer::collect_neighbors(const PreparedShape&, double min_x, double min_y, double max_x,
                                              double max_y, std::vector<int>& near) const {
    near.clear();
    const double k = problem_.kerf() + 1.0;
    for (int i = 0; i < static_cast<int>(placed_.size()); ++i) {
        const PlacedPiece& p = placed_[i];
        const PreparedShape& s = *placed_shapes_[i];
        if (p.x > max_x + k || p.x + s.w < min_x - k || p.y > max_y + k || p.y + s.h < min_y - k) continue;
        near.push_back(i);
    }
}

bool HybridFFTVectorPlacer::position_free(const PreparedShape& shape, double x, double y,
                                          const std::vector<int>& near) const {
    const double kerf = problem_.kerf() + kSlack;
    for (int i : near) {
        const PlacedPiece& p = placed_[i];
        if (!shapes_clear(shape, x, y, *placed_shapes_[i], p.x, p.y, kerf)) return false;
    }
    return true;
}

double HybridFFTVectorPlacer::slide(const PreparedShape& shape, double x, double y, double dir_x, double dir_y,
                                    double max_dist) {
    if (max_dist <= 1e-9) return 0.0;
    CUTZERO_TLS std::vector<int> band;
    const double end_x = x + dir_x * max_dist;
    const double end_y = y + dir_y * max_dist;
    collect_neighbors(shape, std::min(x, end_x), std::min(y, end_y), std::max(x, end_x) + shape.w,
                      std::max(y, end_y) + shape.h, band);
    return slide_along(problem_, shape, placed_shapes_, placed_, band, x, y, dir_x, dir_y, max_dist,
                       grid_.cell_mm() * 0.5);
}

void HybridFFTVectorPlacer::compact(const PreparedShape& shape, double& x, double& y) {
    const double kerf = problem_.kerf() + kSlack;
    const double wall_hi = problem_.roll_width() - kerf - shape.h;
    const double c = grid_.cell_mm();

    x -= slide(shape, x, y, -1, 0, x - kerf);
    for (int round = 0; round < 2; ++round) {
        double best_x = x, best_y = y;
        for (double dir : {-1.0, 1.0}) {
            const double room = dir < 0 ? y - kerf : wall_hi - y;
            const double moved = slide(shape, x, y, 0, dir, std::min(room, 3.0 * c));
            if (moved <= 0.01) continue;
            const double ny = y + dir * moved;
            const double nx = x - slide(shape, x, ny, -1, 0, x - kerf);
            if (nx < best_x - 0.05) {
                best_x = nx;
                best_y = ny;
            }
        }
        if (best_x == x) break;
        x = best_x;
        y = best_y;
    }
    // Settle flush downward so neighbours are left a clean profile.
    y -= slide(shape, x, y, 0, -1, std::min(y - kerf, c));
}

PlacedPiece HybridFFTVectorPlacer::find_position(int piece_index, int rotation_index) {
    const PreparedShape& shape = problem_.pieces()[piece_index].rotations[rotation_index];
    const double kerf = problem_.kerf() + kSlack;

    if (placed_.empty()) return problem_.make_placed(piece_index, rotation_index, kerf, kerf);

    const FFTGrid::Entry& e = grid_.entry(piece_index, rotation_index);
    const double c = grid_.cell_mm();
    const int m = grid_.margin();
    const double wall_hi = problem_.roll_width() - kerf - shape.h;

    // Largest row offset whose real position stays inside the roll.
    int dy_max = static_cast<int>(std::floor(wall_hi / c)) - m;
    dy_max = std::clamp(dy_max, 0, grid_.rows() - e.raster_rows);
    const int dx_max = grid_.cols() - e.raster_cols;

    const auto t0 = std::chrono::steady_clock::now();
    grid_.fft().correlate(sheet_, e.spectrum, work_);
    grid_.fft().inverse(work_, corr_.data(), dy_max + 1);
    stats_.fft_seconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    ++stats_.ffts;

    // Leftmost collision-free column for every row offset.
    const int cols = grid_.cols();
    const int none = cols + 1;
    for (int dy = 0; dy <= dy_max; ++dy) {
        const float* row = corr_.data() + static_cast<std::size_t>(dy) * cols;
        int found = none;
        for (int dx = 0; dx <= dx_max; ++dx) {
            if (row[dx] < 0.5f) {
                found = dx;
                break;
            }
        }
        leftmost_[dy] = found;
    }

    order_.resize(dy_max + 1);
    std::iota(order_.begin(), order_.end(), 0);
    std::sort(order_.begin(), order_.end(), [this](int a, int b) {
        return leftmost_[a] != leftmost_[b] ? leftmost_[a] < leftmost_[b] : a < b;
    });

    PlacedPiece best = problem_.make_placed(piece_index, rotation_index, extent_ + kerf, kerf);
    double best_score = std::numeric_limits<double>::infinity();
    bool have_best = false;
    double best_x = 0.0, best_y = 0.0;

    int picked[kCandidates];
    int picked_count = 0;
    const int spacing = std::max(2, e.raster_rows / 4);
    for (int dy : order_) {
        if (picked_count >= kCandidates || leftmost_[dy] == none) break;
        bool close = false;
        for (int k = 0; k < picked_count; ++k) close = close || std::abs(picked[k] - dy) < spacing;
        if (close) continue;
        picked[picked_count++] = dy;

        double x = (leftmost_[dy] + m) * c;
        double y = std::clamp((dy + m) * c, kerf, wall_hi);
        collect_neighbors(shape, x, y, x + shape.w, y + shape.h, near_);
        ++stats_.clearance_probes;
        if (!position_free(shape, x, y, near_)) continue;  // Raster noise: exact geometry has the last word.
        x -= slide(shape, x, y, -1, 0, x - kerf);
        // Primary: how far the piece reaches along the roll. Secondary: keep its mass to the left,
        // which leaves a cleaner profile for the pieces that follow. Weights tuned on the presets.
        const double score = x + shape.w + 0.5 * (x + shape.center_x) + 1e-3 * y;
        if (score < best_score) {
            best_score = score;
            best_x = x;
            best_y = y;
            have_best = true;
        }
    }

    if (have_best) {
        compact(shape, best_x, best_y);
        best = problem_.make_placed(piece_index, rotation_index, best_x, best_y);
    } else {
        // Nothing free inside the horizon: open fresh roll past the current extent.
        double y = kerf;
        double x = extent_ + kerf;
        // Only a defect can be in the way out here: jump past it.
        for (int guard = 0; guard < 256; ++guard) {
            collect_neighbors(shape, x, y, x + shape.w, y + shape.h, near_);
            if (position_free(shape, x, y, near_)) break;
            double jump = x;
            for (int i : near_) jump = std::max(jump, placed_[i].x + placed_shapes_[i]->w + kerf);
            x = jump;
        }
        x -= slide(shape, x, y, -1, 0, x - kerf);
        best = problem_.make_placed(piece_index, rotation_index, x, y);
    }
    return best;
}

namespace {

double slide_along(const NestingProblem& problem, const PreparedShape& shape,
                   const std::vector<const PreparedShape*>& others, const std::vector<PlacedPiece>& placed,
                   const std::vector<int>& near, double x, double y, double dx, double dy, double max_dist,
                   double step) {
    const double kerf = problem.kerf() + kSlack;
    auto free_at = [&](double t) {
        const double px = x + dx * t;
        const double py = y + dy * t;
        for (int i : near) {
            if (!shapes_clear(shape, px, py, *others[i], placed[i].x, placed[i].y, kerf)) return false;
        }
        return true;
    };
    double t = 0.0;
    while (t < max_dist) {
        const double next = std::min(t + step, max_dist);
        if (free_at(next)) {
            t = next;
            continue;
        }
        // Bisect the last step down to well under the machine's positional accuracy.
        double lo = t, hi = next;
        for (int i = 0; i < 7; ++i) {
            const double mid = 0.5 * (lo + hi);
            if (free_at(mid)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return lo;
    }
    return t;
}

}  // namespace

void compact_layout(const NestingProblem& problem, Layout& layout, int passes) {
    const auto& pieces = problem.pieces();
    const double kerf = problem.kerf() + kSlack;
    const double wall = problem.roll_width() - kerf;

    const std::size_t real = layout.placed.size();
    std::vector<const PreparedShape*> shapes(real);
    for (std::size_t i = 0; i < real; ++i) {
        const PlacedPiece& p = layout.placed[i];
        shapes[i] = &pieces[p.piece_index].rotations[p.rotation_index];
    }
    // Defects ride along as fixed neighbours for the duration of the compaction.
    for (const Obstacle& o : problem.obstacles()) {
        PlacedPiece q;
        q.piece_index = -1;
        q.x = o.x;
        q.y = o.y;
        layout.placed.push_back(q);
        shapes.push_back(&o.shape);
    }

    std::vector<int> order(real);
    std::iota(order.begin(), order.end(), 0);
    std::vector<int> near;

    auto slide_piece = [&](int idx, double dx, double dy, double room) {
        PlacedPiece& p = layout.placed[idx];
        const PreparedShape& s = *shapes[idx];
        if (room <= 1e-9) return 0.0;
        const double ex = p.x + dx * room;
        const double ey = p.y + dy * room;
        const double lo_x = std::min(p.x, ex) - kerf - 1.0;
        const double hi_x = std::max(p.x, ex) + s.w + kerf + 1.0;
        const double lo_y = std::min(p.y, ey) - kerf - 1.0;
        const double hi_y = std::max(p.y, ey) + s.h + kerf + 1.0;
        near.clear();
        for (int j = 0; j < static_cast<int>(layout.placed.size()); ++j) {
            if (j == idx) continue;
            const PlacedPiece& q = layout.placed[j];
            if (q.x > hi_x || q.x + shapes[j]->w < lo_x || q.y > hi_y || q.y + shapes[j]->h < lo_y) continue;
            near.push_back(j);
        }
        return slide_along(problem, s, shapes, layout.placed, near, p.x, p.y, dx, dy, room, 4.0);
    };

    for (int pass = 0; pass < passes; ++pass) {
        std::sort(order.begin(), order.end(),
                  [&](int a, int b) { return layout.placed[a].x < layout.placed[b].x; });
        bool moved = false;
        for (int idx : order) {
            PlacedPiece& p = layout.placed[idx];
            const PreparedShape& s = *shapes[idx];
            const double start_x = p.x;
            p.x -= slide_piece(idx, -1, 0, p.x - kerf);
            // Side-step toward whichever side lets the piece travel further along the roll.
            double base_x = p.x, base_y = p.y, best_x = p.x, best_y = p.y;
            for (double dir : {-1.0, 1.0}) {
                p.x = base_x;
                p.y = base_y;
                const double room = dir < 0 ? p.y - kerf : wall - s.h - p.y;
                const double side = slide_piece(idx, 0, dir, std::min(room, 30.0));
                if (side <= 0.01) continue;
                p.y += dir * side;
                p.x -= slide_piece(idx, -1, 0, p.x - kerf);
                if (p.x < best_x - 0.05) {
                    best_x = p.x;
                    best_y = p.y;
                }
            }
            p.x = best_x;
            p.y = best_y;
            p.tx = p.x + s.norm_x;
            p.ty = p.y + s.norm_y;
            if (start_x - p.x > 0.05) moved = true;
        }
        if (!moved) break;
    }
    layout.placed.resize(real);
    layout.length_mm = problem.layout_length(layout.placed);
}

}  // namespace cutzero
