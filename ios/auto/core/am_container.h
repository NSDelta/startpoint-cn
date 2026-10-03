/*
 * am_container.h —— .auto 容器（ZIP/deflate）与 PNG 解码 + 灰度转换。
 *
 * 为什么需要它：.auto 文件是标准的 ZIP（全部条目 method=8 deflate），里面的模板是 8bit RGB PNG，
 * 全屏截图是 8bit RGBA/RGB PNG。iOS 端本可以用 ImageIO 读 PNG，但：
 *   ① .auto 的 ZIP 仍然必须自己解（iOS 没有公开的 zip API）；
 *   ② 自己解 PNG 才能让**整条读取链路在 Windows/CI 上被单元测试覆盖**，而不是只能上真机才发现问题；
 *   ③ 灰度化必须与 Android 逐位一致（OpenCV 的 BGRA2GRAY/BGR2GRAY 用的是定点系数），
 *      走 Apple 的 vImage 会引入不同的舍入 —— 所以自己算。
 *
 * 因此本模块是纯 C99、无外部依赖（内置 inflate），macOS/iOS/Windows 都能编译与测试。
 *
 * 与 Android 的对应关系：
 *   - `Imgcodecs.c(path)` 读模板           → am_png_decode_gray()
 *   - `Imgproc.a(mat, mat2, 6)` BGRA2GRAY  → am_gray_from_rgb()/am_gray_from_rgba()
 *   - Java `ZipInputStream`/`ZipFile`      → am_auto_open()/am_auto_read()
 */
#ifndef AM_CONTAINER_H
#define AM_CONTAINER_H

#include <stddef.h>

#include "auto_match.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── 错误码 ─────────────────────────────────────────────────────────────── */
typedef enum {
    AM_OK = 0,
    AM_ERR_ARG = -1,
    AM_ERR_IO = -2,
    AM_ERR_FORMAT = -3,   /* 不是 ZIP / 不是 PNG / 结构损坏 */
    AM_ERR_DEFLATE = -4,  /* deflate 流损坏 */
    AM_ERR_UNSUPPORTED = -5, /* PNG 位深/颜色类型不支持，或 ZIP 用了不支持的压缩方法 */
    AM_ERR_TRUNCATED = -6,
    AM_ERR_NOMEM = -7
} am_status;

const char *am_strerror(int status);

/* ── ZIP (.auto) 读取 ───────────────────────────────────────────────────── */
typedef struct am_auto am_auto;

/* 打开 .auto 文件并读入内存（.auto 量级为几十 MB，全量常驻最省事，也避免随机读）。
 * 只解析中央目录，不提前解压任何条目。 */
int am_auto_open(const char *path, am_auto **out);
int am_auto_open_memory(const void *data, size_t size, am_auto **out);
void am_auto_close(am_auto *zip);

/* 条目数量 / 第 i 个条目的名字（名字保证以 '\0' 结尾，位于 ZIP 内部缓冲区） */
int am_auto_count(const am_auto *zip);
const char *am_auto_name(const am_auto *zip, int index);

/* 解压指定名字的条目到调用方提供的缓冲区。
 *   buf == NULL 时只把解压后大小写进 *out_size（用于先问大小）。
 *   *out_size 传入缓冲区容量，返回时写入实际大小；容量不足返回 AM_ERR_TRUNCATED。 */
int am_auto_read(const am_auto *zip, const char *name, void *buf, size_t *out_size);

/* 便捷：内部 malloc 并解压，调用方 free()。名字不存在返回 AM_ERR_IO。 */
int am_auto_read_alloc(const am_auto *zip, const char *name,
                       unsigned char **out, size_t *out_size);

/* 条目是否存在 */
int am_auto_has(const am_auto *zip, const char *name);

/* ── PNG 解码 ───────────────────────────────────────────────────────────── */
/* 解码 8bit RGB / RGBA PNG 到调用方缓冲区。
 *   channels 传入期望的通道数（3 或 4）；实际 PNG 颜色类型不符时返回 AM_ERR_UNSUPPORTED，
 *   并把 *out_w/*out_h 填好（便于调用方判断是"尺寸不对"还是"格式不对"）。
 *   buf == NULL 时只回填尺寸。
 * 只支持 bitdepth=8、colortype=2(RGB)/6(RGBA)、无隔行（interlace=0）——
 * 这正是 .auto 里实际出现的形态（全部模板都是 colortype=2）。 */
int am_png_decode(const void *png, size_t size, int channels,
                  int *out_w, int *out_h, unsigned char *buf, size_t buf_size);

/* 只探测 PNG 尺寸（读 IHDR，不解压）。成功返回 0。
 * 用它可以先问尺寸再分配 —— 不要为了问尺寸去给 am_png_decode_gray 传伪缓冲。 */
int am_png_size(const void *png, size_t size, int *out_w, int *out_h);

/* 一步到位：解码 PNG 并转灰度。灰度系数与 OpenCV 的 BGR2GRAY/BGRA2GRAY 一致
 *   gray = (R*77 + G*150 + B*29) >> 8        （定点、向下取整，不做舍入）
 * 结果按 row-major 灰度存入 out（宽 * 高 字节，stride = 宽）。
 * 注意：out 不可为 NULL（要问尺寸请用 am_png_size）。 */
int am_png_decode_gray(const void *png, size_t size, unsigned char *out, size_t out_size,
                       int *out_w, int *out_h);

/* 把已解码的 RGB/RGBA 像素转灰度（供测试与非 PNG 来源复用） */
void am_gray_from_rgb(const unsigned char *rgb, int w, int h, int channels,
                      unsigned char *out);

#ifdef __cplusplus
}
#endif
#endif /* AM_CONTAINER_H */
