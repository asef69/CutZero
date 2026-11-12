// fft2d.hpp - zero-dependency iterative Radix-2 2D real FFT.
//
// What makes it fast enough to run once per placed piece, per annealing iteration:
//   * Inputs are real, so only cols/2+1 frequency columns are stored.
//   * The Y pass runs butterflies across whole rows at once. That is
//     cache-friendly and lets the compiler vectorise it without intrinsics.
//   * Inverse transforms can stop early: only the rows a piece can legally be
//     placed in have to be recovered.
#pragma once

// Scratch buffers are per-thread natively; the single-threaded WebAssembly build has no TLS
// destructor support and does not need any.
#ifdef CUTZERO_NO_THREADS
#define CUTZERO_TLS static
#else
#define CUTZERO_TLS thread_local
#endif

#include <complex>
#include <vector>

namespace cutzero {

struct Spectrum {
    std::vector<float> re;
    std::vector<float> im;
    void resize(std::size_t n) {
        re.assign(n, 0.0f);
        im.assign(n, 0.0f);
    }
};

class RealFFT2D {
public:
    RealFFT2D(int rows, int cols);

    int rows() const { return rows_; }
    int cols() const { return cols_; }
    int half_cols() const { return half_; }
    std::size_t spectrum_size() const { return static_cast<std::size_t>(rows_) * half_; }

    // real_in holds rows*cols samples in row-major order.
    void forward(const float* real_in, Spectrum& out) const;

    // Transforms `spec` (destroyed) back to reals. Rows [0, rows_needed) of `out`
    // receive valid samples; the remaining rows are left untouched.
    void inverse(Spectrum& spec, float* out, int rows_needed) const;

    // out = a * conj(b): the spectrum of the circular cross-correlation.
    void correlate(const Spectrum& a, const Spectrum& b, Spectrum& out) const;

    // sheet += piece * (phase shift by (shift_x, shift_y)) * (1 + z_x)(1 + z_y).
    // The (1 + z) factors add copies at +1 cell in each axis, which keeps the raster
    // conservative when a part sits at a fractional cell offset. Linear in the sheet,
    // so a placement costs O(N) with no forward FFT at all.
    void add_shifted_dilated(const Spectrum& piece, int shift_x, int shift_y, Spectrum& sheet) const;

private:
    void fft_columns(float* re, float* im, bool inverse) const;
    void fft_row_complex(float* re, float* im, bool inverse) const;

    int rows_;
    int cols_;
    int half_;
    int row_complex_;  // cols/2: size of the packed complex FFT used for the X pass.

    std::vector<int> rev_rows_;
    std::vector<int> rev_row_complex_;
    std::vector<float> tw_y_re_, tw_y_im_;    // e^{-2 pi i k / rows}, k < rows
    std::vector<float> tw_x_re_, tw_x_im_;    // e^{-2 pi i k / row_complex}, k < row_complex
    std::vector<float> tw_real_re_, tw_real_im_;  // e^{-2 pi i k / cols}, k < cols
};

int next_power_of_two(int value);

}  // namespace cutzero
