/*
 * test_engine -- end-to-end checks for core/auto_engine.c.
 *
 * Two fixtures:
 *
 *   [A] the real package fixture (matcher_golden_pkg/pkg). A fake host feeds the
 *       original screenshot that the golden case p00 was computed from, and the
 *       engine has to walk scene 0 (HUAN XIANG) all the way to a tap whose
 *       coordinates land inside the match rectangle the golden case pins down.
 *       This is the only test that proves the whole chain -- JSON -> variant ->
 *       search rect -> FFT match -> random point -- agrees with OpenCV.
 *
 *   [B] a synthetic script assembled here. It cannot describe real scenes, but
 *       it can isolate two rules that the real script cannot reach: the
 *       first-leaf-replaces fold in framework/i/m.b(), and scene dispatch order.
 *
 * The host callbacks are deliberately dumb: capture copies a pre-decoded gray
 * buffer, sleep accumulates milliseconds instead of sleeping, now_ms returns a
 * frozen clock (so no timeout ever expires), and touch records.
 */
#include "auto_engine.h"
#include "auto_script.h"
#include "am_container.h"
#include "am_json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static int g_pass = 0, g_fail = 0;

static void check(int cond, const char *what, const char *detail)
{
    if (cond) {
        g_pass++;
        printf("  PASS %s\n", what);
    } else {
        g_fail++;
        printf("  FAIL %s%s%s\n", what, detail ? " -- " : "", detail ? detail : "");
    }
}

/* ------------------------------------------------------------------ *
 * fake host
 * ------------------------------------------------------------------ */

typedef struct {
    unsigned char *gray;        /* frame the host will "capture" */
    int            w, h;

    int  fail_capture;          /* when set, capture() reports failure */
    long long slept_ms;         /* accumulated */
    long long now;              /* frozen clock */
    int  capture_calls;

    int  last_x, last_y, last_press;
    int  touch_calls;
    int  touch_fail;            /* when set, touch() reports failure */

    int  trace_calls;
} fake_host;

static int fh_capture(void *ctx, unsigned char *dst, int w, int h, int stride)
{
    fake_host *f = (fake_host *)ctx;
    f->capture_calls++;
    if (f->fail_capture) return -1;
    if (!f->gray || f->w != w || f->h != h) return -1;
    for (int y = 0; y < h; y++) {
        memcpy(dst + (size_t)y * (size_t)stride, f->gray + (size_t)y * (size_t)w, (size_t)w);
    }
    return 0;
}

static int fh_touch(void *ctx, int x, int y, int press_ms)
{
    fake_host *f = (fake_host *)ctx;
    f->touch_calls++;
    f->last_x = x;
    f->last_y = y;
    f->last_press = press_ms;
    return f->touch_fail ? -1 : 0;
}

static void fh_sleep(void *ctx, int ms)
{
    fake_host *f = (fake_host *)ctx;
    f->slept_ms += ms;
    f->now += ms;
}

static long long fh_now(void *ctx)
{
    return ((fake_host *)ctx)->now;
}

static void fh_trace(void *ctx, const char *msg)
{
    (void)msg;
    ((fake_host *)ctx)->trace_calls++;
}

static void fh_make_host(fake_host *f, am_engine_host *host)
{
    host->ctx = f;
    host->capture = fh_capture;
    host->touch = fh_touch;
    host->sleep_ms = fh_sleep;
    host->now_ms = fh_now;
    host->trace = fh_trace;
}

/* ------------------------------------------------------------------ *
 * directory-backed script io
 * ------------------------------------------------------------------ */

typedef struct {
    char dir[512];
    /* Up to two entry names that are served from `inline_path` instead of
     * `dir`. Used by the synthetic test, whose templates are generated into the
     * working directory because the real fixture directory is read-only. */
    const char *inline_name[2];
    char        inline_path[2][256];
} dir_ctx;

static int dir_read(void *ctx, const char *name, void **out_data, size_t *out_size)
{
    dir_ctx *c = (dir_ctx *)ctx;
    char path[1024];

    int served = 0;
    for (int i = 0; i < 2; i++) {
        if (!c->inline_name[i]) continue;
        /* The loader asks for "image/<file>" first and falls back to the bare
         * <file>; serve either spelling from the generated file. */
        const char *bare = name;
        if (strncmp(name, "image/", 6) == 0) bare = name + 6;
        if (strcmp(c->inline_name[i], name) == 0 || strcmp(c->inline_name[i], bare) == 0) {
            snprintf(path, sizeof(path), "%s", c->inline_path[i]);
            served = 1;
            break;
        }
    }
    if (!served) snprintf(path, sizeof(path), "%s/%s", c->dir, name);

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

static am_script *load_package(const char *dir, int w, int h)
{
    static dir_ctx c;
    memset(&c, 0, sizeof(c));
    snprintf(c.dir, sizeof(c.dir), "%s", dir);

    am_script_io io;
    io.ctx = &c;
    io.read = dir_read;
    io.release = NULL;

    am_script *s = (am_script *)calloc(1, sizeof(am_script));
    if (!s) return NULL;
    am_script_init(s, &io);

    void *json = NULL;
    size_t json_size = 0;
    if (dir_read(&c, "script.json", &json, &json_size) != 0) {
        fprintf(stderr, "cannot read %s/script.json\n", dir);
        free(s);
        return NULL;
    }

    am_screen screen;
    am_screen_make(&screen, w, h, 280);
    const int rc = am_script_load_json(s, (const char *)json, json_size, &screen);
    free(json);
    if (rc != 0) {
        fprintf(stderr, "script load failed: %s\n", s->error);
        am_script_free(s);
        free(s);
        return NULL;
    }
    return s;
}

/* Read a PNG and decode it to 8-bit grayscale. */
static unsigned char *load_gray_png(const char *path, int *out_w, int *out_h)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    const long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) { fclose(f); return NULL; }

    void *buf = malloc((size_t)n);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
    fclose(f);

    int w = 0, h = 0;
    if (am_png_size(buf, (size_t)n, &w, &h) != 0 || w <= 0 || h <= 0) {
        free(buf);
        return NULL;
    }
    unsigned char *gray = (unsigned char *)malloc((size_t)w * (size_t)h);
    if (!gray) { free(buf); return NULL; }
    if (am_png_decode_gray(buf, (size_t)n, gray, (size_t)w * (size_t)h, &w, &h) != 0) {
        free(gray);
        free(buf);
        return NULL;
    }
    free(buf);
    *out_w = w;
    *out_h = h;
    return gray;
}

/* ------------------------------------------------------------------ *
 * [A] end to end over the real package fixture
 * ------------------------------------------------------------------ */

static void test_end_to_end(const char *dir)
{
    printf("[A] end-to-end over the real package\n");

    const int W = 1200, H = 2000;       /* the recording resolution of scene 0 */

    am_script *s = load_package(dir, W, H);
    check(s != NULL, "package script loads", NULL);
    if (!s) return;

    /* The frame the golden case p00 was computed from. */
    char frame_path[1024];
    snprintf(frame_path, sizeof(frame_path), "%s/1789786626126.png", dir);

    fake_host fh;
    memset(&fh, 0, sizeof(fh));
    fh.gray = load_gray_png(frame_path, &fh.w, &fh.h);
    check(fh.gray != NULL, "golden frame decodes", frame_path);
    if (!fh.gray) { am_script_free(s); free(s); return; }

    char msg[512];
    snprintf(msg, sizeof(msg), "frame is %dx%d (want %dx%d)", fh.w, fh.h, W, H);
    check(fh.w == W && fh.h == H, "golden frame size", msg);
    if (fh.w != W || fh.h != H) {
        free(fh.gray);
        am_script_free(s);
        free(s);
        return;
    }

    am_engine_host host;
    fh_make_host(&fh, &host);

    am_engine e;
    memset(&e, 0, sizeof(e));
    check(am_engine_init(&e, s, &host, W, H) == 0, "engine inits", NULL);

    /* The sample script only uses image conditions, which this port evaluates. */
    const int unsupported = am_engine_check_supported(&e);
    snprintf(msg, sizeof(msg), "unsupported condition count = %d", unsupported);
    check(unsupported == 0, "no unsupported conditions in the sample script", msg);

    const int rc = am_engine_step(&e);
    snprintf(msg, sizeof(msg), "step returned %d", rc);
    check(rc == 1, "engine still running after one step", msg);

    const char *err = am_engine_last_error(&e);
    snprintf(msg, sizeof(msg), "last_error = \"%s\"", err);
    check(err[0] == '\0', "no error reported", msg);

    int n = 0;
    const am_tap_record *taps = am_engine_taps(&e, &n);
    snprintf(msg, sizeof(msg), "tap_count = %d", n);
    check(n == 1, "exactly one tap", msg);
    if (n != 1) {
        am_engine_free(&e);
        free(fh.gray);
        am_script_free(s);
        free(s);
        return;
    }

    const am_tap_record *t = &taps[0];

    /*
     * Ask the model directly which search rect the condition resolved. This is
     * NOT am_engine_search_rect: the sample's expand_size is -1, which makes that
     * function return the whole frame. cond_image prefers the search variable's
     * crop rect whenever the condition names one, and that is the rect the
     * engine actually matched in -- recorded on the tap as `rect`'s anchor.
     */
    am_var *v0 = am_script_find_var(s, "ERxuPcU7LM4VtyaC");
    const am_rect crop = am_script_crop_rect(s, v0, 0);

    /*
     * The golden case: 165x26 template matched at (327,1301) in the 1200x2000
     * frame with peak 0.99998. Scene 0's action has click_times = 1 and
     * press_time = 0, so the point is uniform in [327,492) x [1301,1327) and the
     * press duration is 20..49 ms.
     */
    snprintf(msg, sizeof(msg),
             "match at (%d,%d), search variable crop (%d,%d,%d,%d), peak %.6f",
             t->match.x, t->match.y, crop.x, crop.y, crop.w, crop.h, t->peak);
    check(t->match.x == 327 && t->match.y == 1301,
          "match coincides with golden maxLoc", msg);

    snprintf(msg, sizeof(msg), "crop rect = (%d,%d,%d,%d), tpl 165x26",
             crop.x, crop.y, crop.w, crop.h);
    check(crop.x == 209 && crop.y == 1029 && crop.w == 476 && crop.h == 505,
          "search variable crop is the rect the golden case used", msg);

    snprintf(msg, sizeof(msg), "peak = %.8f (want %.8f)", t->peak, 0.99997794628143311);
    check(fabs(t->peak - 0.99997794628143311) <= 3e-3, "peak within tolerance of cv2", msg);

    snprintf(msg, sizeof(msg), "tap at (%d,%d)", t->x, t->y);
    check(t->x >= 327 && t->x < 327 + 165 && t->y >= 1301 && t->y < 1301 + 26,
          "tap inside the match rectangle", msg);

    snprintf(msg, sizeof(msg), "hit rect = (%d,%d,%d,%d) (tpl 165x26)",
             t->rect.x, t->rect.y, t->rect.w, t->rect.h);
    check(t->rect.w == 165 && t->rect.h == 26 &&
          t->rect.x == t->match.x && t->rect.y == t->match.y,
          "hit rect is the template size anchored at the match, not the search rect", msg);

    snprintf(msg, sizeof(msg), "press_ms = %d", t->press_ms);
    check(t->press_ms >= 20 && t->press_ms <= 49,
          "default press_ms is uniform in [20,49]", msg);

    snprintf(msg, sizeof(msg), "action type = %d, scene = %d, event = %d",
             t->type, t->scene, t->event);
    check(t->type == AM_ACT_IMAGE && t->scene == 0 && t->event == 0,
          "tap attributed to scene 0 / event 0 / image action", msg);

    snprintf(msg, sizeof(msg), "current_scene = %d", e.current_scene);
    check(e.current_scene == 0, "scene 0 is the active scene", msg);

    check(fh.touch_calls == 1, "host saw exactly one touch", NULL);

    /* loop_interval is 30 ms, so one round must sleep at least that much. */
    snprintf(msg, sizeof(msg), "slept %lld ms in one round", fh.slept_ms);
    check(fh.slept_ms >= AM_ENGINE_MIN_INTERVAL_MS, "round honours loop_interval", msg);

    /*
     * A second round must produce the same match: the host returns the same
     * frame, but the frame counter advances, so the cache must be rebuilt (and
     * rebuilt to the same answer).
     */
    const int rc2 = am_engine_step(&e);
    snprintf(msg, sizeof(msg), "second step returned %d, frame = %d", rc2, e.frame);
    check(rc2 == 1 && e.frame == 2, "second round runs", msg);

    taps = am_engine_taps(&e, &n);
    snprintf(msg, sizeof(msg), "tap_count = %d after two rounds", n);
    check(n == 2, "two taps after two rounds", msg);
    if (n == 2) {
        snprintf(msg, sizeof(msg), "round 2 match at (%d,%d)", taps[1].match.x, taps[1].match.y);
        check(taps[1].match.x == 327 && taps[1].match.y == 1301,
              "cache rebuild across frames gives the same match", msg);
    }

    /* A dead capture must be reported, not silently looped on. */
    fh.fail_capture = 1;
    const int rc3 = am_engine_step(&e);
    snprintf(msg, sizeof(msg), "step on a failing capture returned %d (\"%s\")",
             rc3, am_engine_last_error(&e));
    check(rc3 == 0 && e.last_error == AM_ENGINE_ERR_CAPTURE,
          "capture failure stops the engine with ERR_CAPTURE", msg);
    fh.fail_capture = 0;

    /* A failing touch is recorded but must not abort the scene. */
    am_engine_reset(&e);
    am_engine_clear_taps(&e);
    fh.touch_fail = 1;
    const int rc4 = am_engine_step(&e);
    taps = am_engine_taps(&e, &n);
    snprintf(msg, sizeof(msg), "step returned %d, taps = %d, error = \"%s\"",
             rc4, n, am_engine_last_error(&e));
    check(rc4 == 1 && n == 1 && e.last_error == AM_ENGINE_ERR_TOUCH,
          "a dropped tap is reported but does not stop the script", msg);
    fh.touch_fail = 0;

    check(am_engine_error_name(AM_ENGINE_ERR_TOUCH)[0] != '\0',
          "error names are non-empty", NULL);

    am_engine_free(&e);
    free(fh.gray);
    am_script_free(s);
    free(s);
}

/* ------------------------------------------------------------------ *
 * [B] synthetic script: the condition fold and scene dispatch
 * ------------------------------------------------------------------ */

/*
 * Two template groups (A and B), both 8x8, and a search variable that covers
 * BOTH of their recorded positions. Screens are 320x480 with density 160.
 *
 *   A's variant rect  (120,120,8,8)   marker: the 4x4 pattern below
 *   B's variant rect  (160,160,8,8)   marker: a different 4x4 pattern
 *   varBoth crop rect (110,110,90,90) -> (110,110)..(200,200), contains both
 *
 * GEOMETRY IS LOAD BEARING. am_engine_search_rect() intersects the template's
 * rect with the search variable's crop rect (Android base/c.java e()), so the
 * search area always contains the place the template was recorded. If a marker
 * is placed OUTSIDE that intersection the template can never match and the
 * scene silently never fires -- which is what an earlier revision of this
 * fixture did (markers at (100,100) and (204,204) against a crop rect of
 * (90,90,140,140)). The separability checks at the end of section [B] exist to
 * catch exactly that class of mistake: a high match score has to happen at the
 * intended place and nowhere else.
 */
static const char *SYNTH_JSON =
"{"
"  \"version\": 4308,"
"  \"script_version\": 7,"
"  \"name\": \"synthetic\","
"  \"screen_info\": { \"width\": 320, \"height\": 480, \"density\": 160,"
"                    \"pixelStride\": 4, \"rowPadding\": 0 },"
"  \"capture_direction\": -1,"
"  \"adapter\": 0,"
"  \"expand_size\": 0,"
"  \"loop_interval\": 30,"
"  \"task_mode\": 0,"
"  \"concurrency\": true,"
"  \"image_list\": ["
"    { \"name\": \"gA\", \"id\": \"grpA\", \"sim\": \"0.8\", \"images\": ["
"      { \"file\": \"a.png\", \"rect\": \"120,120,8,8\", \"sim\": \"0.8\","
"        \"screen_info\": { \"width\": 320, \"height\": 480, \"density\": 160,"
"                          \"pixelStride\": 4, \"rowPadding\": 0 } } ] },"
"    { \"name\": \"gB\", \"id\": \"grpB\", \"sim\": \"0.8\", \"images\": ["
"      { \"file\": \"b.png\", \"rect\": \"160,160,8,8\", \"sim\": \"0.8\","
"        \"screen_info\": { \"width\": 320, \"height\": 480, \"density\": 160,"
"                          \"pixelStride\": 4, \"rowPadding\": 0 } } ] }"
"  ],"
"  \"var_list\": ["
"    { \"id\": \"varBoth\", \"name\": \"both\", \"crops\": ["
"      { \"ori\": \"a.png\", \"rect\": \"110,110,90,90\", \"orientation\": 2,"
"        \"screen_info\": { \"width\": 320, \"height\": 480, \"density\": 160,"
"                          \"pixelStride\": 4, \"rowPadding\": 0 } } ] }"
"  ],"
"  \"scene_list\": [],"
"  \"common_event\": [],"
"  \"common_event_low\": [],"
"  \"default_scene\": ["
/* scene 0 ("gs") comes FIRST and is GATED, so dispatch order is observable:
 * scene 1 ("taponly") has no gate and therefore is never active in Android's
 * loop (framework/b.java leaves f1004f false when there is no gate), so the
 * gated scene 0 has to win even though it is not the first ACTIVE one by luck
 * -- and when scene 0's gate fails, the scan reaches scene 1. */
"    { \"name\": \"gs\", \"id\": \"sc0\", \"is_new\": true, \"is_deleted\": false,"
"      \"modified\": 0, \"conflict\": false,"
/* The gate's FIRST leaf is A, which the fold must DISCARD: i.m.b() replaces the
 * accumulator with the first leaf instead of ANDing it onto true, so the gate
 * follows B alone. If it followed "A AND B" instead, the only-B frame below
 * would not hold the gate and the test would see scene 1 win. */
"      \"scene_event\": { \"type\": 5, \"relation\": 1, \"item_list\": ["
"        { \"type\": 1, \"relation\": 1, \"state\": 1, \"image_id\": \"grpA\","
"          \"search_id\": \"varBoth\", \"timeout\": 0, \"reset_timeout\": false },"
"        { \"type\": 1, \"relation\": 1, \"state\": 1, \"image_id\": \"grpB\","
"          \"search_id\": \"varBoth\", \"timeout\": 0, \"reset_timeout\": false } ] },"
"      \"item_group\": { \"type\": 5, \"relation\": 1, \"item_list\": [] },"
"      \"action_list\": ["
"        { \"type\": 2, \"image_id\": \"grpB\", \"search_id\": \"varBoth\","
"          \"postpone\": 0, \"press_time\": 0, \"click_times\": 1, \"interval\": 0 } ] },"
/* scene 1: a plain Tap-coordinate action on the search variable's crop rect, so
 * a fall-through is distinguishable from scene 0's image action by type alone. */
"    { \"name\": \"taponly\", \"id\": \"sc1\", \"is_new\": true, \"is_deleted\": false,"
"      \"modified\": 0, \"conflict\": false,"
"      \"scene_event\": null,"
"      \"item_group\": { \"type\": 5, \"relation\": 1, \"item_list\": [] },"
"      \"action_list\": ["
"        { \"type\": 1, \"image_id\": \"varBoth\", \"postpone\": 0 } ] }"
"  ]"
"}";

/*
 * Marker A inside an 8x8 tile: a dark 3x3 square in the tile's top-left 3x3
 * corner, with a bright fourth column.
 *
 *   # # # . . . . .
 *   # # # . . . . .
 *   # # # . . . . .
 *   . . . . . . . .
 *   ...
 *
 * Marker B: a transposed shape (dark in the first row and first column, bright
 * in its bottom-right corner), so neither is a translate of the other.
 *
 *   # # # . . . . .
 *   # . . . . . . .
 *   # . . . . . . .
 *   . . . . . . . .
 *   ...
 *
 * Both are placed at the tile origin, so the fixture's pixel grid and the
 * pattern's own grid line up -- a marker that is painted at (2,1) while its
 * pattern has its edge at column 3 lands three pixels away from where the
 * pattern says it should, and the frame and the template then disagree by that
 * offset (a bug this fixture already had once).
 *
 * Both are also GROUNDED: every row they touch has a dark pixel in it and every
 * column they touch has a dark pixel in it, and neither has a whole dark row or
 * column adjacent to a whole bright one. That is what stops a translated window
 * from scoring 1.0 -- if a 4x4 solid square were used, shifting it inside its
 * own extent would leave the overlap identical and the match would be ambiguous.
 * The separability check at the end of section [B] enforces this empirically
 * rather than by argument.
 */
#define MARK_BG  210
#define MARK_FG   20

static const int MARK_A[4][4] = {
    { 1, 1, 1, 0 },
    { 1, 1, 0, 0 },
    { 1, 0, 0, 0 },
    { 0, 0, 0, 0 }
};

static const int MARK_B[4][4] = {
    { 1, 1, 1, 0 },
    { 1, 0, 1, 0 },
    { 0, 0, 1, 0 },
    { 0, 0, 0, 0 }
};

static unsigned char *make_gray(int w, int h, const int mark[4][4], int bx, int by)
{
    unsigned char *g = (unsigned char *)malloc((size_t)w * (size_t)h);
    if (!g) return NULL;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int v = MARK_BG;
            const int mx = x - bx, my = y - by;
            if (mx >= 0 && mx < 4 && my >= 0 && my < 4) v = mark[my][mx] ? MARK_FG : MARK_BG;
            g[(size_t)y * (size_t)w + (size_t)x] = (unsigned char)v;
        }
    }
    return g;
}

/*
 * Write a PNG whose IDAT is a single stored (uncompressed) deflate block, so the
 * test needs neither zlib nor a fixture file. am_container drives the inflate
 * itself, so a stored block is perfectly valid input.
 *
 * The pixels are written as 8-bit TRUECOLOR (PNG colour type 2) rather than
 * grayscale: am_png_decode_gray rejects colour type 0 with AM_ERR_UNSUPPORTED
 * ("PNG bit depth / colour type not supported"), and the .auto files the app
 * writes are truecolor anyway, so truecolor is the format the loader must cope
 * with. Each input byte becomes an R=G=B triple.
 */
static int write_gray_png(const char *path, const unsigned char *px, int w, int h)
{
    FILE *f = fopen(path, "wb");
    if (!f) return -1;

    const unsigned char sig[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    if (fwrite(sig, 1, 8, f) != 8) { fclose(f); return -1; }

    unsigned char ihdr[13];
    ihdr[0] = (unsigned char)(w >> 24); ihdr[1] = (unsigned char)(w >> 16);
    ihdr[2] = (unsigned char)(w >> 8);  ihdr[3] = (unsigned char)w;
    ihdr[4] = (unsigned char)(h >> 24); ihdr[5] = (unsigned char)(h >> 16);
    ihdr[6] = (unsigned char)(h >> 8);  ihdr[7] = (unsigned char)h;
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    unsigned char len4[4];
    const unsigned char zero_crc[4] = { 0, 0, 0, 0 };

    /* IHDR */
    len4[0] = 0; len4[1] = 0; len4[2] = 0; len4[3] = 13;
    if (fwrite(len4, 1, 4, f) != 4 || fwrite("IHDR", 1, 4, f) != 4 ||
        fwrite(ihdr, 1, 13, f) != 13 || fwrite(zero_crc, 1, 4, f) != 4) {
        fclose(f); return -1;
    }

    /*
     * IDAT: a zlib stream (am_inflate_zlib checks the header, and rejects
     * FDICT) wrapping one stored deflate block over the filtered scanlines.
     */
    const size_t row_len = (size_t)w * 3u;
    const size_t raw_len = (size_t)h * (row_len + 1u);
    unsigned char *raw = (unsigned char *)malloc(raw_len);
    if (!raw) { fclose(f); return -1; }
    for (int y = 0; y < h; y++) {
        unsigned char *dst = raw + (size_t)y * (row_len + 1u);
        dst[0] = 0;                                /* filter: none */
        for (int x = 0; x < w; x++) {
            const unsigned char v = px[(size_t)y * (size_t)w + (size_t)x];
            dst[1 + (size_t)x * 3u + 0u] = v;
            dst[1 + (size_t)x * 3u + 1u] = v;
            dst[1 + (size_t)x * 3u + 2u] = v;
        }
    }

    /* Adler-32 of the raw stream -- the zlib trailer, computed before the raw
     * buffer is released so the two cannot drift apart. */
    unsigned int a1 = 1, a2 = 0;
    for (size_t i = 0; i < raw_len; i++) {
        a1 = (a1 + raw[i]) % 65521u;
        a2 = (a2 + a1) % 65521u;
    }
    const unsigned int adler = (a2 << 16) | a1;

    size_t zn = 0;
    /*
     * 2 zlib header bytes + 5 per stored block + 4 Adler-32 bytes. The +4 is
     * load-bearing: sizing the tail as 0 (or relying on "+6" to cover it) writes
     * the Adler-32 past the end of the heap block, and the file then holds a
     * TRUNCATED zlib stream. am_inflate_zlib never verifies the Adler-32, so it
     * decoded happily and only the pixels were wrong -- python's zlib is what
     * caught it ("Error -5 ... incomplete or truncated stream").
     */
    unsigned char *z = (unsigned char *)malloc(raw_len + 2 + (raw_len / 65535 + 1) * 5 + 4);
    if (!z) { free(raw); fclose(f); return -1; }
    z[zn++] = 0x78; z[zn++] = 0x01;                /* zlib header: CMF/FLG, no dict */
    /*
     * Stored blocks need the three header bits written LSB-first: BFINAL in bit
     * 0, BTYPE=00 in bits 1-2. Because three bits cannot fill a byte, the byte
     * is exactly BFINAL and, crucially, the following LEN/NLEN must not be
     * re-aligned: a stored block's payload starts on the NEXT BYTE BOUNDARY, so
     * after "1 + 2 bits" the encoder owes nothing and LEN begins immediately.
     * Padding here (or byte-swapping LEN/NLEN) makes zlib report "invalid stored
     * block lengths" -- python's zlib rejects the padded form too, so the shape
     * below is checkable outside MSVC.
     */
    size_t off = 0;
    while (off < raw_len) {
        size_t n = raw_len - off;
        if (n > 65535) n = 65535;
        z[zn++] = (unsigned char)((off + n >= raw_len) ? 1 : 0);   /* BFINAL, BTYPE=00 */
        z[zn++] = (unsigned char)(n & 0xFF);                       /* LEN, little endian */
        z[zn++] = (unsigned char)((n >> 8) & 0xFF);
        z[zn++] = (unsigned char)((~n) & 0xFF);                    /* NLEN = ~LEN */
        z[zn++] = (unsigned char)(((~n) >> 8) & 0xFF);
        memcpy(z + zn, raw + off, n);
        zn += n;
        off += n;
    }
    free(raw);

    z[zn++] = (unsigned char)((adler >> 24) & 0xFF);
    z[zn++] = (unsigned char)((adler >> 16) & 0xFF);
    z[zn++] = (unsigned char)((adler >> 8) & 0xFF);
    z[zn++] = (unsigned char)(adler & 0xFF);

    const unsigned int zn32 = (unsigned int)zn;
    len4[0] = (unsigned char)(zn32 >> 24); len4[1] = (unsigned char)(zn32 >> 16);
    len4[2] = (unsigned char)(zn32 >> 8);  len4[3] = (unsigned char)zn32;
    int rc = 0;
    if (fwrite(len4, 1, 4, f) != 4 || fwrite("IDAT", 1, 4, f) != 4 ||
        fwrite(z, 1, zn, f) != zn || fwrite(zero_crc, 1, 4, f) != 4) {
        rc = -1;
    }
    free(z);
    if (rc != 0) { fclose(f); return -1; }

    /* IEND */
    if (fwrite(zero_crc, 1, 4, f) != 4 || fwrite("IEND", 1, 4, f) != 4 ||
        fwrite(zero_crc, 1, 4, f) != 4) {
        fclose(f); return -1;
    }

    fclose(f);
    return 0;
}

static void test_fold_and_dispatch(const char *dir)
{
    printf("[B] synthetic: condition fold and scene dispatch\n");

    /*
     * The synthetic templates have to be addressable as "<dir>/a.png" and
     * "<dir>/b.png" by the script's io callback, and the real fixture directory
     * is read-only, so the json callback rewrites those two names to files
     * written in the working directory.
     */
    static dir_ctx c;
    snprintf(c.dir, sizeof(c.dir), "%s", dir);
    c.inline_name[0] = "a.png";
    c.inline_name[1] = "b.png";
    snprintf(c.inline_path[0], sizeof(c.inline_path[0]), "_test_engine_a.png");
    snprintf(c.inline_path[1], sizeof(c.inline_path[1]), "_test_engine_b.png");

    /*
     * Both markers are grounded patterns rather than solid squares: see the
     * MARK_A / MARK_B comment above. A solid square would score 1.0 at every
     * shift that keeps the overlap inside the square, and then the "only A
     * matches" fixture would silently match B as well.
     */
    unsigned char *pa = make_gray(8, 8, MARK_A, 0, 0);
    unsigned char *pb = make_gray(8, 8, MARK_B, 0, 0);
    check(pa && pb, "synthetic templates allocated", NULL);
    if (!pa || !pb) { free(pa); free(pb); return; }

    check(write_gray_png(c.inline_path[0], pa, 8, 8) == 0, "wrote the A template", c.inline_path[0]);
    check(write_gray_png(c.inline_path[1], pb, 8, 8) == 0, "wrote the B template", c.inline_path[1]);
    {   /* self-check the generator: the engine reads these through dir_read */
        void *raw = NULL; size_t raw_n = 0;
        const int rr = dir_read(&c, "image/a.png", &raw, &raw_n);
        int pw = 0, ph = 0;
        const int ps = (rr == 0) ? am_png_size(raw, raw_n, &pw, &ph) : -99;
        char m2[256];
        snprintf(m2, sizeof(m2), "dir_read=%d bytes=%llu png_size=%d wh=%dx%d",
                 rr, (unsigned long long)raw_n, ps, pw, ph);
        check(rr == 0 && ps == 0 && pw == 8 && ph == 8, "generated template reads back", m2);
        if (rr == 0) {
            /* The IDAT must survive am_inflate_zlib: a stored deflate block
             * still needs the zlib header, and the header must lead with the
             * three block bits (no padding, LEN started immediately) or zlib
             * reports "invalid stored block lengths". The Adler-32 tail is
             * written as zeros because am_inflate_zlib does not verify it. */
            unsigned char gbuf[64];
            int gw = 0, gh = 0;
            const int dr = am_png_decode_gray(raw, raw_n, gbuf, sizeof(gbuf), &gw, &gh);
            char m4[256];
            snprintf(m4, sizeof(m4), "decode=%d wh=%dx%d px0=%d px11=%d bytes=%llu",
                     dr, gw, gh, gbuf[0], gbuf[11], (unsigned long long)raw_n);
            /* A = MARK_A at (0,0): (0,0) is dark, (3,1) is bright. */
            check(dr == 0 && gw == 8 && gh == 8 && gbuf[0] == MARK_FG && gbuf[11] == MARK_BG,
                  "generated template decodes", m4);
        }
        free(raw);
    }
    {   /* B is checked the same way: MARK_B's (1,1) is bright, (2,1) is dark. */
        void *raw = NULL; size_t raw_n = 0;
        unsigned char gbuf[64];
        int gw = 0, gh = 0;
        const int rr = dir_read(&c, "image/b.png", &raw, &raw_n);
        const int dr = (rr == 0) ? am_png_decode_gray(raw, raw_n, gbuf, sizeof(gbuf), &gw, &gh) : -99;
        char m5[256];
        snprintf(m5, sizeof(m5), "decode=%d wh=%dx%d px0=%d px9=%d px10=%d bytes=%llu",
                 dr, gw, gh, gbuf[0], gbuf[9], gbuf[10], (unsigned long long)raw_n);
        check(dr == 0 && gw == 8 && gh == 8 && gbuf[0] == MARK_FG &&
              gbuf[9] == MARK_BG && gbuf[10] == MARK_FG,
              "B template decodes to its own pattern", m5);
        free(raw);
    }

    free(pa);
    free(pb);

    am_script_io io;
    io.ctx = &c;
    io.read = dir_read;
    io.release = NULL;

    am_script *s = (am_script *)calloc(1, sizeof(am_script));
    if (!s) return;
    am_script_init(s, &io);

    am_screen screen;
    am_screen_make(&screen, 320, 480, 160);
    const size_t jlen = strlen(SYNTH_JSON);
    const int lrc = am_script_load_json(s, SYNTH_JSON, jlen, &screen);
    char msg[512];
    snprintf(msg, sizeof(msg), "synthetic script loads (%s), %d scenes, %d groups",
             s->error, s->scene_count, s->template_group_count);
    check(lrc == 0 && s->scene_count == 2 && s->template_group_count == 2,
          "synthetic script model", msg);
    {
        /* The rendered template is the precondition for everything below: a
         * NULL here means the variant chooser or the PNG loader failed, and the
         * gate can then never hold. */
        const am_mat *tp = am_script_template(s, &s->groups[0]);
        char m3[256];
        snprintf(m3, sizeof(m3), "group=%s variant=%d rendered %dx%d",
                 s->groups[0].name, s->cache ? s->cache[0].variant : -99,
                 tp ? tp->width : -1, tp ? tp->height : -1);
        check(tp && tp->pixels && tp->width == 8 && tp->height == 8,
              "group 0 template renders", m3);
    }
    if (lrc != 0) {
        am_script_free(s);
        free(s);
        return;
    }

    am_template_group *ga = am_script_find_group(s, "grpA");
    am_template_group *gb = am_script_find_group(s, "grpB");
    snprintf(msg, sizeof(msg), "groups: A=%p B=%p", (void *)ga, (void *)gb);
    check(ga && gb, "both groups resolve by id", msg);

    /* The scene must have a gate with two leaves. */
    snprintf(msg, sizeof(msg), "scene 0 gate leaves = %d, events = %d",
             s->scenes[0].gate ? s->scenes[0].gate->item_count : -1,
             s->scenes[0].event_count);
    check(s->scenes[0].gate && s->scenes[0].gate->item_count == 2 &&
          s->scenes[0].event_count == 1,
          "scene 0 has a two-leaf gate and one event", msg);

    /*
     * Frame 1: only B matches. Under the correct fold the gate is "B", so the
     * scene IS active and its image action fires. Under a naive
     * "start from true and AND everything" fold the gate would be false and
     * nothing would happen.
     */
    /*
     * Three frames, one per satisfied-leaf set. The gate is relation 1 (AND)
     * over [grpA, grpB], so Android's fold at i/m.java:56-61 -- the first leaf
     * REPLACES the running result, later leaves combine with it -- makes the
     * gate hold only when EVERY leaf holds: leaf 0 becomes the accumulator and
     * leaf 1 is ANDed into it.
     *
     * A and B together are therefore required, and the interesting pair is:
     *   frame B alone (A missing) -> gate false -> fall through to scene 1
     *   frame A alone (B missing) -> gate false -> fall through to scene 1
     *   both markers              -> gate true  -> scene 0, not the un-gated 1
     * The first two are both false, which is also what a naive "true AND every
     * leaf" fold gives; the asymmetry a wrong fold produces is only visible in
     * the last one, where a first-leaf-wins fold would still say true.
     */
    struct {
        const char *tag;
        const int (*mark)[4];   /* marker #1, or NULL */
        int mx, my;
        const int (*mark2)[4];  /* marker #2, or NULL */
        int m2x, m2y;
        int gate;               /* expected am_engine_scene_active(&e, 0) */
        int tap_scene;          /* which scene's action must fire */
        int tap_min, tap_max;   /* the tap rect it must land in */
    } cases[3] = {
        { "A only", MARK_A, 120, 120, NULL,     0,   0, 0, 1, 110, 200 },
        { "B only", NULL,     0,   0, MARK_B, 160, 160, 0, 1, 110, 200 },
        { "both",   MARK_A, 120, 120, MARK_B, 160, 160, 1, 0, 160, 168 }
    };

    for (int ci = 0; ci < 3; ci++) {
        fake_host fh;
        memset(&fh, 0, sizeof(fh));
        fh.w = 320; fh.h = 480;
        fh.gray = make_gray(320, 480, cases[ci].mark ? cases[ci].mark : cases[ci].mark2,
                            cases[ci].mark ? cases[ci].mx : cases[ci].m2x,
                            cases[ci].mark ? cases[ci].my : cases[ci].m2y);
        if (fh.gray && cases[ci].mark && cases[ci].mark2) {
            unsigned char *bm = make_gray(320, 480, cases[ci].mark2, cases[ci].m2x, cases[ci].m2y);
            if (bm) {
                for (size_t i = 0; i < (size_t)320 * 480; i++)
                    if (bm[i] != MARK_BG) fh.gray[i] = bm[i];
                free(bm);
            }
        }
        snprintf(msg, sizeof(msg), "frame for case '%s' allocated", cases[ci].tag);
        check(fh.gray != NULL, msg, NULL);
        if (!fh.gray) continue;

        am_engine_host host;
        fh_make_host(&fh, &host);
        am_engine e;
        memset(&e, 0, sizeof(e));
        check(am_engine_init(&e, s, &host, 320, 480) == 0, "engine inits", NULL);

        /* Conditions read the frame, so the frame has to exist before they can
         * be evaluated. This is also what a UI preview would do. */
        check(am_engine_capture(&e) == 1, "frame captured before evaluating", NULL);

        const int active = am_engine_scene_active(&e, 0);
        snprintf(msg, sizeof(msg), "%s: gate evaluates to %d, want %d",
                 cases[ci].tag, active, cases[ci].gate);
        check(active == cases[ci].gate, "gate is the AND of both leaves", msg);

        const int rc = am_engine_step(&e);
        int n = 0;
        const am_tap_record *taps = am_engine_taps(&e, &n);
        snprintf(msg, sizeof(msg), "%s: step = %d, taps = %d, scene = %d, want scene %d",
                 cases[ci].tag, rc, n, n ? taps[0].scene : -1, cases[ci].tap_scene);
        check(rc == 1 && n == 1 && taps[0].scene == cases[ci].tap_scene,
              "the first scene whose gate holds runs", msg);
        if (n == 1) {
            snprintf(msg, sizeof(msg), "%s: tap (%d,%d) type %d, want type %d in [%d,%d)^2",
                     cases[ci].tag, taps[0].x, taps[0].y, taps[0].type,
                     cases[ci].tap_scene == 0 ? AM_ACT_IMAGE : AM_ACT_TAP,
                     cases[ci].tap_min, cases[ci].tap_max);
            check(taps[0].type == (cases[ci].tap_scene == 0 ? AM_ACT_IMAGE : AM_ACT_TAP) &&
                  taps[0].x >= cases[ci].tap_min && taps[0].x < cases[ci].tap_max &&
                  taps[0].y >= cases[ci].tap_min && taps[0].y < cases[ci].tap_max,
                  "the action taps inside the rect that produced it", msg);
        }

        am_engine_free(&e);
        free(fh.gray);
    }

    /*
     * Frame 2: only A matches. The gate is "B", which does not hold, so scene 0
     * is inactive and scene 1 (no gate, Tap action on the search variable's crop
     * rect) takes over.
     */
    {
        fake_host fh;
        memset(&fh, 0, sizeof(fh));
        fh.w = 320; fh.h = 480;
        fh.gray = make_gray(320, 480, MARK_A, 120, 120);   /* A's marker only */

        am_engine_host host;
        fh_make_host(&fh, &host);
        am_engine e;
        memset(&e, 0, sizeof(e));
        am_engine_init(&e, s, &host, 320, 480);
        am_engine_capture(&e);

        const int active = am_engine_scene_active(&e, 0);
        snprintf(msg, sizeof(msg), "gate with only A present evaluates to %d", active);
        check(active == 0, "gate follows the second leaf, not the first", msg);

        const int rc = am_engine_step(&e);
        int n = 0;
        const am_tap_record *taps = am_engine_taps(&e, &n);
        snprintf(msg, sizeof(msg), "step = %d, taps = %d, scene = %d",
                 rc, n, e.current_scene);
        check(rc == 1 && n == 1 && taps[0].scene == 1,
              "dispatch falls through to the un-gated scene 1", msg);
        if (n == 1) {
            snprintf(msg, sizeof(msg), "tap (%d,%d) type %d (want in 110,110,90,90; type 1)",
                     taps[0].x, taps[0].y, taps[0].type);
            check(taps[0].type == AM_ACT_TAP &&
                  taps[0].x >= 110 && taps[0].x < 200 &&
                  taps[0].y >= 110 && taps[0].y < 200,
                  "Tap action uses the search variable's crop rect", msg);
        }

        am_engine_free(&e);
        free(fh.gray);
    }

    /*
     * Frame 3: both markers present. Scene 1 comes FIRST in the table and has no
     * gate, so a "first scene in the table wins" dispatch would pick scene 1 and
     * never reach the gated scene 0. The gated scene has to win instead, which is
     * what Android's loop does: an un-gated scene is never active (its f1004f
     * stays false), so the scan walks past it.
     */
    {
        fake_host fh;
        memset(&fh, 0, sizeof(fh));
        fh.w = 320; fh.h = 480;
        fh.gray = make_gray(320, 480, MARK_A, 120, 120);   /* A ... */
        {
            unsigned char *bm = make_gray(320, 480, MARK_B, 160, 160);
            if (fh.gray && bm) {
                for (size_t i = 0; i < (size_t)320 * 480; i++)
                    if (bm[i] != MARK_BG) fh.gray[i] = bm[i];
            }
            free(bm);
        }

        am_engine_host host;
        fh_make_host(&fh, &host);
        am_engine e;
        memset(&e, 0, sizeof(e));
        am_engine_init(&e, s, &host, 320, 480);

        for (int i = 0; i < 5; i++) am_engine_step(&e);

        int n = 0;
        const am_tap_record *taps = am_engine_taps(&e, &n);
        int scenes_seen[8] = { 0 };
        for (int i = 0; i < n && i < AM_MAX_TAPS; i++) {
            if (taps[i].scene >= 0 && taps[i].scene < 8) scenes_seen[taps[i].scene] = 1;
        }
        snprintf(msg, sizeof(msg), "%d taps over 5 rounds; scene 0 seen = %d, scene 1 seen = %d",
                 n, scenes_seen[0], scenes_seen[1]);
        check(n > 0 && scenes_seen[0] && !scenes_seen[1],
              "the gated scene wins over the earlier un-gated one", msg);

        am_engine_free(&e);
        free(fh.gray);
    }

    /*
     * Separability self-check. Everything above assumes that "a frame holding
     * only marker X" really does match template X and really does NOT match the
     * other template. That assumption is a property of the fixture's geometry,
     * not of the engine, and an earlier revision of this fixture violated it
     * silently (a marker sat outside the intersection that search rects are
     * built from, so a template could never match at all).
     *
     * Instead of trusting the geometry, measure it: match each template against
     * each frame and require the score at the intended place to be ~1.0 while
     * the best score anywhere else stays under the group's sim (0.8).
     */
    {
        struct { const char *tag; const int (*mark)[4]; int mx, my; am_template_group *g; } probe[2] = {
            { "A", MARK_A, 120, 120, ga },
            { "B", MARK_B, 160, 160, gb }
        };
        am_var *sv = am_script_find_var(s, "varBoth");

        for (int f = 0; f < 2; f++) {
            unsigned char *fr = make_gray(320, 480, probe[f].mark, probe[f].mx, probe[f].my);
            if (!fr) { check(0, "separability frame allocated", NULL); break; }
            fake_host fh;
            memset(&fh, 0, sizeof(fh));
            fh.w = 320; fh.h = 480; fh.gray = fr;
            am_engine_host host;
            fh_make_host(&fh, &host);
            am_engine e;
            memset(&e, 0, sizeof(e));
            am_engine_init(&e, s, &host, 320, 480);
            am_engine_capture(&e);

            for (int t = 0; t < 2; t++) {
                am_rect sr;
                am_engine_search_rect(&e, probe[t].g, sv, &sr);
                am_match_result mr;
                am_engine_match(&e, probe[t].g, sr, &mr);
                const int wanted = (t == f);
                snprintf(msg, sizeof(msg),
                         "frame %s vs template %s: search (%d,%d,%d,%d) found=%d peak=%.4f at (%d,%d), want match=%d",
                         probe[f].tag, probe[t].tag, sr.x, sr.y, sr.w, sr.h,
                         mr.found, mr.peak, mr.x, mr.y, wanted);
                if (wanted) {
                    check(mr.found && mr.peak > 0.99 &&
                          mr.x == probe[t].mx && mr.y == probe[t].my,
                          "template matches its own marker at the recorded place", msg);
                } else {
                    /* `wanted` is false when frame f holds marker t's counterpart.
                     * For an INSIDE template the score must be exactly 1.0, and for
                     * the wrong template it must stay below the group's sim. */
                    if (t == f) {
                        check(mr.peak > 0.99, "template matches its own marker exactly", msg);
                    } else {
                        check(mr.peak < probe[t].g->sim,
                              "template does not match the other marker", msg);
                    }
                }
            }

            am_engine_free(&e);
            free(fr);
        }
    }

    am_script_free(s);
    free(s);
    remove(c.inline_path[0]);
    remove(c.inline_path[1]);
}

/* ------------------------------------------------------------------ */

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    const char *dir = (argc > 1) ? argv[1] : "matcher_golden_pkg/pkg";
    printf("fixture: %s\n", dir);

    test_end_to_end(dir);
    test_fold_and_dispatch(dir);

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
