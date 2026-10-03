/* am_fft.h —— N 维混合基 FFT（只用 double，纯 C99，零依赖）
 *
 * 为什么要自己写：
 *   TM_CCOEFF_NORMED 的分子 Σ T·I 是「模板对图像的互相关」，直接算是
 *   O(搜索区面积 × 模板面积)，在 1080x1920 帧上实测要 ~20 s/次（见 tests/bench_match.c），
 *   而 .auto 的 loop_interval 是 30 ms。必须走 FFT：O(N log N)。
 *   OpenCV 的 matchTemplate 也是这么做的（它内部就是 DFT 卷积）。
 *
 * 为什么不用 vDSP/Accelerate：
 *   ① 同一份代码要在 Windows 上跑单测 —— FFT 的正确性必须能在本机被证明，
 *      而不是上真机才发现点乘顺序错了；
 *   ② 只要语义与 OpenCV 一致，性能可以在 iOS 侧用 Accelerate 换实现，
 *      但眼下先要「对」。
 *
 * 变换长度不限制为 2 的幂：1080x1920 的帧 pad 到 2 的幂会浪费 3 倍运算量
 * （1296x2048 vs 2048x2048），所以支持 2/3/5 混合基 —— 1296 = 2^4·3^4，2048 = 2^11，
 * 都是「好长度」。
 *
 * 数据布局：交错复数 (re, im, re, im, ...)，行主序，
 *   索引 (i0, i1, ..., i_{d-1}) → (((i0)*n1 + i1)*n2 + ...)
 * 这是 NumPy/Scilab/OpenCV 的「自然」布局，也是 am_fft(..., 1) 后取实部即可当卷积用的原因。
 */
#ifndef AM_FFT_H
#define AM_FFT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 交错复数缓冲：2 * 元素个数 个 double */
typedef double am_cplx;

/* ★ 分配 n 个复数所需的字节数。**永远**用它算缓冲大小，别写
 *   `n * sizeof(am_cplx)` —— 那只有一半。
 *
 * 原因：`am_cplx` 是**一个 double**（不是 {re,im} 结构体），复数按交错方式存成
 * data[2*i]=实部、data[2*i+1]=虚部。所以「n 个复数」占 2n 个 double。
 * 这个坑在 am_fft.c 里真实发生过：三处 scratch 缓冲都按 n*sizeof(am_cplx) 分配，
 * 于是每个都刚好只有所需大小的一半，全部越界写堆。表现为随机的
 * STATUS_HEAP_CORRUPTION，离出错行十万八千里。
 * （单靠 strlen/类型名看不出来，因为 sizeof(am_cplx) 和 sizeof(double) 一样是 8。） */
#define AM_CPLX_BYTES(n_complex) ((size_t)(n_complex) * 2u * sizeof(am_cplx))

typedef struct am_fft_plan am_fft_plan;

/* 规划一个「自然序、in-place」的 d 维变换，维度 shape[0..d-1]。
 * 其中 shape[0] 是**最慢**的维度（行主序），shape[d-1] 是**最快**的。
 * 返回 NULL 表示维度含大于 5 的素因子（不支持）。
 *
 * N 维变换按**可分离性**实现：依次对每根轴做一维变换。所以每个维度各有一张
 * 自己的旋转因子表（表长 = 该维长度 + 2）。plan 不含可变工作区，但
 * `am_fft_execute` 不是线程安全的（内部仍会按需分配临时缓冲）。 */
am_fft_plan *am_fft_plan_create(const int *shape, int d);
void am_fft_plan_destroy(am_fft_plan *p);

/* 就地变换。inverse != 0 时做逆变换并**除以总元素个数**。
 * 返回 0 成功。 */
int am_fft_execute(am_fft_plan *p, am_cplx *data, int inverse);

/* 便捷：任意长度的一维 FFT（内部临时建 plan）。n 含 >5 的素因子时返回 -1。 */
int am_fft_1d(am_cplx *data, int n, int inverse);
int am_fft_2d(am_cplx *data, int n1, int n2, int inverse);

/* 一个「好长度」查询：返回 >= n 的最小 **2 的幂**。
 * 用于给 pad 后的维度选尺寸。
 *
 * ★ 为什么是 2 的幂而不是 5-smooth（更小的尺寸）：
 *   mixed-radix 路径**每个元素**比 radix-2 慢得多。实测本机（Windows 标量 C，/O2）：
 *       512x576  (294k 点, mixed)  30.3 ms
 *       1024x512 (524k 点, pow2)   17.3 ms
 *       576x648  (373k 点, mixed)  58.0 ms
 *       1024x1024(1049k 点, pow2)  33.7 ms
 *       1080x1920(2074k 点, mixed) 332  ms
 *       2048x2048(4194k 点, pow2)  134  ms   <-- 点数是 2 倍，反而快 2.5 倍
 *   即 radix-2 每元素快约 11 倍，多 pad 一点完全划算。mixed-radix 仍然保留并
 *   已有测试覆盖（`am_fft_plan_create` 接受 5-smooth 长度），在 1D 小长度上
 *   有用，但**不要**用它去做大尺寸的 N 维变换。 */
int am_fft_next_fast_size(int n);

/* ------------------------------------------------------------------ *
 * 加速后端（Accelerate/vDSP），实现在 am_fft_accel.c
 *
 * 语义上完全可选：没有它时这两个函数仍然存在，只是 `..._active()` 恒返回 0。
 * 两条路径的数值结果必须落在同一个容差内 —— tests/test_fft.c 的 [6] 段就是
 * 为此写的（DC 分量 == 逐元素和、单位冲激 ⇒ 全 1、共轭对称、Parseval，
 * 并且在 Accelerate 可用时断言它**确实被用上了**，否则那一段等于没测）。
 * ------------------------------------------------------------------ */

/* 相邻（stride == 1）的 2 的幂长度一维变换。成功返回 1，返回 0 表示
 * 「本平台没有加速后端 / 长度不合适」，调用方应回落到标量实现。 */
int am_fft_pow2_accel(am_cplx *a, int n, int inverse);

/* 本次进程是否真的走过 vDSP（false 表示一路都是标量）。 */
int am_fft_accelerate_active(void);

/* 释放 vDSP 的 setup（进程退出前调一次即可；不调也只是少回收一块内存）。 */
void am_fft_accel_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* AM_FFT_H */
