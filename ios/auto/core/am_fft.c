/*
 * am_fft.c -- N-dimensional mixed-radix FFT. See am_fft.h for the rationale.
 *
 * ALGORITHM
 *   1D, length n:
 *     - n a power of two -> iterative radix-2 decimation-in-time, bit-reversal
 *       permutation first.
 *     - n <= 5           -> direct DFT.
 *     - otherwise        -> Cooley-Tukey with radix r (a prime factor of n,
 *                           2..5): gather the r decimated subsequences, run an
 *                           m = n/r point transform on each, recombine with
 *                           twiddles.
 *   N-D: transform along each dimension in turn.
 *
 * SIGN CONVENTION
 *   Every kernel here computes the FORWARD transform only, with
 *   W = e^{-2*pi*i/n}. The inverse is obtained by conjugation:
 *       IFFT(x) = conj(FFT(conj(x))) / N
 *   so there is exactly one place where a sign appears, and no second set of
 *   twiddles to keep in sync.
 *
 * STORAGE
 *   Complex values are INTERLEAVED as re,im,re,im,... (am_cplx is one double,
 *   not a struct). Therefore n complex values occupy 2*n doubles. Sizing a
 *   complex buffer as `n * sizeof(am_cplx)` silently allocates half of what is
 *   needed -- always use AM_CPLX_BYTES().
 *
 * LAYOUT LESSON (this cost several hours; do not "simplify" it away)
 *   1. Cooley-Tukey can be written with an explicit "reshape the buffer into
 *      contiguous blocks" pass or with explicit index arithmetic. The reshape
 *      version has two independent index formulas (where element k lands, and
 *      where each sub-transform reads), and BOTH silently coincide with the
 *      correct ones whenever m == r -- that is, for every power-of-two length.
 *      Bugs there are invisible until the first composite length. This file
 *      therefore uses explicit indices only, treating the scratch as a plain
 *      r-by-m matrix.
 *   2. The N-dimensional driver must distinguish the SLOW end of the dimension
 *      list (which it loops over) from the FAST end (which supplies the stride).
 *      Carrying one scalar stride and advancing it with `sub = stride * shape[0]`
 *      while also looping over shape[0] uses shape[0] for both ends at once; the
 *      result transforms along the same axis twice and a 2D transform
 *      degenerates into a single 1D pass. Strides are precomputed as suffix
 *      products instead -- see compute_strides().
 *   3. Each dimension needs its OWN twiddle table. A table is indexed with a
 *      stride of table_len/m, so a single total-size table makes every lookup in
 *      the N-D case wrong by the ratio of the dimension sizes.
 */

#include "am_fft.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define AM_MAX_RADIX 5

struct am_tw {
    int     len;            /* transform length this table serves */
    double *re;             /* cos, tw[k] = cos(-2*pi*k/len), k in [0, len+2) */
    double *im;             /* sin */
};

struct am_fft_plan {
    int          d;             /* number of dimensions */
    int          shape[8];      /* per-dimension length, shape[0] slowest */
    int          n;             /* total element count */
    struct am_tw tw[8];         /* tw[i] serves dimension i */
};

/* ------------------------------------------------------------------ *
 * allocation
 * ------------------------------------------------------------------ */

static void *am_malloc(size_t n)
{
    return malloc(n);
}

static void am_free(void *p)
{
    free(p);
}

/* n_complex COMPLEX values == 2*n_complex doubles. */
static void *am_alloc_cplx(size_t n_complex)
{
    if (n_complex > (size_t)-1 / (2 * sizeof(am_cplx))) return NULL;
    return am_malloc(n_complex * 2 * sizeof(am_cplx));
}

/* ------------------------------------------------------------------ *
 * twiddles
 * ------------------------------------------------------------------ */

/* A table must hold len+2 entries, NOT len/2+2. tw[k] = e^{-2*pi*i*k/len} is
 * indexed for k anywhere in [0, len): W() maps an arbitrary (k, m) pair onto
 * [0, len) and the radix-2 butterfly stage reaches t = len/2. Allocating only
 * len/2+2 let those reads run off the end of the heap block, which surfaced as a
 * corrupted heap (or a bare access violation) nowhere near the allocation. */
static int plan_dim_twiddles(struct am_tw *t, int len)
{
    const size_t need = (size_t)len + 2;
    t->len = len;
    t->re = (double *)am_malloc(need * sizeof(double));
    t->im = (double *)am_malloc(need * sizeof(double));
    if (!t->re || !t->im) return -1;

    for (size_t k = 0; k < need; k++) {
        const double a = -2.0 * M_PI * (double)k / (double)len;
        t->re[k] = cos(a);
        t->im[k] = sin(a);
    }
    return 0;
}

static int plan_twiddles(am_fft_plan *p)
{
    for (int i = 0; i < p->d; i++) {
        if (plan_dim_twiddles(&p->tw[i], p->shape[i]) != 0) return -1;
    }
    return 0;
}

/* e^{-2*pi*i*k/m}. Requires m to divide t->len so the table can be indexed
 * directly as tw[(k mod m) * (len/m)]. */
static void W(const struct am_tw *t, long k, int m, double *re, double *im)
{
    long idx = k % m;
    if (idx < 0) idx += m;

    const long step = (long)t->len / (long)m;
    long i = (idx * step) % (long)t->len;
    if (i < 0) i += (long)t->len;

    *re = t->re[i];
    *im = t->im[i];
}

/* ------------------------------------------------------------------ *
 * direct DFT for tiny lengths
 * ------------------------------------------------------------------ */

static void dft_small(const struct am_tw *tw, am_cplx *x, int n)
{
    if (n <= 1) return;

    if (n == 2) {
        const double p0 = x[0], q0 = x[1];
        const double p1 = x[2], q1 = x[3];
        x[0] = p0 + p1; x[1] = q0 + q1;
        x[2] = p0 - p1; x[3] = q0 - q1;
        return;
    }

    /* 2*n doubles: the scratch is interleaved just like the input. Declaring
     * `am_cplx tmp[5]` here is a 2x under-allocation that corrupts the stack. */
    am_cplx tmp[2 * AM_MAX_RADIX];
    for (int k = 0; k < n; k++) {
        double sr = 0.0, si = 0.0;
        for (int j = 0; j < n; j++) {
            double wr, wi;
            W(tw, (long)j * (long)k, n, &wr, &wi);
            const double ar = x[2 * j], ai = x[2 * j + 1];
            sr += ar * wr - ai * wi;
            si += ar * wi + ai * wr;
        }
        tmp[2 * k]     = sr;
        tmp[2 * k + 1] = si;
    }
    for (int k = 0; k < n; k++) {
        x[2 * k]     = tmp[2 * k];
        x[2 * k + 1] = tmp[2 * k + 1];
    }
}

/* ------------------------------------------------------------------ *
 * radix-2 DIT, power-of-two lengths, forward, adjacency assumed
 * ------------------------------------------------------------------ */

static void fft_pow2(const struct am_tw *tw, am_cplx *a, int n)
{
    if (n <= 1) return;
    if (n == 2) {
        /* Exactly two complex values. Do not touch a[4] or beyond -- callers
         * hand out a run inside a larger buffer. */
        const double p0 = a[0], q0 = a[1];
        const double p1 = a[2], q1 = a[3];
        a[0] = p0 + p1; a[1] = q0 + q1;
        a[2] = p0 - p1; a[3] = q0 - q1;
        return;
    }

    /* bit-reversal permutation */
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j |= bit;
        if (i < j) {
            const double tr = a[2 * i], ti = a[2 * i + 1];
            a[2 * i]     = a[2 * j];
            a[2 * i + 1] = a[2 * j + 1];
            a[2 * j]     = tr;
            a[2 * j + 1] = ti;
        }
    }

    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1;
        const long tstep = (long)tw->len / (long)len;
        for (int i = 0; i < n; i += len) {
            for (int j = 0; j < half; j++) {
                const long t = (long)j * tstep;
                const double wr = tw->re[t], wi = tw->im[t];

                am_cplx *lo = a + 2 * (i + j);
                am_cplx *hi = a + 2 * (i + j + half);

                const double ur = lo[0], ui = lo[1];
                const double xr = hi[0], xi = hi[1];

                const double vr = xr * wr - xi * wi;
                const double vi = xr * wi + xi * wr;

                lo[0] = ur + vr; lo[1] = ui + vi;
                hi[0] = ur - vr; hi[1] = ui - vi;
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * general 1D transform, possibly strided
 * ------------------------------------------------------------------ */

static void am_fft_1d_kernel(const struct am_tw *tw, am_cplx *data, int n,
                             size_t stride)
{
    if (n <= 1) return;

    /* stride 1 means the n values are already adjacent, so the kernels can work
     * in place; anything else is gathered into a scratch first. (There used to
     * be a separate `contig` flag here. It was always equal to stride == 1, and
     * carrying both invited them to disagree.) */
    const int adjacent = (stride == 1);

    /* --- power of two --- */
    if ((n & (n - 1)) == 0) {
        if (adjacent) {
            fft_pow2(tw, data, n);
            return;
        }
        am_cplx *own = (am_cplx *)am_alloc_cplx((size_t)n);
        if (!own) return;
        for (int i = 0; i < n; i++) {
            own[2 * i]     = data[2 * (size_t)i * stride];
            own[2 * i + 1] = data[2 * (size_t)i * stride + 1];
        }
        fft_pow2(tw, own, n);
        for (int i = 0; i < n; i++) {
            data[2 * (size_t)i * stride]     = own[2 * i];
            data[2 * (size_t)i * stride + 1] = own[2 * i + 1];
        }
        am_free(own);
        return;
    }

    /* --- tiny --- */
    if (n <= AM_MAX_RADIX) {
        am_cplx tmp[2 * AM_MAX_RADIX];
        am_cplx *work = data;
        if (!adjacent) {
            for (int i = 0; i < n; i++) {
                tmp[2 * i]     = data[2 * (size_t)i * stride];
                tmp[2 * i + 1] = data[2 * (size_t)i * stride + 1];
            }
            work = tmp;
        }
        dft_small(tw, work, n);
        if (!adjacent) {
            for (int i = 0; i < n; i++) {
                data[2 * (size_t)i * stride]     = tmp[2 * i];
                data[2 * (size_t)i * stride + 1] = tmp[2 * i + 1];
            }
        }
        return;
    }

    /* --- Cooley-Tukey, radix r --- */
    int r = 0;
    for (int k = 2; k <= AM_MAX_RADIX; k++) {
        if (n % k == 0) { r = k; break; }
    }
    if (r == 0) return;             /* plan creation rejects such lengths */

    const int m = n / r;

    /* Scratch is a plain r-by-m matrix of complex values; subsequence s occupies
     * [s*m, s*m + m). */
    am_cplx *sub = (am_cplx *)am_alloc_cplx((size_t)n);
    if (!sub) return;

    for (int s = 0; s < r; s++) {
        am_cplx *dst = sub + 2 * (size_t)s * (size_t)m;
        for (int i = 0; i < m; i++) {
            /* Subsequence s is data[s], data[s+r], data[s+2r], ... -- a hop of
             * r, not 1. Reading consecutive elements here transforms the wrong
             * data whenever r > 1. */
            const size_t src = (size_t)s + (size_t)r * (size_t)i;
            dst[2 * i]     = data[2 * src * stride];
            dst[2 * i + 1] = data[2 * src * stride + 1];
        }
    }

    /* the m-point transform of every subsequence, in place, adjacency restored */
    for (int s = 0; s < r; s++) {
        am_fft_1d_kernel(tw, sub + 2 * (size_t)s * (size_t)m, m, 1);
    }

    /* Recombine:
     *     X[k] = sum_s W_n^{s k} * (m-point transform of subsequence s)[k mod m]
     * For each k = j*m + i the scales are W_n^{s(j*m+i)} = T_s^j * A_s, where
     * T_s = W_n^{s m} = W_r^s and A_s = W_n^{s i}. Below, the T_s part is an
     * r-point transform over s for each fixed pair (j, i), and the A_s part is
     * shared by the whole row i -- so A_s is built once per i by the recurrence
     * A_s = A_{s-1} * W_n^i.
     *
     * Note the exponent is W_n^{s k}, NOT W_n^{s i}: the two differ whenever
     * s != 0, and the i form reproduces X[0] exactly while getting every other
     * output wrong. */
    am_cplx *out = (am_cplx *)am_alloc_cplx((size_t)n);
    if (!out) {
        am_free(sub);
        return;
    }
    memset(out, 0, (size_t)n * 2 * sizeof(am_cplx));   /* accumulated into */

    for (int i = 0; i < m; i++) {
        double ar = 1.0, ai = 0.0;              /* A_0 */
        double air = 1.0, aii = 0.0;            /* W_n^i, the A_s step */
        if (i != 0) W(tw, (long)i, n, &air, &aii);

        for (int s = 0; s < r; s++) {
            if (s != 0) {
                const double na = ar * air - ai * aii;
                const double nb = ar * aii + ai * air;
                ar = na; ai = nb;
            }

            const am_cplx *ys = sub + 2 * ((size_t)s * (size_t)m + (size_t)i);
            const double yr = ys[0], yi = ys[1];

            const double base_r = yr * ar - yi * ai;    /* y_s[i] * A_s */
            const double base_i = yr * ai + yi * ar;

            double tr = 1.0, ti = 0.0;                  /* T_s^j */
            double tsr = 1.0, tsi = 0.0;                /* W_n^m, the T step */
            if (s != 0) W(tw, (long)s * (long)m, n, &tsr, &tsi);

            for (int j = 0; j < r; j++) {
                if (j != 0) {
                    const double nt = tr * tsr - ti * tsi;
                    const double nu = tr * tsi + ti * tsr;
                    tr = nt; ti = nu;
                }
                const size_t idx = (size_t)j * (size_t)m + (size_t)i;
                out[2 * idx]     += base_r * tr - base_i * ti;
                out[2 * idx + 1] += base_r * ti + base_i * tr;
            }
        }
    }

    for (int i = 0; i < n; i++) {
        data[2 * (size_t)i * stride]     = out[2 * i];
        data[2 * (size_t)i * stride + 1] = out[2 * i + 1];
    }

    am_free(out);
    am_free(sub);
}

/* ------------------------------------------------------------------ *
 * N-dimensional driver
 * ------------------------------------------------------------------ */

static int am_is_pow2(int n) { return n > 0 && (n & (n - 1)) == 0; }

/* Run one axis line of a mixed-radix length.
 *
 * The kernel's Cooley-Tukey recombination needs a real 1-D plan, but it never
 * reads anything from the plan except the borrowed twiddle table -- whose
 * `len` already equals this axis's length, because every dimension owns its own
 * table. So a stack copy that aliases the table is enough, and nothing here may
 * free it. */
static void am_fft_1d_axis(const struct am_tw *tw, am_cplx *data, int n, size_t stride)
{
    am_fft_plan tmp;
    memset(&tmp, 0, sizeof(tmp));
    tmp.d = 1;
    tmp.n = n;
    tmp.shape[0] = n;
    tmp.tw[0] = *tw;                    /* borrow -- not owned by tmp */

    am_fft_1d_kernel(&tmp.tw[0], data, n, stride);
}

/* Row-major strides for a shape given slowest-dimension-first: stride[i] is the
 * distance in complex values between neighbours along dimension i, i.e. the
 * product of every dimension AFTER i. The last dimension therefore has stride 1
 * (its neighbours are adjacent). */
static void compute_strides(const int *shape, int d, size_t *stride)
{
    size_t acc = 1;
    for (int i = d - 1; i >= 0; i--) {
        stride[i] = acc;
        acc *= (size_t)shape[i];
    }
}

/* N-dimensional driver: an N-dimensional DFT is *separable* -- it is exactly a
 * 1-D transform along every axis in turn, in any order. So this is a plain
 * nested loop over axes, not a recursion.
 *
 * Index model (row major, axis 0 slowest). For axis `ax` an element is
 *     index = lo + ln*est + hi*len*est
 * with est = stride[ax], ln in [0, len) the index ALONG the axis, lo in [0, est)
 * enumerating every combination of the faster axes, and hi enumerating the
 * slower axes. So the line offsets are `hi*len*est + lo` for every (hi, lo) --
 * that is `total/len` lines altogether, each visited exactly once.
 *
 * ★ The hi term is `hi*len*est`, NOT `hi*est`: the slower axes move through the
 * buffer in jumps of `len*est` because the axis itself occupies a whole span of
 * `len*est` elements. Writing `hi*est` yields a set of offsets that is still the
 * right SIZE and, when est == 1, still the right SET -- which is why it passes
 * every 1-D test and every 2-D test where the fast axis is transformed first,
 * and only breaks for a slow axis with est > 1.
 *
 * ★ Five wrong versions preceded this one; each visited some line twice (it got
 * transformed twice, giving a plausible but wrong answer) or skipped one.
 * Enumerating (hi, lo) explicitly removes both possibilities. */
static void am_fft_nd(const struct am_tw *tw, am_cplx *data, int d,
                      const int *shape, const size_t *stride)
{
    size_t total = 1;
    for (int i = 0; i < d; i++) total *= (size_t)shape[i];

    for (int ax = 0; ax < d; ax++) {
        const int len = shape[ax];
        if (len <= 1) continue;

        const size_t est = stride[ax];
        const size_t quanta = total / ((size_t)len * est);

        for (size_t hi = 0; hi < quanta; hi++) {
            const size_t hi_base = hi * (size_t)len * est;
            for (size_t lo = 0; lo < est; lo++) {
                if (am_is_pow2(len)) {
                    am_fft_1d_kernel(&tw[ax], data + 2 * (hi_base + lo), len, est);
                } else {
                    /* Mixed-radix path: give it a real 1-D plan so that scratch
                     * and twiddles come from the dimension's own table. This is
                     * what lets the padding be a 5-smooth size such as 648x512
                     * instead of 1024x1024, which is a 3.1x saving over the
                     * whole transform. */
                    am_fft_1d_axis(&tw[ax], data + 2 * (hi_base + lo), len, est);
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

am_fft_plan *am_fft_plan_create(const int *shape, int d)
{
    if (!shape || d <= 0 || d > 8) return NULL;

    int n = 1;
    for (int i = 0; i < d; i++) {
        if (shape[i] <= 0) return NULL;

        int t = shape[i];
        for (int k = 2; k <= AM_MAX_RADIX; k++) {
            while (t % k == 0) t /= k;
        }
        if (t != 1) return NULL;            /* prime factor > 5 */

        if (n > (1 << 28) / shape[i]) return NULL;
        n *= shape[i];
    }

    am_fft_plan *p = (am_fft_plan *)am_malloc(sizeof(*p));
    if (!p) return NULL;
    memset(p, 0, sizeof(*p));
    p->d = d;
    p->n = n;
    for (int i = 0; i < d; i++) p->shape[i] = shape[i];

    if (plan_twiddles(p) != 0) {
        am_fft_plan_destroy(p);
        return NULL;
    }
    return p;
}

void am_fft_plan_destroy(am_fft_plan *p)
{
    if (!p) return;
    for (int i = 0; i < p->d; i++) {
        am_free(p->tw[i].re);
        am_free(p->tw[i].im);
    }
    am_free(p);
}

int am_fft_execute(am_fft_plan *p, am_cplx *data, int inverse)
{
    if (!p || !data) return -1;

    size_t stride[8];
    compute_strides(p->shape, p->d, stride);

    if (!inverse) {
        am_fft_nd(p->tw, data, p->d, p->shape, stride);
        return 0;
    }

    /* conj -> forward -> scale by 1/N, conjugate again */
    const int n = p->n;
    for (int i = 0; i < n; i++) data[2 * i + 1] = -data[2 * i + 1];
    am_fft_nd(p->tw, data, p->d, p->shape, stride);
    const double inv = 1.0 / (double)n;
    for (int i = 0; i < n; i++) {
        data[2 * i]     *= inv;
        data[2 * i + 1] *= -inv;
    }
    return 0;
}

int am_fft_1d(am_cplx *data, int n, int inverse)
{
    if (n <= 0) return -1;
    if (n == 1) return 0;

    am_fft_plan *p = am_fft_plan_create(&n, 1);
    if (!p) return -1;
    const int rc = am_fft_execute(p, data, inverse);
    am_fft_plan_destroy(p);
    return rc;
}

int am_fft_2d(am_cplx *data, int n1, int n2, int inverse)
{
    if (n1 <= 0 || n2 <= 0) return -1;

    int shape[2];
    shape[0] = n1;
    shape[1] = n2;

    am_fft_plan *p = am_fft_plan_create(shape, 2);
    if (!p) return -1;
    const int rc = am_fft_execute(p, data, inverse);
    am_fft_plan_destroy(p);
    return rc;
}

int am_fft_next_fast_size(int n)
{
    /* Deliberately powers of two, NOT the smallest 5-smooth number. Measured on
     * this machine (Windows, scalar C, /O2), a 2048x2048 power-of-two transform
     * (4.19M points) runs in 134 ms while a 1080x1920 mixed-radix transform
     * (2.07M points) takes 332 ms -- the radix-2 path is roughly 11x faster per
     * element, so padding up to a power of two always wins for the N-D sizes the
     * matcher uses. See the note in am_fft.h for the full table. */
    if (n <= 1) return 1;
    int p = 1;
    while (p < n) {
        if (p > (1 << 28)) return -1;
        p <<= 1;
    }
    return p;
}

