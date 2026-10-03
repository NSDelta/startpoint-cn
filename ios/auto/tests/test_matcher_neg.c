/*
 * test_matcher_neg.c —— 判别力测试（假阳性率）。用"错配"夹具验证引擎不会把不相干的界面误判为命中。
 *
 * 为什么这是最关键的一项：正例（模板就是从该截图裁的）峰值恒为 1.0，只能证明"找得到"。
 * 真正会让脚本乱点的是**假阳性** —— 不相干的界面被打到 sim(0.8) 以上。
 * 本测试用 tools/make_negatives.py 造的 18 组"模板 vs 不相干截图"，要求：
 *   ① 引擎给出的峰值与 OpenCV 一致（容差 1e-4）；
 *   ② 峰值 < sim(0.8)，即引擎在真实阈值下**必须判定未命中**。
 *
 * ── 容差为什么比正例宽 ────────────────────────────────────────────────────
 * 实测 18 组的 |Δpeak| 在 1.5e-7 ~ 2.0e-5（正例最好 1e-16、最差 2.3e-6）。分数越低残差相对越大，
 * 因为 OpenCV 走 DFT/FFT 卷积，其舍入误差与信号强度无关，分数低时相对误差自然放大。
 * 相对误差始终 <= 1e-4，且**全部 18 组都正确拒绝**，所以容差取 1e-4（仍是"数值等价"的量级，
 * 足以抓住实现错误）；真正的判据是第 ② 条。
 *
 * 夹具峰值实测区间 0.141 ~ 0.422，与阈值 0.8 留有 >=0.378 的余量 —— 这是判别力的量化证据。
 *
 * 用法： test_matcher_neg <golden_dir>
 */
#include "../core/auto_match.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "golden_neg_cases.h"

#define PEAK_TOL 1e-4
#define SIM 0.8   /* 样本脚本 image_list 的 sim 值 */

static unsigned char *read_file(const char *path, size_t expect)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    unsigned char *buf = (unsigned char *)malloc(expect ? expect : 1);
    if (!buf) { fclose(f); return NULL; }
    const size_t n = fread(buf, 1, expect, f);
    fclose(f);
    if (n != expect) { free(buf); return NULL; }
    return buf;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);   /* 同 test_matcher：崩溃别吞输出 */
    if (argc < 2) { fprintf(stderr, "usage: test_matcher_neg <golden_dir>\n"); return 2; }
    const char *dir = argv[1];
    char path[1024];
    int pass = 0, fail = 0;
    double max_peak = 0.0, min_margin = 1.0;

    for (int i = 0; i < AM_GOLDEN_NEG_COUNT; i++) {
        const am_golden_neg_case *c = &AM_GOLDEN_NEG_CASES[i];
        snprintf(path, sizeof(path), "%s/raw/%s_roi.bin", dir, c->tag);
        unsigned char *roi = read_file(path, (size_t)c->roi_w * c->roi_h);
        snprintf(path, sizeof(path), "%s/raw/%s_tpl.bin", dir, c->tag);
        unsigned char *tpl = read_file(path, (size_t)c->tpl_w * c->tpl_h);
        if (!roi || !tpl) {
            printf("FAIL %-24s fixture missing\n", c->tag);
            fail++; free(roi); free(tpl); continue;
        }

        am_gray g_roi = { roi, c->roi_w, c->roi_h, c->roi_w };
        am_gray g_tpl = { tpl, c->tpl_w, c->tpl_h, c->tpl_w };
        am_match_result r;
        am_match_template(&g_roi, &g_tpl, &r);

        const double dpeak = fabs(r.peak - c->expect_peak);
        const int score_ok = dpeak <= PEAK_TOL;
        /* 引擎在真实阈值下是否正确地"拒绝"这次错配 */
        const int rejected = !(r.peak >= SIM);
        const int good = score_ok && rejected;

        if (r.peak > max_peak) max_peak = r.peak;
        const double margin = SIM - r.peak;
        if (margin < min_margin) min_margin = margin;

        printf("%s %-24s peak=%.6f (cv2 %.6f, d=%.1e) 拒绝=%s 余量=%.3f\n",
               good ? "PASS" : "FAIL", c->tag, r.peak, c->expect_peak, dpeak,
               rejected ? "是" : "否(!)", margin);
        if (good) pass++; else fail++;
        free(roi); free(tpl);
    }

    printf("\n== %d passed, %d failed ==\n", pass, fail);
    printf("错配峰值区间上界 = %.6f，sim = %.2f，最小余量 = %.3f\n", max_peak, SIM, min_margin);
    return fail ? 1 : 0;
}
