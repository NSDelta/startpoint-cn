/* test_fft.c 鈥斺€?am_fft 鐨勬纭€ч獙璇? *
 * 绛栫暐锛氫笌銆岀洿鎺?DFT銆嶉€愬厓绱犲姣斻€侳FT 鏈€瀹规槗閿欑殑涓嶆槸閫熷害鑰屾槸绱㈠紩涓庣鍙凤紝
 * 鎵€浠ュ弬鑰冨疄鐜板氨鐢ㄦ渶绗ㄧ殑 O(n^2) 瀹氫箟寮忥紝闀垮害瑕嗙洊 2 鐨勫箓 / 3 鐨勫箓 / 5 鐨勫箓 / 娣峰悎鍩恒€? *
 * 鍙﹀楠岃瘉銆屽嵎绉畾鐞嗐€嶁€斺€旇繖鏄悗闈?NCC 鍖归厤鐪熸渚濊禆鐨勬€ц川锛? *   IFFT(FFT(a) .* FFT(b)) == 寰幆鍗风Н(a, b)
 */
#include "am_fft.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#ifdef PG_TRACE
#include "pg_guard.h"
#endif

#ifdef _WIN32
#include <windows.h>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int g_pass = 0, g_fail = 0;

static void ok(const char *what)
{
    g_pass++;
    printf("  PASS %s\n", what);
}

static void bad(const char *what, const char *detail)
{
    g_fail++;
    printf("  FAIL %s%s%s\n", what, detail ? " -- " : "", detail ? detail : "");
}

/* 纭畾鎬т吉闅忔満锛堜笉鐢?rand()锛屼繚璇佽法骞冲彴鍙鐜帮級 */
static unsigned g_seed = 12345u;
static double frand(void)
{
    g_seed = g_seed * 1103515245u + 12345u;
    return ((double)((g_seed >> 8) & 0xFFFFFF) / 8388608.0) - 1.0;
}

/* ---------- 鍙傝€冿細鐩存帴 DFT锛堝畾涔夊紡锛?---------- */

static void ref_dft(const double *in_re, const double *in_im, int n,
                    double *out_re, double *out_im, int inverse)
{
    const double sgn = inverse ? 1.0 : -1.0;
    const double scale = inverse ? 1.0 / n : 1.0;
    for (int k = 0; k < n; k++) {
        double sr = 0.0, si = 0.0;
        for (int j = 0; j < n; j++) {
            const double a = sgn * 2.0 * M_PI * (double)j * (double)k / (double)n;
            const double c = cos(a), s = sin(a);
            sr += in_re[j] * c - in_im[j] * s;
            si += in_re[j] * s + in_im[j] * c;
        }
        out_re[k] = sr * scale;
        out_im[k] = si * scale;
    }
}

/* 閫愬厓绱犲姣旓紝杩斿洖鏈€澶х粷瀵硅宸€? * 鈽?娉ㄦ剰 a 鏄?*浜ら敊**缂撳啿锛坅[2i]=瀹為儴, a[2i+1]=铏氶儴锛夛紝b 鏄垎绂荤紦鍐诧紙br[i], bi[i]锛夈€? *   涓よ竟绱㈠紩鏂瑰紡涓嶅悓锛屽埆鍐欐垚鍚屼竴涓?i 鈥斺€?杩欎釜閿欎細璁┿€屾墦鍗板嚭鏉ュ畬鍏ㄤ竴鏍风殑涓や釜鏁扮粍銆? *   鎶ュ嚭宸ㄥぇ璇樊锛岀櫧璐逛竴杞帓鏌ャ€?*/
static double max_err_cplx(const double *a, const double *br, const double *bi, int n)
{
    double m = 0.0;
    for (int i = 0; i < n; i++) {
        const double dr = fabs(a[2 * i] - br[i]);
        const double di = fabs(a[2 * i + 1] - bi[i]);
        if (dr > m) m = dr;
        if (di > m) m = di;
    }
    return m;
}

/* ---------- 1D锛氫笌鐩存帴 DFT 瀵规瘮 ---------- */

static void test_1d_length(int n)
{
    am_cplx *x = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    double *ir = (double *)malloc((size_t)n * sizeof(double));
    double *ii = (double *)malloc((size_t)n * sizeof(double));
    double *rr = (double *)malloc((size_t)n * sizeof(double));
    double *ri = (double *)malloc((size_t)n * sizeof(double));
    if (!x || !ir || !ii || !rr || !ri) { bad("alloc", NULL); return; }

    for (int i = 0; i < n; i++) {
        ir[i] = frand() * 10.0;
        ii[i] = frand() * 10.0;
        x[2 * i] = ir[i];
        x[2 * i + 1] = ii[i];
    }

    char label[96];

    /* 姝ｅ彉鎹?*/
    if (am_fft_1d(x, n, 0) != 0) {
        snprintf(label, sizeof(label), "n=%d plan rejected", n);
        bad(label, NULL);
    } else {
        ref_dft(ir, ii, n, rr, ri, 0);
        const double e = max_err_cplx(x, rr, ri, n);
        snprintf(label, sizeof(label), "1D forward n=%-5d vs direct DFT  (max err %.2e)", n, e);
        if (e < 1e-8 * n) ok(label);
        else bad(label, "too large");
    }

    /* 閫嗗彉鎹㈠線杩?*/
    for (int i = 0; i < n; i++) { x[2 * i] = ir[i]; x[2 * i + 1] = ii[i]; }
#ifdef PG_TRACE
    {
        unsigned long long v = 0;
        memcpy(&v, (unsigned char *)x + AM_CPLX_BYTES((size_t)n), sizeof(v));
        fprintf(stderr, "[test] n=%d canary@%zu before round-trip = 0x%016llX\n",
                n, AM_CPLX_BYTES((size_t)n), v);
    }
#endif
    am_fft_1d(x, n, 0);
#ifdef PG_TRACE
    {
        unsigned long long v = 0;
        memcpy(&v, (unsigned char *)x + AM_CPLX_BYTES((size_t)n), sizeof(v));
        fprintf(stderr, "[test] n=%d canary after fwd = 0x%016llX\n", n, v);
    }
#endif
    am_fft_1d(x, n, 1);
#ifdef PG_TRACE
    {
        unsigned long long v = 0;
        memcpy(&v, (unsigned char *)x + AM_CPLX_BYTES((size_t)n), sizeof(v));
        fprintf(stderr, "[test] n=%d canary after inv = 0x%016llX\n", n, v);
    }
#endif

    {
        double m = 0.0;
        for (int i = 0; i < n; i++) {
            const double dr = fabs(x[2 * i] - ir[i]);
            const double di = fabs(x[2 * i + 1] - ii[i]);
            if (dr > m) m = dr;
            if (di > m) m = di;
        }
        snprintf(label, sizeof(label), "1D round-trip n=%-5d          (max err %.2e)", n, m);
        if (m < 1e-10 * n) ok(label); else bad(label, "round-trip lost precision");
    }

    free(x);
#ifdef PG_TRACE
    fprintf(stderr, "[test] freed x (n=%d, x=%p, bytes=%zu)\n", n, (void *)x, AM_CPLX_BYTES((size_t)n));
#endif
    free(ir); free(ii); free(rr); free(ri);
}

/* ---------- 2D锛氫笌鐩存帴 2D DFT 瀵规瘮锛堝皬灏哄锛?---------- */

static void test_2d(int n1, int n2)
{
    const int n = n1 * n2;
    am_cplx *x = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    double *rr = (double *)malloc((size_t)n * sizeof(double));
    double *ri = (double *)malloc((size_t)n * sizeof(double));
    double *tr = (double *)malloc((size_t)n * sizeof(double));
    double *ti = (double *)malloc((size_t)n * sizeof(double));
    if (!x || !rr || !ri || !tr || !ti) { bad("alloc 2d", NULL); return; }

    for (int i = 0; i < n; i++) { x[2 * i] = frand(); x[2 * i + 1] = frand(); }

    /* Keep the input: am_fft_2d transforms in place, and the round-trip check
     * below must compare against the ORIGINAL values. (It used to snapshot the
     * buffer after the forward transform and compare the inverse against that,
     * which can never match -- the test was wrong, not the transform.) */
    for (int i = 0; i < n; i++) { tr[i] = x[2 * i]; ti[i] = x[2 * i + 1]; }

    /* 鍙傝€冿細鎸夊畾涔夊紡绠?2D DFT锛堣涓诲簭锛宨0 鏈€鎱級 */
    for (int k0 = 0; k0 < n1; k0++) {
        for (int k1 = 0; k1 < n2; k1++) {
            double sr = 0.0, si = 0.0;
            for (int j0 = 0; j0 < n1; j0++) {
                for (int j1 = 0; j1 < n2; j1++) {
                    const double a = -2.0 * M_PI * ((double)j0 * k0 / n1 + (double)j1 * k1 / n2);
                    const double c = cos(a), s = sin(a);
                    const double ar = x[2 * (j0 * n2 + j1)];
                    const double ai = x[2 * (j0 * n2 + j1) + 1];
                    sr += ar * c - ai * s;
                    si += ar * s + ai * c;
                }
            }
            rr[k0 * n2 + k1] = sr;
            ri[k0 * n2 + k1] = si;
        }
    }

    if (am_fft_2d(x, n1, n2, 0) != 0) {
        bad("2d plan rejected", NULL);
    } else {
        const double e = max_err_cplx(x, rr, ri, n);
        char label[96];
        snprintf(label, sizeof(label), "2D forward %dx%d vs direct 2D DFT (max err %.2e)", n1, n2, e);
        if (e < 1e-8 * n) ok(label); else bad(label, "too large");
    }

    /* round trip: forward then inverse must reproduce the original input */
    am_fft_2d(x, n1, n2, 1);
    {
        double m = 0.0;
        for (int i = 0; i < n; i++) {
            const double dr = fabs(x[2 * i] - tr[i]);
            const double di = fabs(x[2 * i + 1] - ti[i]);
            if (dr > m) m = dr;
            if (di > m) m = di;
        }
        char label[96];
        snprintf(label, sizeof(label), "2D fwd+inv %dx%d round-trip        (max err %.2e)", n1, n2, m);
        if (m < 1e-10 * n) ok(label); else bad(label, "round-trip lost precision");
    }

    free(x); free(rr); free(ri); free(tr); free(ti);
}

/* ---------- 鍗风Н瀹氱悊锛圢CC 鍖归厤渚濊禆杩欐潯锛?---------- */

static void test_convolution(void)
{
    const int n1 = 12, n2 = 16;
    const int n = n1 * n2;
    am_cplx *a = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    am_cplx *b = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    am_cplx *c = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    am_cplx *ra = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    am_cplx *rb = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    if (!a || !b || !c || !ra || !rb) { bad("alloc conv", NULL); return; }

    for (int i = 0; i < n; i++) {
        a[2 * i] = frand(); a[2 * i + 1] = 0.0;
        b[2 * i] = frand(); b[2 * i + 1] = 0.0;
    }
    /* Keep untouched copies for the reference: am_fft_2d transforms in place,
     * and reading a/b after the transforms below silently makes the reference
     * compare the transform against itself. */
    memcpy(ra, a, AM_CPLX_BYTES((size_t)n));
    memcpy(rb, b, AM_CPLX_BYTES((size_t)n));

    /* C = IFFT(FFT(a) .* FFT(b)) */
    am_fft_2d(a, n1, n2, 0);
    am_fft_2d(b, n1, n2, 0);
    for (int i = 0; i < n; i++) {
        const double ar = a[2 * i], ai = a[2 * i + 1];
        const double br = b[2 * i], bi = b[2 * i + 1];
        c[2 * i]     = ar * br - ai * bi;
        c[2 * i + 1] = ar * bi + ai * br;
    }
    am_fft_2d(c, n1, n2, 1);

    /* 鍙傝€冿細寰幆鍗风Н */
    double m = 0.0;
    for (int k0 = 0; k0 < n1; k0++) {
        for (int k1 = 0; k1 < n2; k1++) {
            double sr = 0.0;
            for (int j0 = 0; j0 < n1; j0++) {
                for (int j1 = 0; j1 < n2; j1++) {
                    const int d0 = ((k0 - j0) % n1 + n1) % n1;
                    const int d1 = ((k1 - j1) % n2 + n2) % n2;
                    sr += ra[2 * (j0 * n2 + j1)] * rb[2 * (d0 * n2 + d1)];
                }
            }
            const double diff = fabs(c[2 * (k0 * n2 + k1)] - sr);
            if (diff > m) m = diff;
        }
    }
    char label[128];
    snprintf(label, sizeof(label), "2D convolution theorem 12x16        (max err %.2e)", m);
    if (m < 1e-8 * n) ok(label); else bad(label, "convolution theorem violated");

    free(a); free(b); free(c); free(ra); free(rb);
}

/* ---------- 濂介暱搴︽煡璇?---------- */

static void test_fast_size(void)
{
    struct { int in, want; } cases[] = {
        { 1, 1 }, { 2, 2 }, { 3, 4 }, { 5, 8 }, { 6, 8 }, { 7, 8 }, { 11, 16 },
        { 13, 16 }, { 17, 32 }, { 1080, 2048 }, { 1920, 2048 },
        { 1081, 2048 }, { 1296, 2048 }, { 2000, 2048 },
    };
    int allok = 1;
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        const int got = am_fft_next_fast_size(cases[i].in);
        if (got != cases[i].want) {
            printf("      next_fast_size(%d) = %d, want %d\n", cases[i].in, got, cases[i].want);
            allok = 0;
        }
    }
    if (allok) ok("next_fast_size (power of two)"); else bad("next_fast_size", "mismatch");

    /* Every result must be a power of two and must not be below the input:
     * the matcher relies on this to pick the padding. */
    int allpow = 1;
    for (int n = 1; n <= 4096; n++) {
        const int g = am_fft_next_fast_size(n);
        if (g < n || (g & (g - 1)) != 0) {
            printf("      next_fast_size(%d) = %d is not an acceptable power of two\n", n, g);
            allpow = 0;
            break;
        }
    }
    if (allpow) ok("next_fast_size is always >= n and a power of two");
    else bad("next_fast_size range", "not a power of two or below n");
}

/* ---------- 鎷掔粷涓嶆敮鎸佺殑灏哄 ---------- */

static void test_rejects(void)
{
    const int bad_sizes[] = { 7, 11, 13, 14, 17, 22, 26, 1000003 };
    int allok = 1;
    for (size_t i = 0; i < sizeof(bad_sizes) / sizeof(bad_sizes[0]); i++) {
        const int n = bad_sizes[i];
        if (am_fft_plan_create(&n, 1) != NULL) {
            printf("      plan_create(%d) should have been rejected\n", n);
            allok = 0;
        }
    }
    if (allok) ok("rejects lengths with prime factors > 5"); else bad("reject", "accepted bad length");
}

/* ---------- 閫熷害锛?080x1920锛屽嵆鏈€鍧忔儏鍐垫暣甯у尮閰嶇殑閲忕骇锛?---------- */

static void test_speed(void)
{
    const int n1 = 1080, n2 = 1920;
    const int n = n1 * n2;
    am_cplx *buf = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)n));
    if (!buf) { bad("alloc speed", NULL); return; }
    for (int i = 0; i < n; i++) { buf[2 * i] = frand(); buf[2 * i + 1] = 0.0; }

    int shape[2]; shape[0] = n1; shape[1] = n2;
    am_fft_plan *p = am_fft_plan_create(shape, 2);
    if (!p) { bad("plan 1080x1920", "rejected"); free(buf); return; }

#ifdef _WIN32
    LARGE_INTEGER f, c0, c1;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c0);
#else
    const clock_t c0 = clock();
#endif
    am_fft_execute(p, buf, 0);
#ifdef _WIN32
    QueryPerformanceCounter(&c1);
    const double ms_fwd = (double)(c1.QuadPart - c0.QuadPart) * 1000.0 / (double)f.QuadPart;
    QueryPerformanceCounter(&c0);
#else
    const double ms_fwd = (double)(clock() - c0) * 1000.0 / CLOCKS_PER_SEC;
#endif
    am_fft_execute(p, buf, 1);
#ifdef _WIN32
    QueryPerformanceCounter(&c1);
    const double ms_inv = (double)(c1.QuadPart - c0.QuadPart) * 1000.0 / (double)f.QuadPart;
#else
    const double ms_inv = 0.0;
#endif

    char label[128];
    snprintf(label, sizeof(label), "1080x1920 FFT: %.0f ms fwd + %.0f ms inv (desktop baseline)", ms_fwd, ms_inv);
    ok(label);

    am_fft_plan_destroy(p);
    free(buf);
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
#ifdef PG_TRACE
    guard_set_verbose(1);
#endif
    printf("== am_fft test ==\n[1] 1D vs direct DFT\n");
    const int lens[] = { 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 25, 27, 30,
                         32, 36, 45, 48, 60, 64, 72, 81, 96, 100, 108, 120, 125, 128,
                         144, 180, 225, 240, 243, 256, 324, 360, 405, 512, 625, 720, 729,
                         1024, 1080, 1296, 1920, 2048 };
    for (size_t i = 0; i < sizeof(lens) / sizeof(lens[0]); i++) test_1d_length(lens[i]);

    printf("[2] 2D vs direct 2D DFT\n");
    test_2d(2, 2); test_2d(3, 4); test_2d(6, 5); test_2d(4, 8);
    test_2d(9, 8); test_2d(8, 9); test_2d(12, 12); test_2d(15, 16);

    printf("[3] convolution theorem\n");
    test_convolution();

    printf("[4] helpers\n");
    test_fast_size();
    test_rejects();

    printf("[5] speed\n");
    test_speed();

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}

