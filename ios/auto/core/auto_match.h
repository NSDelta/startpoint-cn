/*
 * auto_match.h —— 与 Android 参考实现（OpenCV Imgproc.matchTemplate / TM_CCOEFF_NORMED）逐点等价的
 * 归一化互相关模板匹配。纯 C99，无外部依赖（iOS 侧可用 vDSP/vImage 加速，语义不变）。
 *
 * 为什么必须与 OpenCV 等价：.auto 脚本里每个模板写了 sim（本样本 0.8），引擎判定是
 * `peak >= sim`。若 iOS 侧打分体系与 OpenCV 有偏差，同一个脚本在 Android 上能跑、在 iOS 上就漏点或误点。
 *
 * Android 侧实测调用点（反编译证据）：
 *   cn/autoeditor/framework/base/c.java: g(c, list, z)
 *     Mat roi = d(frame, searchRect);            // 抠搜索区，模板比搜索区大就放弃
 *     Imgproc.d(roi, tpl, result);               // = cv::matchTemplate(TM_CCOEFF_NORMED)
 *     MinMaxLocResult mm = Core.minMaxLoc(result);
 *     sim   = max(mm.maxVal, 0.0);               // 钳到 [0,1]
 *     matchX = (int)mm.maxLoc.x + searchRect.x;  // 还原到全帧像素坐标
 *     matchY = (int)mm.maxLoc.y + searchRect.y;
 *     if (!z && sim >= threshold) break;         // z=false：命中即停（取最优）
 */
#ifndef AUTO_MATCH_H
#define AUTO_MATCH_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 单通道 8 位灰度图；data 按行连续，stride 为**字节**步长（可 > width）。 */
typedef struct {
    const unsigned char *data;
    int width;   /* 搜索区宽（像素） */
    int height;  /* 搜索区高（像素） */
    int stride;  /* 行字节步长；>0。传 0 视为 == width */
} am_gray;

typedef struct {
    int found;        /* 1 = 至少有一个位置被算出来 */
    double peak;      /* 归一化互相关系数峰值，已按 OpenCV 规则钳到 [0,1]（NaN/-inf → 0） */
    int x;            /* 峰值位置左上角 x，相对 am_gray 原点（调用方再加 searchRect.x） */
    int y;            /* 峰值位置左上角 y */
    int w;            /* = 模板宽（Android 侧 p1.f1444c 语义：匹配矩形 = 模板尺寸） */
    int h;            /* = 模板高（Android 侧 p1.f1445d） */
} am_match_result;

/* 拥有像素的灰度图（模板缓存用，与 am_gray 的区别是 am_mat 管内存）。
 * 用 am_mat_view() 转成 am_gray 交给 am_match_template。 */
typedef struct {
    unsigned char *pixels;
    int width, height;
    int stride;       /* 字节步长 */
} am_mat;

/* 取 am_mat 的无拥有权视图，可直接喂给 am_match_template。 */
am_gray am_mat_view(const am_mat *m);

/* 释放 am_mat 并清零。可安全重复调用。 */
void am_mat_free(am_mat *m);

/*
 * 等价的 matchTemplate + minMaxLoc。
 * 返回 1 表示算出了结果（模板能放进搜索区），0 表示放不下（Android 侧此时直接放弃该搜索区）。
 * degenerate（模板方差为 0，例如纯色模板）时按 OpenCV 行为：分母 ~0 → peak 记 0（视为不匹配）。
 */
int am_match_template(const am_gray *roi, const am_gray *tpl, am_match_result *out);

/*
 * OpenCV TM_CCOEFF_NORMED 打分函数，可对已在别处算好统计量的调用方复用（iOS 侧 vDSP 路径）。
 *   n          = 模板像素数
 *   sumT, sumT2= 模板灰度和 / 灰度和平方
 *   sumI, sumI2= 窗口灰度和 / 窗口灰度和平方
 *   dot        = Σ T*I
 * 返回 [0,1]（负相关与除零一律 0）。
 */
double am_ncc_score(double n, double sumT, double sumT2,
                    double sumI, double sumI2, double dot);

/*
 * 多目标枚举（Android base/c.java: a(p1)）：反复取峰值，命中后把命中区域按模板尺寸外扩一圈清零，
 * 直到峰值 < threshold 或迭代超过 max_hits。hits 需由调用方提供 max_hits 个元素的空间。
 * 返回命中个数。
 */
int am_match_template_multi(const am_gray *roi, const am_gray *tpl, double threshold,
                            am_match_result *hits, int max_hits);

#ifdef __cplusplus
}
#endif

#endif /* AUTO_MATCH_H */
