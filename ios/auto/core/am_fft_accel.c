/* am_fft_accel.c —— am_fft 的 Accelerate/vDSP 加速后端（只在 iOS 侧编译）
 *
 * 为什么需要它：
 *   core/am_fft.c 是**标量 C99**，为的是「同一份代码能在 Windows 上跑单测」。
 *   实测本机（Windows / MSVC /O2，见 tests/bench_match.c）：整个匹配路径比
 *   .auto 的 loop_interval = 30 ms 慢 4.26 倍（9 个真实裁切搜索合计 676 ms，
 *   单次最坏 127.8 ms）。iOS 上是 A10，只会更慢。
 *   FFT 是这个路径的主体，所以把 FFT 换成 vDSP 是收益最大的一步。
 *
 * 怎么接进来的（不改任何一行标量代码的语义）：
 *   core/am_fft.c 里的 `fft_pow2()` 在开头问一句
 *   「有没有加速后端？有就交给它，没有就继续跑标量」。
 *   ⇒ 非 2 的幂的长度、以及**带跨距的**行，仍然走原来的标量实现；
 *     只有「相邻的、2 的幂的」一维变换会走 vDSP。这是刻意的保守选择：
 *     跨距行要先聚拢到临时缓冲，那个开销不值得（ND 驱动里最后一维的
 *     stride 恒为 1，二维匹配的绝大多数工作量都在这一维上）。
 *
 * 数值语义必须与标量版一致（否则 test_package 的 17 个真实用例会飘）：
 *   · vDSP_fft_zip 的 FFT_FORWARD 使用负指数，与标量版的 tw[k]=cos(-2πk/n) 同向；
 *   · 逆变换同样要**除以元素个数**（这里按轴长 n 除，N 维时逐轴除，
 *     连乘正好是 1/总元素数）；
 *   · 输入是交错复数（data[2i]=re、data[2i+1]=im），vDSP 用**分裂复数**
 *     （实部数组 + 虚部数组），所以进出各要一次 vDSP_ctozD / vDSP_ztocD 转换。
 *     注意是 **D 后缀**的那两个：数据是 double，用单精度的 DSPComplex /
 *     DSPSplitComplex 会让步长按 4 字节算（见 am_fft_pow2_accel 里的长注释）。
 */
#include "am_fft.h"

#if defined(__APPLE__) && defined(AM_FFT_ACCELERATE)

#include <Accelerate/Accelerate.h>
#include <stdlib.h>
#include <string.h>

/* vDSP 的 setup 长度必须 >= 实际变换长度。ND 驱动会按轴逐个调用，
 * 所以按「所有轴里最长的那个」建一张 setup 就够（2 的幂，log2 最大 27）。 */
#define AM_ACCEL_MAX_LOG2 27

static FFTSetupD g_setup;
static unsigned long g_setup_len;
static int g_active;

/* 取 [len] 的一位 setup（len 必须是 2 的幂）。成功返回 1。 */
static int ensure_setup(unsigned long len)
{
    if (g_setup && g_setup_len >= len) return 1;
    if (len < 2) return 0;

    unsigned long want = 2;
    while (want < len && want < (1ul << AM_ACCEL_MAX_LOG2)) want <<= 1;
    if (want < len) return 0;                    /* 太大，交给标量 */

    vDSP_Length log2n = 0;
    for (unsigned long t = want; t > 1; t >>= 1) log2n++;

    FFTSetupD s = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    if (!s) return 0;
    if (g_setup) vDSP_destroy_fftsetupD(g_setup);
    g_setup = s;
    g_setup_len = want;
    return 1;
}

/* 相邻（stride == 1）的 2 的幂长度一维**正向**变换。
 *
 * ★ 调用方（core/am_fft.c 的 fft_pow2）**永远传 inverse = 0**，逆变换在
 *   am_fft_execute() 里是用「共轭 → 正向 → 除 N → 再共轭」拼出来的。
 *   保留 inverse 参数只是为了这个函数自身能独立测试；生产路径不会走到
 *   那一段，所以也就不会和上面的共轭约定打架。 */
int am_fft_pow2_accel(am_cplx *a, int n, int inverse)
{
    if (n < 2) return 0;
    if (!ensure_setup((unsigned long)n)) return 0;

    /* 分裂复数的两块缓冲：各 n 个 double，靠 vDSP_ctozD 从交错布局拆出来。 */
    double *re = (double *)malloc((size_t)n * sizeof(double));
    double *im = (double *)malloc((size_t)n * sizeof(double));
    if (!re || !im) { free(re); free(im); return 0; }

    /* 交错 [re,im,re,im,…] —— 把 am_cplx* 当作 DSPDoubleComplex* 看，
     * 正是 vDSP_ctozD 期待的输入形态。
     *
     * ★★ 结构体与打包函数**必须**是 Double 的：`DSPSplitComplex` 的
     *   realp/imagp 是 `float *`（每个元素 4 字节、步长按 float 算），而我们的
     *   数据是 double（8 字节）。第一次写这份文件时用的是单精度那一套，
     *   clang 报了三条 `-Wincompatible-pointer-types`（realp/imagp 赋值两条 +
     *   vDSP_fft_zipD 的实参一条）—— 那不只是警告：真跑起来 vDSP 会拿 4 字节的
     *   步长去读 8 字节的数据，结果是一片垃圾，而**单元测试在 macOS 上跑**
     *   （CI 会走 vDSP 这条路），所以它会直接表现为用例失败而不是静默。 */
    DSPDoubleSplitComplex sp;
    sp.realp = re;
    sp.imagp = im;
    vDSP_ctozD((const DSPDoubleComplex *)a, 2, &sp, 1, (vDSP_Length)n);

    /* FFT_FORWARD == -1，对应 exp(-i2πk/n)，与标量版 tw[k] 的符号约定一致。 */
    int log2n = 0;
    for (int t = n; t > 1; t >>= 1) log2n++;

    vDSP_fft_zipD(g_setup, &sp, 1, (vDSP_Length)log2n,
                  (FFTDirection)(inverse ? FFT_INVERSE : FFT_FORWARD));

    /* 逆变换要除以轴长（N 维逐轴除，连乘即 1/总元素数）。 */
    if (inverse) {
        const double s = 1.0 / (double)n;
        vDSP_vsmulD(re, 1, &s, re, 1, (vDSP_Length)n);
        vDSP_vsmulD(im, 1, &s, im, 1, (vDSP_Length)n);
    }

    vDSP_ztocD(&sp, 1, (DSPDoubleComplex *)a, 2, (vDSP_Length)n);

    free(re);
    free(im);
    g_active = 1;
    return 1;
}

int am_fft_accelerate_active(void)
{
    return g_active;
}

void am_fft_accel_shutdown(void)
{
    if (g_setup) {
        vDSP_destroy_fftsetupD(g_setup);
        g_setup = NULL;
    }
    g_setup_len = 0;
    g_active = 0;
}

#else /* 非 Apple，或没开 AM_FFT_ACCELERATE */

/* 没有加速后端时这两个符号仍然存在，免得调用点要写一堆 #if。
 * 它们**不算**「用了加速」（active 恒 0），测试据此判断走的是哪条路。 */
int am_fft_pow2_accel(am_cplx *a, int n, int inverse)
{
    (void)a; (void)n; (void)inverse;
    return 0;
}

int am_fft_accelerate_active(void)
{
    return 0;
}

void am_fft_accel_shutdown(void)
{
}

#endif
