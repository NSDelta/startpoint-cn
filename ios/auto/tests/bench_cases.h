/* bench_cases.h —— 由 tools/make_bench_cases.py 生成，请勿手改 */
#ifndef BENCH_CASES_H
#define BENCH_CASES_H

/* 帧候选（1080x1920）：原图平铺在 pkg/ 下，按 size_info 来源区分 */
typedef struct { const char *file; int is_frame; int is_template; int rect_x, rect_y, rect_w, rect_h; } bench_case;

static const bench_case BENCH_REAL_CASES[] = {
    { "1789816424515.png", 0, 1, 309, 1237, 167, 49 },   /* 幻想 */
    { "1789819709914.png", 0, 1, 308, 1522, 135, 34 },   /* 不可续战 */
    { "1789816064621.png", 0, 1, 457, 1617, 214, 48 },   /* 挑战 */
    { "1789815889030.png", 0, 1, 497, 1781, 85, 41 },   /* 继续 */
    { "1789815990830.png", 0, 1, 671, 1778, 172, 47 },   /* 继续挑战 */
    { "1789820061325.png", 0, 1, 509, 1784, 63, 37 },   /* OK */
    { "1789816623365.png", 0, 1, 468, 1152, 143, 30 },   /* 没开招募 */
    { "1789816658183.png", 0, 1, 444, 1221, 186, 46 },   /* 招募 */
    { "1789816700858.png", 0, 1, 702, 1360, 165, 44 },   /* 开始招募 */
};
#define BENCH_REAL_CASE_COUNT 9

#endif /* BENCH_CASES_H */
