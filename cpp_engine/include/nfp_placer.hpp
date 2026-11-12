// nfp_placer.hpp - problem model, the FFD baseline, and the hybrid FFT + vector placer.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "fft2d.hpp"
#include "geometry.hpp"

namespace cutzero {

struct Piece {
    int id = 0;
    std::string name;
    Polygon2D polygon;
    double area = 0.0;
    // One entry per rotation that physically fits on the roll.
    std::vector<PreparedShape> rotations;
};

// World position = R(rotation_deg) * vertex + (tx, ty).
struct PlacedPiece {
    int piece_index = 0;
    int rotation_index = 0;
    double rotation_deg = 0.0;
    double x = 0.0;  // lower-left of the rotated shape's bounding box
    double y = 0.0;
    double tx = 0.0;
    double ty = 0.0;
};

struct Layout {
    std::vector<PlacedPiece> placed;
    double length_mm = 0.0;
};

struct ValidationReport {
    bool valid = false;
    int violations = 0;
    double min_clearance_mm = 0.0;
    int pairs_checked = 0;
    // Pairs whose bounding boxes overlap yet whose material stays clear:
    // geometry a bounding-box packer can never produce.
    int interlocks = 0;
};

class NestingProblem {
public:
    NestingProblem(std::vector<Piece> pieces, double roll_width_mm, double kerf_mm,
                   std::vector<double> allowed_rotations_deg);

    const std::vector<Piece>& pieces() const { return pieces_; }
    double roll_width() const { return roll_width_mm_; }
    double kerf() const { return kerf_mm_; }
    double total_area_mm2() const { return total_area_mm2_; }
    const std::vector<double>& allowed_rotations() const { return rotations_; }

    // Empty when every piece has at least one rotation that fits; otherwise explains why not.
    const std::string& error() const { return error_; }

    PlacedPiece make_placed(int piece_index, int rotation_index, double x, double y) const;
    double layout_length(const std::vector<PlacedPiece>& placed) const;
    ValidationReport validate(const Layout& layout) const;

private:
    std::vector<Piece> pieces_;
    double roll_width_mm_;
    double kerf_mm_;
    double total_area_mm2_ = 0.0;
    std::vector<double> rotations_;
    std::string error_;
};

// Industry baseline: First-Fit Decreasing shelf packing of rectangular bounding boxes.
// Tries several rotation policies and sort keys and keeps the shortest layout, so the
// comparison is against the best this method can do, not a deliberately weak variant.
class BaselineBoundingBoxPlacer {
public:
    static Layout place(const NestingProblem& problem);
};

// Discretised strip plus the cached spectrum of every (piece, rotation) raster.
class FFTGrid {
public:
    FFTGrid(const NestingProblem& problem, int rows, double horizon_mm);

    // Computes spectra for one or all rotations; call before sharing across threads.
    void ensure_all();
    void ensure(int piece_index, int rotation_index);

    double cell_mm() const { return cell_; }
    int rows() const { return rows_; }
    int cols() const { return cols_; }
    int margin() const { return margin_; }
    const RealFFT2D& fft() const { return *fft_; }

    struct Entry {
        Spectrum spectrum;
        int raster_cols = 0;
        int raster_rows = 0;
        bool ready = false;
    };
    const Entry& entry(int piece_index, int rotation_index) const {
        return entries_[piece_index][rotation_index];
    }

    // Raster of a shape at a whole-cell offset, into a rows*cols buffer. Exposed for tests.
    void rasterize(const PreparedShape& shape, std::vector<float>& out, int& raster_cols, int& raster_rows) const;

private:
    const NestingProblem& problem_;
    int rows_;
    int cols_;
    double cell_;
    int margin_;
    std::unique_ptr<RealFFT2D> fft_;
    std::vector<std::vector<Entry>> entries_;
};

struct PlacerStats {
    long long ffts = 0;
    long long placements = 0;
    long long clearance_probes = 0;
    double fft_seconds = 0.0;
};

// Places pieces one at a time:
//   1. FFT cross-correlation finds every collision-free offset on the raster.
//   2. Leftmost pockets become candidates.
//   3. Exact vector sliding compacts each candidate against neighbouring geometry.
// Not thread safe: each annealing chain owns one placer. The grid is shared read-only.
class HybridFFTVectorPlacer {
public:
    HybridFFTVectorPlacer(const NestingProblem& problem, const FFTGrid& grid);

    // Decodes a genome. Placements before `first_changed` are reused from checkpoints.
    Layout decode(const std::vector<int>& sequence, const std::vector<int>& rotation,
                  int first_changed = 0);

    // Forgets checkpoints from `from` on, used after a rejected move overwrote them.
    void invalidate_from(int from);

    // Tries every rotation for each piece and returns the chosen rotations through `rotation`.
    Layout decode_greedy_rotation(const std::vector<int>& sequence, std::vector<int>& rotation);

    // Free-space map for a piece against an existing layout.
    // out[dy * cols + dx] is the correlation value: < 0.5 means collision-free.
    void correlation_map(const std::vector<PlacedPiece>& placed, int piece_index, int rotation_index,
                         std::vector<float>& out);

    // Local search on a finished layout: lifts the pieces that define the roll length out and
    // tries every rotation in every remaining pocket. Returns true if the layout got shorter.
    bool reinsert_critical(Layout& layout);

    const PlacerStats& stats() const { return stats_; }
    void reset_stats() { stats_ = {}; }

private:
    void reset();
    void place(int piece_index, int rotation_index);
    PlacedPiece find_position(int piece_index, int rotation_index);
    bool position_free(const PreparedShape& shape, double x, double y, const std::vector<int>& near) const;
    double slide(const PreparedShape& shape, double x, double y, double dir_x, double dir_y, double max_dist);
    void collect_neighbors(const PreparedShape& shape, double min_x, double min_y, double max_x, double max_y,
                           std::vector<int>& near) const;
    void compact(const PreparedShape& shape, double& x, double& y);
    void commit(const PlacedPiece& placed);

    const NestingProblem& problem_;
    const FFTGrid& grid_;

    std::vector<PlacedPiece> placed_;
    std::vector<const PreparedShape*> placed_shapes_;
    double extent_ = 0.0;
    Spectrum sheet_;

    // checkpoints_[i] holds the sheet spectrum after i pieces were placed.
    std::vector<Spectrum> checkpoints_;
    int checkpoints_valid_ = 0;
    std::vector<int> last_sequence_;
    std::vector<int> last_rotation_;

    Spectrum work_;
    std::vector<float> corr_;
    std::vector<int> leftmost_;
    std::vector<int> order_;
    std::vector<int> near_;

    PlacerStats stats_;
};

// Post-placement exact compaction: every piece repeatedly slides toward the origin.
void compact_layout(const NestingProblem& problem, Layout& layout, int passes);

}  // namespace cutzero
