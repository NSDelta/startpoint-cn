/* bench_pkg.c -- per-frame cost of the FFT matcher on the REAL search regions.
 *
 * tests/bench_match.c measured the naive implementation at 142435 ms for nine
 * full-frame searches. This measures the FFT path on the same nine templates,
 * but over the search rectangles the script actually uses, which is what the
 * engine will do -- and also over the whole frame, to show what a full-frame
 * search would cost.
 */
#include "auto_match.h"
#include "am_container.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
static double now_ms(void)
{
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}
#else
#include <time.h>
static double now_ms(void) { return (double)clock() * 1000.0 / CLOCKS_PER_SEC; }
#endif

static unsigned char *load(const char *p, int *w, int *h)
{
    FILE *f = fopen(p, "rb");
    if (!f) { printf("missing %s\n", p); return NULL; }
    fseek(f, 0, SEEK_END); long n = ftell(f); rewind(f);
    unsigned char *b = (unsigned char *)malloc((size_t)n);
    if (fread(b, 1, (size_t)n, f) != (size_t)n) { fclose(f); return NULL; }
    fclose(f);
    if (am_png_size(b, (size_t)n, w, h) != 0) { free(b); return NULL; }
    unsigned char *g = (unsigned char *)malloc((size_t)(*w) * (size_t)(*h));
    if (am_png_decode_gray(b, (size_t)n, g, (size_t)(*w) * (size_t)(*h), w, h) != AM_OK) {
        free(g); free(b); return NULL;
    }
    free(b);
    return g;
}

/* the nine 1080-wide variants plus the crop rectangle each one is searched in */
typedef struct { const char *tpl; int rx, ry, rw, rh; } bench_case;

static const bench_case CASES[] = {
    { "1789816424515.png",  209, 1029,  476,  505 },   /* 幻想 */
    { "1789819709914.png",  152, 1364,  454,  337 },   /* 开始连战 */
    { "1789816064621.png",  186, 1411,  703,  497 },   /* 挑战 */
    { "1789815889030.png",  280, 1565,  671,  435 },   /* 继续 */
    { "1789815990830.png",  521, 1523,  494,  397 },   /* 继续挑战 */
    { "1789820061325.png",  294, 1542,  501,  378 },   /* OK */
    { "1789816623365.png",  292, 1013,  494,  395 },   /* 没开招募 */
    { "1789816658183.png",  262,  989,  577,  504 },   /* 招募 */
    { "1789816700858.png",  481, 1184,  599,  384 },   /* 开始招募 */
};
#define NCASE ((int)(sizeof(CASES) / sizeof(CASES[0])))

int main(void)
{
    const char *base = "matcher_golden_pkg/pkg/";
    char path[512];

    snprintf(path, sizeof(path), "%s1789786626126.png", base);
    int ow = 0, oh = 0;
    unsigned char *frame = load(path, &ow, &oh);
    if (!frame) return 1;
    printf("frame %dx%d\n\n", ow, oh);

    /* ---- pass 1: the real crop regions ---- */
    double total_crop = 0.0, worst_crop = 0.0;
    printf("crop-sized search regions (what the engine actually does):\n");
    for (int i = 0; i < NCASE; i++) {
        snprintf(path, sizeof(path), "%s%s", base, CASES[i].tpl);
        int tw = 0, th = 0;
        unsigned char *tpl = load(path, &tw, &th);
        if (!tpl) { printf("  %-20s load failed\n", CASES[i].tpl); continue; }

        const unsigned char *roi = frame + (size_t)CASES[i].ry * ow + CASES[i].rx;
        am_gray g_roi = { roi, CASES[i].rw, CASES[i].rh, ow };
        am_gray g_tpl = { tpl, tw, th, tw };

        am_match_result r;
        const double t0 = now_ms();
        am_match_template(&g_roi, &g_tpl, &r);
        const double dt = now_ms() - t0;

        total_crop += dt;
        if (dt > worst_crop) worst_crop = dt;
        printf("  %-20s %3dx%-3d in %3dx%-3d  peak=%.4f @(%3d,%3d)  %7.2f ms\n",
               CASES[i].tpl, tw, th, CASES[i].rw, CASES[i].rh, r.peak, r.x, r.y, dt);
        free(tpl);
    }

    /* ---- pass 2: warm cache, to separate plan setup from steady-state ---- */
    const int WARM = 5;
    snprintf(path, sizeof(path), "%s%s", base, CASES[0].tpl);
    int tw = 0, th = 0;
    unsigned char *tpl0 = load(path, &tw, &th);
    if (tpl0) {
        am_gray g_roi = { frame + (size_t)CASES[0].ry * ow + CASES[0].rx,
                          CASES[0].rw, CASES[0].rh, ow };
        am_gray g_tpl = { tpl0, tw, th, tw };
        am_match_result r;
        am_match_template(&g_roi, &g_tpl, &r);              /* prime */
        const double t0 = now_ms();
        for (int k = 0; k < WARM; k++) am_match_template(&g_roi, &g_tpl, &r);
        const double dt = (now_ms() - t0) / WARM;
        printf("\nsteady-state single search (%dx%d in %dx%d): %.2f ms\n",
               tw, th, CASES[0].rw, CASES[0].rh, dt);

        /* ---- pass 3: full frame, for comparison with the naive baseline ---- */
        am_gray g_full = { frame, ow, oh, ow };
        am_match_template(&g_full, &g_tpl, &r);
        const double t1 = now_ms();
        am_match_template(&g_full, &g_tpl, &r);
        printf("full-frame single search (%dx%d in %dx%d): %.2f ms  peak=%.4f @(%d,%d)\n",
               tw, th, ow, oh, now_ms() - t1, r.peak, r.x, r.y);
        free(tpl0);
    }

    printf("\nTOTAL for %d crop searches : %8.2f ms   (worst single %7.2f ms)\n",
           NCASE, total_crop, worst_crop);
    printf("frame budget (loop_interval):     30.00 ms\n");
    printf("ratio vs budget (per worst search): %.2fx\n", worst_crop / 30.0);
    free(frame);
    return 0;
}
