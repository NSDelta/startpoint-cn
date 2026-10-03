/* bench_match.c —— auto_match 的性能基线
 *
 * 动机：cv2.matchTemplate 对 1080x1920 帧 + 每个模板要 ~40-50 ms，
 * 而 .auto 要求 loop_interval = 30 ms。必须先量出本实现的差距，再决定优化到什么程度。
 *
 * 数据：matcher_golden_pkg/pkg/ 下平铺了样本 .auto 的 ori 截图与模板裁剪图
 * （按尺寸区分：1080x1920 是截图，小尺寸是模板）。模板清单由
 * tools/make_bench_cases.py 生成的 tests/bench_cases.h 提供。
 *
 * 用法: bench_match.exe [matcher_golden_pkg 目录]
 */
#include "auto_match.h"
#include "am_container.h"
#include "bench_cases.h"

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
static double now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
#endif

static unsigned char *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) { fclose(f); return NULL; }
    unsigned char *b = (unsigned char *)malloc((size_t)n);
    if (!b) { fclose(f); return NULL; }
    if (fread(b, 1, (size_t)n, f) != (size_t)n) { free(b); fclose(f); return NULL; }
    fclose(f);
    *out_len = (size_t)n;
    return b;
}

/* 解码 pkg/<name> 为灰度图；失败返回 NULL */
static unsigned char *load_gray(const char *dir, const char *name, int *w, int *h)
{
    char path[1200];
    snprintf(path, sizeof(path), "%s/pkg/%s", dir, name);
    size_t len = 0;
    unsigned char *p = read_file(path, &len);
    if (!p) return NULL;
    if (am_png_size(p, len, w, h) != 0 || *w <= 0) { free(p); return NULL; }
    unsigned char *g = (unsigned char *)malloc((size_t)(*w) * (size_t)(*h));
    if (!g || am_png_decode_gray(p, len, g, (size_t)(*w) * (size_t)(*h), w, h) != 0) {
        free(p); free(g); return NULL;
    }
    free(p);
    return g;
}

int main(int argc, char **argv)
{
    const char *dir = (argc > 1) ? argv[1] : "matcher_golden_pkg";
    int reps = (argc > 2) ? atoi(argv[2]) : 3;

    /* ---- 帧：把 ori 截图里那张 1080x1920 的拿来用（与 golden 同源） ---- */
    int fw = 0, fh = 0;
    unsigned char *frame = load_gray(dir, "1789816658174.png", &fw, &fh);
    if (!frame) { printf("cannot load frame 1789816658174.png from %s/pkg\n", dir); return 1; }
    printf("frame: %dx%d\n", fw, fh);
    am_gray F = { frame, fw, fh, fw };

    /* ---- 模板 ---- */
    enum { MAXT = 32 };
    unsigned char *td[MAXT] = {0};
    am_gray T[MAXT];
    const int want[MAXT] = {0};
    int n = 0;
    (void)want;

    for (int i = 0; i < BENCH_REAL_CASE_COUNT && n < MAXT; i++) {
        int w = 0, h = 0;
        unsigned char *g = load_gray(dir, BENCH_REAL_CASES[i].file, &w, &h);
        if (!g) { printf("  (skip %s: load failed)\n", BENCH_REAL_CASES[i].file); continue; }
        td[n] = g;
        T[n].data = g; T[n].width = w; T[n].height = h; T[n].stride = w;
        n++;
    }
    if (n == 0) { printf("no templates loaded\n"); free(frame); return 1; }
    printf("templates: %d\n\n", n);

    /* ---- 计时 ---- */
    double total = 0.0, worst = 0.0;
    for (int rep = 0; rep < reps; rep++) {
        double rt = 0.0, rw = 0.0;
        for (int i = 0; i < n; i++) {
            am_match_result r;
            double t0 = now_ms();
            int ok = am_match_template(&F, &T[i], &r);
            double dt = now_ms() - t0;
            rt += dt;
            if (dt > rw) rw = dt;
            if (rep == 0) {
                printf("  %-22s %4dx%-4d peak=%7.4f  %8.2f ms\n",
                       BENCH_REAL_CASES[i].file, T[i].width, T[i].height,
                       ok ? r.peak : -1.0, dt);
            }
        }
        printf("  rep%d: %d full-frame searches -> total %8.1f ms, worst %7.1f ms\n",
               rep, n, rt, rw);
        total = rt;
        worst = rw;
    }

    printf("\nbudget at loop_interval=30ms :   30.0 ms/frame\n");
    printf("measured                     : %8.1f ms/frame (%.0fx over)\n",
           total, total / 30.0);
    printf("worst single search          : %8.1f ms\n", worst);

    for (int i = 0; i < n; i++) free(td[i]);
    free(frame);
    return 0;
}
