/*
 * test_script.c -- model layer (auto_script.c) tests.
 *
 * Two fixture layouts are exercised:
 *   - a flat directory (matcher_golden_pkg/pkg) where every PNG sits beside
 *     script.json, driven through a directory-backed am_script_io
 *   - a real .auto archive, driven through am_script_load_auto
 *
 * The assertions that matter are the ones that would silently mis-click:
 * variant selection, the x/y scaling split, and the click rectangle handed to
 * the random point picker.
 */
#include "auto_script.h"
#include "am_container.h"
#include "am_json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static int g_pass = 0, g_fail = 0;

/* Fixture directory in effect, so helper tests can derive sibling paths. */
static const char *g_fixture_dir = NULL;

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

static void check(int cond, const char *what, const char *detail)
{
    if (cond) ok(what); else bad(what, detail);
}

/* ------------------------------------------------------------------ *
 * directory-backed io
 * ------------------------------------------------------------------ */

typedef struct {
    char dir[512];
} dir_ctx;

static int dir_read(void *ctx, const char *name, void **out_data, size_t *out_size)
{
    dir_ctx *c = (dir_ctx *)ctx;
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s", c->dir, name);

    FILE *f = fopen(path, "rb");
    if (!f) return -1;

    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    const long n = ftell(f);
    if (n < 0) { fclose(f); return -1; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return -1; }

    void *buf = malloc((size_t)n);
    if (!buf) { fclose(f); return -1; }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) {
        free(buf);
        fclose(f);
        return -1;
    }
    fclose(f);
    *out_data = buf;
    *out_size = (size_t)n;
    return 0;
}

static int load_dir_script(am_script *s, const char *dir, const am_screen *screen)
{
    dir_ctx *c = (dir_ctx *)calloc(1, sizeof(*c));
    snprintf(c->dir, sizeof(c->dir), "%s", dir);

    am_script_io io;
    io.ctx = c;
    io.read = dir_read;
    io.release = NULL;              /* default release is free() */

    am_script_init(s, &io);

    /* read script.json through the same callback so the test exercises it */
    void *json = NULL;
    size_t json_size = 0;
    if (dir_read(c, "script.json", &json, &json_size) != 0) {
        fprintf(stderr, "cannot read %s/script.json\n", dir);
        free(c);
        return -1;
    }
    const int rc = am_script_load_json(s, (const char *)json, json_size, screen);
    free(json);
    return rc;
}

/* ------------------------------------------------------------------ *
 * header / counts
 * ------------------------------------------------------------------ */

static void test_header(am_script *s)
{
    char msg[256];

    snprintf(msg, sizeof(msg), "header.name = \"%s\"", s->header.name);
    check(s->header.name[0] != '\0', msg, "empty");

    /* loop_interval is milliseconds in JSON, seconds in the model */
    snprintf(msg, sizeof(msg), "loop_interval = %.4f s (JSON had 30 ms)", s->header.loop_interval);
    check(fabs(s->header.loop_interval - 0.030) < 1e-9, msg, "unit conversion wrong");

    snprintf(msg, sizeof(msg), "expand_size = %d", s->header.expand_size);
    check(s->header.expand_size == 0, msg, NULL);

    snprintf(msg, sizeof(msg), "adapter = %d", s->header.adapter);
    check(s->header.adapter == 1, msg, NULL);

    snprintf(msg, sizeof(msg), "%d template groups", s->template_group_count);
    check(s->template_group_count == 11, msg, "expected 11 groups in this sample");

    snprintf(msg, sizeof(msg), "%d variables", s->var_count);
    check(s->var_count == 9, msg, "expected 9 vars in this sample");

    snprintf(msg, sizeof(msg), "%d scenes (scene_list + default_scene)", s->scene_count);
    check(s->scene_count == 10, msg, "expected 10 scenes in this sample");

    /* every scene's condition/action counts must be non-zero for the enabled ones */
    int enabled = 0, disabled = 0;
    for (int i = 0; i < s->scene_count; i++) {
        if (s->scenes[i].disabled) disabled++;
        else enabled++;
    }
    snprintf(msg, sizeof(msg), "%d enabled / %d disabled scenes", enabled, disabled);
    check(enabled == 8 && disabled == 2, msg, "expected 8 enabled + 2 disabled");
}

static void test_scene_names(am_script *s)
{
    /* These are UTF-8 byte sequences, not escapes: comparing bytes is the point,
     * because a mis-transcribed name would silently never match a scene. */
    static const char *expect[] = {
        "\xe5\xb9\xbb\xe6\x83\xb3",             /* 幻想 */
        "\xe5\xbc\x80\xe5\xa7\x8b\xe5\xb9\xbb\xe6\x83\xb3",   /* 开始幻想 (NOT 开始连战: that is the script name) */
        "\xe6\x8c\x91\xe6\x88\x98",             /* 挑战 */
        "\xe7\xbb\xa7\xe7\xbb\xad",             /* 继续 */
        "\xe7\xbb\xa7\xe7\xbb\xad\xe6\x8c\x91\xe6\x88\x98",   /* 继续挑战 */
        "OK",
        "\xe6\xb2\xa1\xe5\xbc\x80\xe6\x8b\x9b\xe5\x8b\x9f",   /* 没开招募 */
        "\xe5\xbc\x80\xe5\xa7\x8b\xe6\x8b\x9b\xe5\x8b\x9f",   /* 开始招募 */
    };
    int allok = 1;
    for (int i = 0; i < 8; i++) {
        if (strcmp(s->scenes[i].name, expect[i]) != 0) {
            printf("      scene[%d] name mismatch\n", i);
            allok = 0;
        }
    }
    check(allok, "scene names byte-exact (UTF-8)", NULL);

    /* the two disabled scenes are the last two */
    check(strcmp(s->scenes[8].name, "\xe5\x85\xb1\xe6\x96\x97") == 0 && s->scenes[8].disabled,
          "scene[8] = 共斗 and disabled", NULL);
    check(strcmp(s->scenes[9].name, "\xe8\xbf\x94\xe5\x9b\x9e\xe6\x88\xbf\xe9\x97\xb4") == 0 && s->scenes[9].disabled,
          "scene[9] = 返回房间 and disabled", NULL);
}

static void test_first_scene(am_script *s)
{
    const am_scene *sc = &s->scenes[0];

    char msg[256];
    snprintf(msg, sizeof(msg), "scene 0 (幻想): %d conditions, %d actions",
             sc->events[0].item_count, sc->events[0].action_count);
    check(sc->events[0].item_count == 1 && sc->events[0].action_count == 1, msg, "unexpected shape");

    const am_cond *c = &sc->events[0].items[0];
    check(c->type == AM_COND_IMAGE, "scene 0 condition is an Image condition", NULL);
    check(strcmp(c->image_id, "M1GhcK6preOl4bU3") == 0, "scene 0 image_id = M1GhcK6preOl4bU3", c->image_id);
    check(strcmp(c->search_id, "ERxuPcU7LM4VtyaC") == 0, "scene 0 search_id = ERxuPcU7LM4VtyaC", c->search_id);

    const am_action *a = &sc->events[0].actions[0];
    snprintf(msg, sizeof(msg), "scene 0 action type = %d (%s)", a->type, am_action_type_name(a->type));
    check(a->type == AM_ACT_IMAGE, msg, "expected type 2 = Image");

    /* Image is a breakable action in Android (implements the marker interface),
     * so after it fires the scan restarts at the top of the scene next tick. */
    check(a->next_mode == AM_NEXT_RESTART,
          "Image action => AM_NEXT_RESTART (EditorEvent.breakable)", NULL);

    check(a->click_times == 1, "click_times = 1", NULL);
    check(fabs(a->postpone - 1.0) < 1e-9, "postpone = 1 s", NULL);
}

static void test_multi_condition_scene(am_script *s)
{
    /* 没开招募 is the only scene with two conditions -- the case that exercises
     * group relation handling. */
    const am_scene *sc = &s->scenes[6];
    const am_event *ev = &sc->events[0];

    char msg[128];
    snprintf(msg, sizeof(msg), "scene 6 has %d conditions (expected 2)", ev->item_count);
    check(ev->item_count == 2, msg, NULL);

    check(ev->relation != 2, "scene 6 group relation is AND (not 2)", NULL);
    check(ev->items[0].relation == 1 && ev->items[1].relation == 1,
          "both scene 6 conditions are relation 1 (AND)", NULL);

    /* different template groups: 没开招募 and 招募 */
    check(strcmp(ev->items[0].image_id, ev->items[1].image_id) != 0,
          "scene 6 conditions reference two different templates", NULL);
}

/* ------------------------------------------------------------------ *
 * adaptation math
 * ------------------------------------------------------------------ */

static void test_adapt_rect(void)
{
    /* Same resolution => identity. This is the path an iPhone 7 Plus / 8 Plus
     * (1080x1920) takes against the 1080x1920 variants, and it must be exact. */
    {
        am_screen cur;   am_screen_make(&cur, 1080, 1920, 280);
        am_screen_info rec; memset(&rec, 0, sizeof(rec));
        rec.width = 1080; rec.height = 1920; rec.density = 280;

        am_rect r; r.x = 309; r.y = 1237; r.w = 167; r.h = 49;
        const am_rect o = am_adapt_rect(&cur, &rec, r);
        check(o.x == 309 && o.y == 1237 && o.w == 167 && o.h == 49,
              "adapt 1080x1920 -> 1080x1920 is identity", NULL);
    }

    /* A 9:10 recording on a 9:16 device. The factor is uniform, taken from the
     * SHORT edges (540/600 = 0.9), so both axes shrink by the same 0.9.
     *
     * This is the case where Android's own rule goes wrong: getAdapterValue
     * computes dx = cur_long/rec_short = 1080/600 = 1.8 and
     * dy = cur_short/rec_short = 960/600 = 1.6, a 12.5% horizontal stretch on
     * top of a 60% upscale. If this test ever reports x=278,w=857 then someone
     * has "restored" the literal two-factor Android rule. */
    {
        am_screen cur;   am_screen_make(&cur, 1080, 1920, 280);
        am_screen_info rec; memset(&rec, 0, sizeof(rec));
        rec.width = 1200; rec.height = 2000; rec.density = 280;

        am_rect r; r.x = 209; r.y = 1029; r.w = 476; r.h = 505;
        const am_rect o = am_adapt_rect(&cur, &rec, r);
        char msg[192];
        snprintf(msg, sizeof(msg),
                 "9:10 rec -> 9:16 device: (%d,%d,%d,%d)", o.x, o.y, o.w, o.h);
        check(o.x == 188 && o.y == 926 && o.w == 428 && o.h == 455, msg,
              "expected (188,926,428,455) = uniform 0.9");
    }

    /* Portrait upscale 1080x1920 -> 2025x2700: 2025/1080 = 1.875, so recorded
     * short edge 1080 maps to 2025 and short edge 1920 -> 2700 * 1.875 = 3600.
     * The point of the asymmetric numbers is that a faithful two-factor
     * implementation would give w=225 (1920/1920 = 1.0) instead of 225... no:
     * the numbers below are chosen so a *non-uniform* implementation is caught:
     * with rec_long=1920 and rec_short=1080 the two candidate factors are 1.875
     * and 1.0, so any axis mix-up changes w or h. */
    {
        am_screen cur;   am_screen_make(&cur, 2025, 2700, 560);
        am_screen_info rec; memset(&rec, 0, sizeof(rec));
        rec.width = 1080; rec.height = 1920; rec.density = 280;

        am_rect r; r.x = 300; r.y = 600; r.w = 120; r.h = 60;
        const am_rect o = am_adapt_rect(&cur, &rec, r);
        char msg[192];
        snprintf(msg, sizeof(msg),
                 "1080x1920 -> 2025x2700: (%d,%d,%d,%d)", o.x, o.y, o.w, o.h);
        check(o.x == 563 && o.y == 1125 && o.w == 225 && o.h == 113, msg,
              "expected (563,1125,225,113) = uniform 1.875");
    }

    /* Downscale onto a smaller screen: w,h must never collapse to 0. 3 * 0.375
     * rounds to 1, but a smaller recording or a bigger ratio would floor to 0 and
     * silently turn the search region into nothing. */
    {
        am_screen cur;   am_screen_make(&cur, 540, 960, 140);
        am_screen_info rec; memset(&rec, 0, sizeof(rec));
        rec.width = 1440; rec.height = 3200;

        am_rect r; r.x = 10; r.y = 10; r.w = 3; r.h = 3;
        const am_rect o = am_adapt_rect(&cur, &rec, r);
        char msg[160];
        snprintf(msg, sizeof(msg), "tiny rect downscaled to %dx%d", o.w, o.h);
        check(o.w >= 1 && o.h >= 1, msg, "rect collapsed to zero area");
    }

    /* Cross-orientation: a LANDSCAPE current frame replaying a PORTRAIT
     * recording. The landscape branch divides by the recorded LONG edge
     * (3000/2000 = 1.5), so again one factor for both axes. Reaching for a
     * recorded long edge on a portrait screen -- or pairing cur_long with
     * rec_long and cur_short with rec_short -- gives a different answer here. */
    {
        am_screen cur;   am_screen_make(&cur, 3000, 1500, 280);
        am_screen_info rec; memset(&rec, 0, sizeof(rec));
        rec.width = 1000; rec.height = 2000;

        am_rect r; r.x = 100; r.y = 600; r.w = 200; r.h = 60;
        const am_rect o = am_adapt_rect(&cur, &rec, r);
        char msg[192];
        snprintf(msg, sizeof(msg),
                 "portrait rec -> landscape cur: (%d,%d,%d,%d)", o.x, o.y, o.w, o.h);
        check(o.x == 150 && o.y == 900 && o.w == 300 && o.h == 90, msg,
              "expected (150,900,300,90) = uniform 1.5");
    }
}

/*
 * The 幻想 group records the same button three times:
 *
 *   png=165x26  rect=327,1301,165,26  rec=1200x2000@280
 *   png=167x49  rect=309,1237,167,49  rec=1080x1920@280
 *   png=211x43  rect=416,1857,211,43  rec=1440x3200@560
 *
 * In every variant the PNG blob is exactly rect.w x rect.h pixels, and the rect
 * is that blob's placement on its recording screen. So "no resampling" must mean
 * "the rendered template is rect.w x rect.h", not "the rendered template equals
 * the recorded screen size".
 *
 * Selection (EditorImage.createImage): an exact screen_info match wins; else
 * getAdapterInfo picks the smallest |density difference|, and we only fall back
 * to the resolution margin when two variants tie on density.
 *
 * At 1080x1920@280:   v1 exact (1080x1920@280)                 -> v1, no scale
 * At 1440x3200@560:   v2 exact (1440x3200@560)                 -> v2, no scale
 * At 1170x2532@460:   density deltas 180 / 180 / 100           -> v2 (1440x3200)
 * At 1170x2532@280:   v0 and v1 both delta 0, margin 562 vs 702 -> v0 (1200x2000)
 *
 * The last two are the meaningful ones: 460 is where a density-primary rule and
 * a resolution-primary rule give DIFFERENT answers (v2 vs v0), so it pins the
 * policy down; 280 exercises the margin tie-break.
 */
static void test_variant_selection(am_script *s)
{
    am_template_group *g = am_script_find_group(s, "M1GhcK6preOl4bU3");
    check(g != NULL, "find group by id (M1GhcK6preOl4bU3)", NULL);
    if (!g) return;

    check(g->variant_count == 3, "group 幻想 has 3 variants", NULL);
    check(fabs(g->sim - 0.8) < 1e-9, "group sim = 0.8 (group level, not per variant)", NULL);
    check(g->adapter_type == -1, "group adapter_type absent => -1 => script adapter", NULL);
    check(s->header.adapter == 1, "script adapter = 1 (adaptation enabled)", NULL);

    /* --- exact match at the 1080x1920 recording resolution ---------------- */
    {
        am_screen cur; am_screen_make(&cur, 1080, 1920, 280);
        am_script_set_screen(s, &cur);

        const am_rect r = am_script_group_rect(s, g);
        char msg[192];
        snprintf(msg, sizeof(msg), "幻想 rect at 1080x1920 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 309 && r.y == 1237 && r.w == 167 && r.h == 49, msg,
              "expected the 1080x1920 variant rect (309,1237,167,49)");

        const am_mat *m = am_script_template(s, g);
        if (!m) { bad("render 幻想 at 1080x1920", "returned NULL"); }
        else {
            snprintf(msg, sizeof(msg), "幻想 at 1080x1920 rendered %dx%d (png is 167x49)",
                     m->width, m->height);
            check(m->width == 167 && m->height == 49, msg,
                  "must be the unscaled 167x49 blob");
        }
    }

    /* --- exact match at the 1440x3200 recording resolution ---------------- */
    {
        am_screen cur; am_screen_make(&cur, 1440, 3200, 560);
        am_script_set_screen(s, &cur);

        const am_rect r = am_script_group_rect(s, g);
        char msg[192];
        snprintf(msg, sizeof(msg), "幻想 rect at 1440x3200 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 416 && r.y == 1857 && r.w == 211 && r.h == 43, msg,
              "expected the 1440x3200 variant rect (416,1857,211,43)");

        const am_mat *m = am_script_template(s, g);
        if (!m) { bad("render 幻想 at 1440x3200", "returned NULL"); }
        else {
            snprintf(msg, sizeof(msg), "幻想 at 1440x3200 rendered %dx%d (png is 211x43)",
                     m->width, m->height);
            check(m->width == 211 && m->height == 43, msg,
                  "must be the unscaled 211x43 blob");
        }
    }

    /* --- no exact match: density decides, margins only break ties --------- */
    {
        am_screen cur; am_screen_make(&cur, 1170, 2532, 460);   /* iPhone 12/13 */
        am_script_set_screen(s, &cur);

        /* density differences are 180 / 180 / 100 against the three variants,
         * and Android's getAdapterInfo compares DENSITY ONLY, so v2 (1440x3200@560)
         * wins outright despite having by far the worst margin (562 / 702 / 938).
         * This case is what pins the primary metric down: a resolution-driven
         * implementation would pick v0 here. */
        const double f = 1170.0 / 1440.0;                        /* 0.8125 */
        const int w0 = (int)lround(211.0 * f);                   /* 171 */
        const int h0 = (int)lround(43.0  * f);                   /* 35  */

        const am_rect r = am_script_group_rect(s, g);
        char msg[224];
        snprintf(msg, sizeof(msg), "幻想 rect at 1170x2532@460 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 338 && r.y == 1509 && r.w == w0 && r.h == h0, msg,
              "closest DENSITY wins: v2 1440x3200@560");

        const am_mat *m = am_script_template(s, g);
        if (!m) { bad("render 幻想 at 1170x2532@460", "returned NULL"); }
        else {
            snprintf(msg, sizeof(msg),
                     "幻想 at 1170x2532@460 rendered %dx%d (want %dx%d, f=%.5f)",
                     m->width, m->height, w0, h0, f);
            check(m->width == w0 && m->height == h0, msg,
                  "0.8125 scale of the 211x43 blob");
        }
    }

    /* --- equal density: margins break the tie ----------------------------- */
    {
        am_screen cur; am_screen_make(&cur, 1170, 2532, 280);
        am_script_set_screen(s, &cur);

        /* v0 (1200x2000@280) and v1 (1080x1920@280) both match the density
         * exactly, so the margin term decides: 562 for v0 against 702 for v1
         * (v2 is 280 away on density and loses before the tie-break). */
        const double f = 1170.0 / 1200.0;                        /* 0.975 */
        const int w0 = (int)lround(165.0 * f);                   /* 161 */
        const int h0 = (int)lround(26.0  * f);                   /* 25  */

        const am_rect r = am_script_group_rect(s, g);
        char msg[224];
        snprintf(msg, sizeof(msg), "幻想 rect at 1170x2532@280 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 319 && r.y == 1268 && r.w == w0 && r.h == h0, msg,
              "density tie -> nearest margins pick v0, 1200x2000");

        const am_mat *m = am_script_template(s, g);
        if (!m) { bad("render 幻想 at 1170x2532@280", "returned NULL"); }
        else {
            snprintf(msg, sizeof(msg),
                     "幻想 at 1170x2532@280 rendered %dx%d (want %dx%d, f=%.5f)",
                     m->width, m->height, w0, h0, f);
            check(m->width == w0 && m->height == h0, msg,
                  "0.975 scale of the 165x26 blob");
        }
    }

    /* --- a single-variant group still adapts ------------------------------ */
    {
        /* 共斗 has only a 1200x2000 variant; a 1080x1920 device must still get a
         * usable rect (it has no exact match and no alternative). */
        am_template_group *g9 = am_script_find_group(s, "iRz7fJ98epgPHmEB");
        if (!g9) { bad("find group iRz7fJ98epgPHmEB (共斗)", "not found"); }
        else {
            am_screen cur; am_screen_make(&cur, 1080, 1920, 280);
            am_script_set_screen(s, &cur);
            const am_rect r = am_script_group_rect(s, g9);
            const int w0 = (int)lround(229.0 * 0.9);             /* 206 */
            const int h0 = (int)lround(40.0  * 0.9);             /* 36  */
            char msg[192];
            snprintf(msg, sizeof(msg), "共斗 rect = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
            check(r.w == w0 && r.h == h0, msg, "expected 206x36 at 1080x1920");
        }
    }
}

/* ------------------------------------------------------------------ *
 * click rectangles
 * ------------------------------------------------------------------ */

static void test_click_rect(am_script *s)
{
    am_var *v = am_script_find_var(s, "ERxuPcU7LM4VtyaC");
    check(v != NULL, "find var ERxuPcU7LM4VtyaC (幻想 search/click var)", NULL);
    if (!v) return;

    char msg[224];
    snprintf(msg, sizeof(msg), "var ERxuPcU7LM4VtyaC has %d crops", v->crop_count);
    check(v->crop_count > 0, msg, "no crops => no click rectangle");

    am_template_group *g = am_script_find_group(s, "M1GhcK6preOl4bU3");

    /* The variable was recorded at 1200x2000; the crop is 209,1029,476,505.
     * At 1080x1920 the uniform factor is 1080/1200 = 0.9, so the click rectangle
     * is (188,926,428,455). It must NOT be clamped to the frame even when a
     * recording is replayed on a frame with a different aspect ratio: the search
     * region and the template scale together, so the match still lands. */
    {
        am_screen cur; am_screen_make(&cur, 1080, 1920, 280);
        am_script_set_screen(s, &cur);

        const am_rect r = am_script_crop_rect(s, v, 0);
        snprintf(msg, sizeof(msg), "crop[0] at 1080x1920 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 188 && r.y == 926 && r.w == 428 && r.h == 455, msg,
              "expected (188,926,428,455) = recorded rect scaled by 0.9");

        /* the search region must be at least as large as the template, or the
         * matcher could never place it and the scene could never fire */
        if (g) {
            const am_rect t = am_script_group_rect(s, g);
            snprintf(msg, sizeof(msg), "template (%d,%d,%d,%d) fits in crop (%d,%d,%d,%d)",
                     t.x, t.y, t.w, t.h, r.x, r.y, r.w, r.h);
            check(r.w >= t.w && r.h >= t.h, msg, "search region smaller than template");
        }
    }

    /* At the recording resolution of the variant the group picks, everything is
     * pixel-exact: the crop comes back untouched at 1200x2000 and the template
     * equals its blob. This is the configuration the script was authored for and
     * must round-trip exactly. */
    {
        am_screen cur; am_screen_make(&cur, 1200, 2000, 280);
        am_script_set_screen(s, &cur);

        const am_rect r = am_script_crop_rect(s, v, 0);
        snprintf(msg, sizeof(msg), "crop[0] at 1200x2000 = (%d,%d,%d,%d)", r.x, r.y, r.w, r.h);
        check(r.x == 209 && r.y == 1029 && r.w == 476 && r.h == 505, msg,
              "identity at the recording resolution");

        if (g) {
            const am_mat *m = am_script_template(s, g);
            snprintf(msg, sizeof(msg), "幻想 at 1200x2000 rendered %dx%d", m ? m->width : -1,
                     m ? m->height : -1);
            check(m && m->width == 165 && m->height == 26, msg,
                  "the 165x26 blob of the exact-match variant");
        }
    }
}

static void test_expand_size(am_script *s)
{
    am_rect t; t.x = 100; t.y = 200; t.w = 50; t.h = 40;

    /* expand_size is 0 in this sample, so the helper must be the identity */
    const am_rect o = am_script_search_rect_from_template(s, t);
    check(o.x == 100 && o.y == 200 && o.w == 50 && o.h == 40,
          "expand_size=0 => search rect == template rect", NULL);

    /* and with a non-zero expand_size it grows on all four sides */
    const int saved = s->header.expand_size;
    s->header.expand_size = 10;
    const am_rect o2 = am_script_search_rect_from_template(s, t);
    char msg[128];
    snprintf(msg, sizeof(msg), "expand_size=10 => (%d,%d,%d,%d)", o2.x, o2.y, o2.w, o2.h);
    check(o2.x == 90 && o2.y == 190 && o2.w == 70 && o2.h == 60, msg, "expected (90,190,70,60)");
    s->header.expand_size = saved;
}

/* ------------------------------------------------------------------ *
 * .auto (ZIP) path
 * ------------------------------------------------------------------ */

static void test_auto_archive(const char *auto_path)
{
    /* When no archive was named on the command line, look for the canonical one
     * beside the directory fixture. A NULL path would crash fopen, and silently
     * skipping the ZIP path would hide it from the suite entirely.
     * The fixtures live as matcher_golden_pkg/pkg (flat directory) and
     * matcher_golden_pkg/sample.auto (the real archive), so the archive is the
     * directory's sibling, not its child. */
    char derived[600];
    if (!auto_path) {
        const char *dir = g_fixture_dir ? g_fixture_dir : "";
        const char *slash = strrchr(dir, '/');
        const char *bslash = strrchr(dir, '\\');
        if (bslash && (!slash || bslash > slash)) slash = bslash;
        if (slash) {
            snprintf(derived, sizeof(derived), "%.*s/sample.auto", (int)(slash - dir), dir);
        } else {
            snprintf(derived, sizeof(derived), "sample.auto");
        }
        auto_path = derived;
    }

    FILE *f = fopen(auto_path, "rb");
    if (!f) {
        printf("  SKIP .auto archive test (no %s)\n", auto_path);
        return;
    }
    fclose(f);

    am_screen cur; am_screen_make(&cur, 1080, 1920, 280);

    /* am_script is megabytes: heap only (see the budget note in auto_script.h) */
    am_script *sp = (am_script *)calloc(1, sizeof(am_script));
    if (!sp) { bad(".auto test", "calloc(am_script) failed"); return; }
    am_script *s = sp;
    am_script_init(s, NULL);
    if (am_script_load_auto(s, auto_path, &cur) != 0) {
        char msg[256];
        snprintf(msg, sizeof(msg), "load .auto failed: %s", s->error);
        bad("am_script_load_auto", msg);
        am_script_free(s);
        free(s);
        return;
    }
    ok("am_script_load_auto parses the archive");

    char msg[160];
    snprintf(msg, sizeof(msg), ".auto: %d groups, %d vars, %d scenes",
             s->template_group_count, s->var_count, s->scene_count);
    check(s->template_group_count > 0 && s->var_count > 0 && s->scene_count > 0, msg, "empty");

    /* templates must be readable straight out of the archive (no extraction) */
    if (s->template_group_count > 0) {
        const am_mat *m = am_script_template(s, &s->groups[0]);
        if (!m) {
            bad(".auto template render", "returned NULL (zip entry read failed?)");
        } else {
            snprintf(msg, sizeof(msg), ".auto group[0] \"%s\" rendered %dx%d",
                     s->groups[0].name, m->width, m->height);
            check(m->width > 0 && m->height > 0, msg, "zero-size template");
        }
    }

    am_script_free(s);
    free(s);
    ok("am_script_free after .auto load (closes archive, no leak)");
}

/* ------------------------------------------------------------------ */

int main(int argc, char **argv)
{
    /* Unbuffered: a crash must not swallow the output that says where it happened. */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    const char *dir = (argc > 1) ? argv[1] : "matcher_golden_pkg/pkg";
    const char *auto_path = (argc > 2) ? argv[2] : NULL;
    g_fixture_dir = dir;

    printf("== auto_script test ==\nfixture: %s\n", dir);

    am_screen cur; am_screen_make(&cur, 1080, 1920, 280);

    /* am_script is megabytes: heap only. As a local it overflows the thread stack
     * and the process dies with STATUS_STACK_OVERFLOW (0xC00000FD) and no output. */
    am_script *s = (am_script *)calloc(1, sizeof(am_script));
    if (!s) { fprintf(stderr, "calloc(am_script) failed\n"); return 1; }

    printf("[1] load script.json from directory\n");
    if (load_dir_script(s, dir, &cur) != 0) {
        fprintf(stderr, "load failed: %s\n", s->error);
        return 1;
    }
    ok("am_script_load_json succeeded");

    printf("[2] header and counts\n");
    test_header(s);

    printf("[3] scene names and flags\n");
    test_scene_names(s);

    printf("[4] scene contents\n");
    test_first_scene(s);
    test_multi_condition_scene(s);

    printf("[5] resolution adaptation\n");
    test_adapt_rect();

    printf("[6] variant selection and template rendering\n");
    test_variant_selection(s);

    printf("[7] click rectangles\n");
    test_click_rect(s);
    test_expand_size(s);

    am_script_free(s);
    free(s);
    ok("am_script_free (directory-backed)");

    printf("[8] .auto archive path\n");
    test_auto_archive(auto_path);

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
