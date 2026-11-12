#include "fft2d.hpp"

#include <cmath>
#include <cstring>
#include <numbers>
#include <utility>

// Tells the compiler these loops carry no dependency, so it vectorises them.
#if defined(__clang__)
#define CUTZERO_IVDEP _Pragma("clang loop vectorize(enable)")
#elif defined(__GNUC__)
#define CUTZERO_IVDEP _Pragma("GCC ivdep")
#else
#define CUTZERO_IVDEP
#endif

namespace cutzero {

int next_power_of_two(int value) {
    int n = 1;
    while (n < value) n <<= 1;
    return n;
}

namespace {

std::vector<int> bit_reverse_table(int n) {
    std::vector<int> table(n);
    int bits = 0;
    while ((1 << bits) < n) ++bits;
    for (int i = 0; i < n; ++i) {
        int r = 0;
        for (int b = 0; b < bits; ++b) {
            if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        }
        table[i] = r;
    }
    return table;
}

void fill_twiddles(int n, std::vector<float>& re, std::vector<float>& im) {
    re.resize(n);
    im.resize(n);
    for (int k = 0; k < n; ++k) {
        const double angle = -2.0 * std::numbers::pi * k / n;
        re[k] = static_cast<float>(std::cos(angle));
        im[k] = static_cast<float>(std::sin(angle));
    }
}

}  // namespace

RealFFT2D::RealFFT2D(int rows, int cols)
    : rows_(rows), cols_(cols), half_(cols / 2 + 1), row_complex_(cols / 2) {
    rev_rows_ = bit_reverse_table(rows_);
    rev_row_complex_ = bit_reverse_table(row_complex_);
    fill_twiddles(rows_, tw_y_re_, tw_y_im_);
    fill_twiddles(row_complex_, tw_x_re_, tw_x_im_);
    fill_twiddles(cols_, tw_real_re_, tw_real_im_);
}

void RealFFT2D::fft_row_complex(float* re, float* im, bool inverse) const {
    const int n = row_complex_;
    for (int i = 0; i < n; ++i) {
        const int j = rev_row_complex_[i];
        if (i < j) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    const float sign = inverse ? -1.0f : 1.0f;
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1;
        const int stride = n / len;
        for (int start = 0; start < n; start += len) {
            for (int k = 0; k < half; ++k) {
                const float wr = tw_x_re_[k * stride];
                const float wi = sign * tw_x_im_[k * stride];
                const int a = start + k;
                const int b = a + half;
                const float tr = re[b] * wr - im[b] * wi;
                const float ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}

void RealFFT2D::fft_columns(float* re, float* im, bool inverse) const {
    const int n = rows_;
    const int width = half_;
    // Bit reversal is a row swap.
    CUTZERO_TLS std::vector<float> swap_buf;
    swap_buf.resize(width);
    for (int i = 0; i < n; ++i) {
        const int j = rev_rows_[i];
        if (i < j) {
            const std::size_t bytes = sizeof(float) * width;
            std::memcpy(swap_buf.data(), re + i * width, bytes);
            std::memcpy(re + i * width, re + j * width, bytes);
            std::memcpy(re + j * width, swap_buf.data(), bytes);
            std::memcpy(swap_buf.data(), im + i * width, bytes);
            std::memcpy(im + i * width, im + j * width, bytes);
            std::memcpy(im + j * width, swap_buf.data(), bytes);
        }
    }
    const float sign = inverse ? -1.0f : 1.0f;
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1;
        const int stride = n / len;
        for (int start = 0; start < n; start += len) {
            for (int k = 0; k < half; ++k) {
                const float wr = tw_y_re_[k * stride];
                const float wi = sign * tw_y_im_[k * stride];
                float* restrict_ar = re + (start + k) * width;
                float* restrict_ai = im + (start + k) * width;
                float* restrict_br = re + (start + k + half) * width;
                float* restrict_bi = im + (start + k + half) * width;
CUTZERO_IVDEP
                for (int x = 0; x < width; ++x) {
                    const float tr = restrict_br[x] * wr - restrict_bi[x] * wi;
                    const float ti = restrict_br[x] * wi + restrict_bi[x] * wr;
                    restrict_br[x] = restrict_ar[x] - tr;
                    restrict_bi[x] = restrict_ai[x] - ti;
                    restrict_ar[x] += tr;
                    restrict_ai[x] += ti;
                }
            }
        }
    }
}

void RealFFT2D::forward(const float* real_in, Spectrum& out) const {
    out.re.resize(spectrum_size());
    out.im.resize(spectrum_size());
    const int m = row_complex_;
    CUTZERO_TLS std::vector<float> zr, zi;
    zr.resize(m + 1);
    zi.resize(m + 1);

    for (int row = 0; row < rows_; ++row) {
        const float* in = real_in + static_cast<std::size_t>(row) * cols_;
        float* xr = out.re.data() + static_cast<std::size_t>(row) * half_;
        float* xi = out.im.data() + static_cast<std::size_t>(row) * half_;
        // Pack the real row into a half-length complex sequence.
        for (int i = 0; i < m; ++i) {
            zr[i] = in[2 * i];
            zi[i] = in[2 * i + 1];
        }
        fft_row_complex(zr.data(), zi.data(), false);
        zr[m] = zr[0];
        zi[m] = zi[0];
        // Unpack: X[k] = E[k] + W^k O[k].
        for (int k = 0; k <= m; ++k) {
            const float ar = zr[k], ai = zi[k];
            const float br = zr[m - k], bi = -zi[m - k];
            const float er = 0.5f * (ar + br), ei = 0.5f * (ai + bi);
            // O = -0.5i (Z[k] - conj Z[m-k])
            const float dr = ar - br, di = ai - bi;
            const float or_ = 0.5f * di, oi = -0.5f * dr;
            const float wr = k < cols_ ? tw_real_re_[k % cols_] : 1.0f;
            const float wi = k < cols_ ? tw_real_im_[k % cols_] : 0.0f;
            xr[k] = er + wr * or_ - wi * oi;
            xi[k] = ei + wr * oi + wi * or_;
        }
    }
    fft_columns(out.re.data(), out.im.data(), false);
}

void RealFFT2D::inverse(Spectrum& spec, float* out, int rows_needed) const {
    fft_columns(spec.re.data(), spec.im.data(), true);
    const int m = row_complex_;
    CUTZERO_TLS std::vector<float> zr, zi;
    zr.resize(m);
    zi.resize(m);
    const float norm = 1.0f / (static_cast<float>(rows_) * static_cast<float>(m));

    if (rows_needed > rows_) rows_needed = rows_;
    for (int row = 0; row < rows_needed; ++row) {
        const float* xr = spec.re.data() + static_cast<std::size_t>(row) * half_;
        const float* xi = spec.im.data() + static_cast<std::size_t>(row) * half_;
        float* o = out + static_cast<std::size_t>(row) * cols_;
        for (int k = 0; k < m; ++k) {
            const float ar = xr[k], ai = xi[k];
            const float br = xr[m - k], bi = -xi[m - k];
            const float er = 0.5f * (ar + br), ei = 0.5f * (ai + bi);
            const float dr = 0.5f * (ar - br), di = 0.5f * (ai - bi);
            // O[k] = W^{-k} * d. conj(W) has the negated imaginary part.
            const float wr = tw_real_re_[k];
            const float wi = -tw_real_im_[k];
            const float or_ = wr * dr - wi * di;
            const float oi = wr * di + wi * dr;
            // Z[k] = E[k] + i O[k]
            zr[k] = er - oi;
            zi[k] = ei + or_;
        }
        fft_row_complex(zr.data(), zi.data(), true);
        for (int i = 0; i < m; ++i) {
            o[2 * i] = zr[i] * norm;
            o[2 * i + 1] = zi[i] * norm;
        }
    }
}

void RealFFT2D::correlate(const Spectrum& a, const Spectrum& b, Spectrum& out) const {
    const std::size_t n = spectrum_size();
    out.re.resize(n);
    out.im.resize(n);
    const float* ar = a.re.data();
    const float* ai = a.im.data();
    const float* br = b.re.data();
    const float* bi = b.im.data();
    float* or_ = out.re.data();
    float* oi = out.im.data();
CUTZERO_IVDEP
    for (std::size_t i = 0; i < n; ++i) {
        or_[i] = ar[i] * br[i] + ai[i] * bi[i];
        oi[i] = ai[i] * br[i] - ar[i] * bi[i];
    }
}

void RealFFT2D::add_shifted_dilated(const Spectrum& piece, int shift_x, int shift_y, Spectrum& sheet) const {
    CUTZERO_TLS std::vector<float> fx_re, fx_im;
    fx_re.resize(half_);
    fx_im.resize(half_);
    const auto wrap = [](long long v, int n) { return static_cast<int>(((v % n) + n) % n); };

    // Per-frequency X factor: W^{k * sx} + W^{k * (sx + 1)}.
    for (int k = 0; k < half_; ++k) {
        const int i0 = wrap(static_cast<long long>(k) * shift_x, cols_);
        const int i1 = wrap(static_cast<long long>(k) * (shift_x + 1), cols_);
        fx_re[k] = tw_real_re_[i0] + tw_real_re_[i1];
        fx_im[k] = tw_real_im_[i0] + tw_real_im_[i1];
    }
    for (int l = 0; l < rows_; ++l) {
        const int j0 = wrap(static_cast<long long>(l) * shift_y, rows_);
        const int j1 = wrap(static_cast<long long>(l) * (shift_y + 1), rows_);
        const float yr = tw_y_re_[j0] + tw_y_re_[j1];
        const float yi = tw_y_im_[j0] + tw_y_im_[j1];

        const std::size_t base = static_cast<std::size_t>(l) * half_;
        const float* pr = piece.re.data() + base;
        const float* pi = piece.im.data() + base;
        float* sr = sheet.re.data() + base;
        float* si = sheet.im.data() + base;
        const float* xr = fx_re.data();
        const float* xi = fx_im.data();
CUTZERO_IVDEP
        for (int k = 0; k < half_; ++k) {
            const float tr = xr[k] * yr - xi[k] * yi;
            const float ti = xr[k] * yi + xi[k] * yr;
            sr[k] += pr[k] * tr - pi[k] * ti;
            si[k] += pr[k] * ti + pi[k] * tr;
        }
    }
}

}  // namespace cutzero
