/* 由 tools/make_matcher_golden.py 生成，请勿手改。*/
#ifndef AUTO_MATCH_GOLDEN_CASES_H
#define AUTO_MATCH_GOLDEN_CASES_H

typedef struct {
    const char *tag;
    int tpl_w, tpl_h, roi_w, roi_h;
    double expect_peak;
    int expect_x, expect_y;
} am_golden_case;

static const am_golden_case AM_GOLDEN_CASES[] = {
    { "c00_cond_M1GhcK", 165, 26, 476, 505, 1, 118, 272 },
    { "c01_cond_msiNQO", 135, 34, 454, 337, 0.99999767541885376, 156, 158 },
    { "c02_cond_JjOLX2", 214, 48, 703, 497, 0.9999995231628418, 271, 206 },
    { "c03_cond_2lMSzb", 77, 33, 671, 435, 1, 282, 294 },
    { "c04_cond_aX2Gto", 172, 47, 494, 397, 0.99999988079071045, 150, 255 },
    { "c05_cond_pCJ6Rk", 63, 37, 501, 378, 1, 215, 242 },
    { "c06_cond_6IfiNO", 143, 30, 494, 395, 1, 176, 139 },
    { "c07_cond_BqhUaU", 186, 46, 577, 504, 1, 182, 232 },
    { "c08_cond_mH7FSK", 165, 44, 599, 384, 0.99999809265136719, 221, 176 },
};

#define AM_GOLDEN_COUNT 9

#endif
