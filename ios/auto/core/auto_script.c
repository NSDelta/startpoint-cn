/*
 * auto_script.c -- model layer for .auto scripts: parse script.json, resolve
 * screen-dependent geometry, lazily render templates.
 *
 * See auto_script.h for the contract and .research/ios-design.md sections 1-2 for
 * the reverse-engineering evidence. Every rule implemented here was read out of
 * the decompiled Android reference (cn.autoeditor 4.3.8); the class/method that
 * each one mirrors is named in a comment at the definition.
 */

#include "auto_script.h"
#include "am_json.h"
#include "am_container.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

static void copy_str(char *dst, size_t cap, const char *src)
{
    if (!dst || cap == 0) return;
    if (!src) { dst[0] = '\0'; return; }
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* am_parse_rect lives in the public header; keep the parser tolerant of spaces
 * because the editor writes "x,y,w,h" but hand-edited scripts sometimes do not. */
int am_parse_rect(const char *text, am_rect *out)
{
    if (!text || !out) return -1;
    long v[4];
    int got = 0;
    const char *p = text;

    while (got < 4) {
        while (*p == ' ' || *p == '\t' || *p == ',') p++;
        if (*p == '\0') break;

        int neg = 0;
        if (*p == '-') { neg = 1; p++; }
        else if (*p == '+') { p++; }

        if (*p < '0' || *p > '9') return -1;
        long acc = 0;
        while (*p >= '0' && *p <= '9') {
            acc = acc * 10 + (*p - '0');
            if (acc > 100000000L) acc = 100000000L;   /* clamp, do not overflow */
            p++;
        }
        v[got++] = neg ? -acc : acc;
    }
    if (got != 4) return -1;

    out->x = (int)v[0];
    out->y = (int)v[1];
    out->w = (int)v[2];
    out->h = (int)v[3];
    return 0;
}

double am_parse_double(const char *text, double def)
{
    if (!text || !*text) return def;
    char *end = NULL;
    const double d = strtod(text, &end);
    if (end == text) return def;
    return d;
}

int am_parse_int(const char *text, int def)
{
    if (!text || !*text) return def;
    return (int)lround(am_parse_double(text, (double)def));
}

void am_screen_make(am_screen *out, int width, int height, int density)
{
    if (!out) return;
    out->width = width;
    out->height = height;
    out->density = density;
    out->long_edge = (width > height) ? width : height;
    out->short_edge = (width > height) ? height : width;
    if (out->long_edge <= 0) out->long_edge = 1;
    if (out->short_edge <= 0) out->short_edge = 1;
}

int am_screen_orientation(const am_screen_info *si)
{
    /* EditorImage.createImage: cVar2.f1060o = aVar.f866a > aVar.f867b ? 1 : 2
     * and editor.a keeps f866a = long edge, f867b = short edge, so a recorded
     * frame is "landscape" (1) when its width exceeds its height. */
    if (!si) return 2;
    return (si->width > si->height) ? 1 : 2;
}

/* ------------------------------------------------------------------ *
 * resolution adaptation
 * ------------------------------------------------------------------ */

/*
 * Recorded-frame pixels -> current-frame pixels.
 *
 * Android's EditorCrop.getAdapterValue decompiles to:
 *
 *     i8 = cur.f866a, i9 = cur.f867b
 *     min  = (i8 > i9) ? max(recW,recH) : min(recW,recH)
 *     min2 = (i9 > i8) ? max(recW,recH) : min(recW,recH)
 *     d8 = i8/min ; d9 = i9/min2      -> x,w *= d8 ; y,h *= d9
 *
 * and it is NOT a sane rule. EditorScript.updateScreenInfo() fills the CURRENT
 * info with f866a = max(w,h), f867b = min(w,h) -- long/short -- while a
 * recorded screen_info stores raw width/height. So on a portrait phone
 * (i9 > i8 false, i9 > i8 false) BOTH factors take the recorded SHORT edge:
 *
 *     d8 = cur_long / rec_short ; d9 = cur_short / rec_short
 *
 * On a 9:16 device replaying a 9:10 recording (1080x1920 from 1200x2000) that
 * is dx = 1.6, dy = 0.9 -- a 78% horizontal stretch, which would put every click
 * in the wrong place. Android never notices because it only ever runs on the
 * device a script was recorded on.
 *
 * We therefore use a SINGLE uniform factor, the same choice createImage makes
 * for the template's own pixels:
 *
 *     portrait  (current long edge == height): f = cur_short / rec_short
 *     landscape (current width  >  height)   : f = cur_long  / rec_long
 *
 * which is exact when the current frame equals the recording, and a plain
 * proportional scale otherwise (no axis is distorted). One factor also keeps
 * the search rectangle and the template rectangle consistently sized, which is
 * what makes "crop must contain the template" hold on foreign resolutions.
 *
 * Note this is also what the `if (f854f == 2) { d9 = d8; d8 = d9; }` line in
 * the decompilation is fumbling towards -- it is a genuine no-op there.
 *
 * Rounding: Android truncates through int arithmetic. We round to nearest and
 * force width/height >= 1 so a template can never collapse to zero area on a
 * smaller screen (which would make the search region empty and silently skip
 * the scene).
 */
void am_adapt_factors(const am_screen *cur, const am_screen_info *rec,
                      double *out_dx, double *out_dy)
{
    double f = 1.0;

    if (cur && rec) {
        const double rec_long  = (rec->width > rec->height) ? rec->width : rec->height;
        const double rec_short = (rec->width > rec->height) ? rec->height : rec->width;
        if (rec_long > 0 && rec_short > 0) {
            const int cur_landscape = (cur->width > cur->height) ? 1 : 0;
            f = (double)(cur_landscape ? cur->long_edge : cur->short_edge) /
                (cur_landscape ? rec_long : rec_short);
        }
    }

    if (out_dx) *out_dx = f;
    if (out_dy) *out_dy = f;
}

am_rect am_adapt_rect(const am_screen *cur, const am_screen_info *rec, am_rect r)
{
    am_rect out = r;
    if (!cur || !rec) return out;

    double dx = 1.0, dy = 1.0;
    am_adapt_factors(cur, rec, &dx, &dy);

    out.x = (int)lround((double)r.x * dx);
    out.y = (int)lround((double)r.y * dy);
    out.w = (int)lround((double)r.w * dx);
    out.h = (int)lround((double)r.h * dy);

    if (out.w < 1) out.w = 1;
    if (out.h < 1) out.h = 1;
    return out;
}

/*
 * EditorImage.getAdapterInfo(aVar, i8) -- decompiled:
 *
 *     if (i8 == 2) { float f10 = aspect(rec) - aspect(cur); if (|f10| < best) ... }
 *     else         { float abs = |rec.density - cur.density|; if (abs < best) ... }
 *
 * So the default metric is |density difference| ALONE -- there is no edge or
 * resolution term in Android at all. `Math.abs` (float) and a strict `<` mean
 * the first variant with a minimal difference wins ties.
 *
 * We keep density as the primary metric, but the caller (choose_variant) may
 * use the edge term below only to break an exact density tie; that never changes
 * an outcome Android would have decided uniquely.
 */
long am_variant_distance(const am_screen *cur, const am_screen_info *v)
{
    if (!cur || !v) return 0x7FFFFFFFL;

    long d_density = (long)cur->density - (long)v->density;
    if (d_density < 0) d_density = -d_density;

    return d_density;
}

/* Tie-break only: |dlong| + |dshort| against the recorded variant. */
static long edge_distance(const am_screen *cur, const am_screen_info *v)
{
    if (!cur || !v) return 0x7FFFFFFFL;

    const long vl = (v->width > v->height) ? v->width : v->height;
    const long vs = (v->width > v->height) ? v->height : v->width;

    long d_long = (long)cur->long_edge - vl;
    if (d_long < 0) d_long = -d_long;
    long d_short = (long)cur->short_edge - vs;
    if (d_short < 0) d_short = -d_short;

    return d_long + d_short;
}

/* aspect-ratio distance, used for the orientation-sensitive branch */
static long aspect_distance(const am_screen *cur, const am_screen_info *v)
{
    if (!cur || !v || v->width <= 0 || v->height <= 0) return 0x7FFFFFFFL;
    const double a_cur = (double)cur->long_edge / (double)cur->short_edge;
    const double a_var = (double)v->width / (double)v->height;
    const double d = fabs(a_cur - a_var) * 100000.0;
    return (long)d;
}

/* ------------------------------------------------------------------ *
 * string pools for JSON slices
 * ------------------------------------------------------------------ */

/* JSON strings are slices into the parse buffer, so they are not NUL
 * terminated. Copy through this helper everywhere. */
static void copy_json_str(char *dst, size_t cap, const am_json_value *obj, const char *key)
{
    const am_json_value *v = am_json_get(obj, key);
    if (!v || v->type != AM_JSON_STRING) { if (cap) dst[0] = '\0'; return; }

    size_t n = v->len;
    if (n >= cap) n = cap - 1;
    memcpy(dst, v->str, n);
    dst[n] = '\0';
}

static void copy_json_str_value(char *dst, size_t cap, const am_json_value *v)
{
    if (!v || v->type != AM_JSON_STRING) { if (cap) dst[0] = '\0'; return; }
    size_t n = v->len;
    if (n >= cap) n = cap - 1;
    memcpy(dst, v->str, n);
    dst[n] = '\0';
}

static int json_int(const am_json_value *obj, const char *key, int def, int *out)
{
    const am_json_value *v = am_json_get(obj, key);
    if (!v) { *out = def; return -1; }
    if (v->type == AM_JSON_NUMBER || v->type == AM_JSON_BOOL) { *out = (int)lround(v->num); return 0; }
    /* tolerate "150" stored as a string */
    if (v->type == AM_JSON_STRING) {
        char tmp[32];
        copy_json_str_value(tmp, sizeof(tmp), v);
        *out = am_parse_int(tmp, def);
        return 0;
    }
    *out = def;
    return -1;
}

/* Same tolerances as json_int, but for values that are genuinely fractional. */
static double json_double(const am_json_value *obj, const char *key, double def)
{
    const am_json_value *v = am_json_get(obj, key);
    if (!v) return def;
    if (v->type == AM_JSON_NUMBER || v->type == AM_JSON_BOOL) return v->num;
    if (v->type == AM_JSON_STRING) {
        char tmp[48];
        copy_json_str_value(tmp, sizeof(tmp), v);
        return am_parse_double(tmp, def);
    }
    return def;
}

static void parse_screen_info(const am_json_value *obj, am_screen_info *out, const char *key)
{
    memset(out, 0, sizeof(*out));
    const am_json_value *v = key ? am_json_get(obj, key) : obj;
    if (!v || v->type != AM_JSON_OBJECT) return;
    json_int(v, "width", 0, &out->width);
    json_int(v, "height", 0, &out->height);
    json_int(v, "density", 0, &out->density);
    json_int(v, "pixelStride", 4, &out->pixel_stride);
    json_int(v, "rowPadding", 0, &out->row_padding);
}

/* ------------------------------------------------------------------ *
 * conditions and actions
 * ------------------------------------------------------------------ */

/* relation: i/m.java -- `z8 = (relation == 1 || relation != 2) ? z8 & d : z8 | d`
 * i.e. relation == 2 means OR, everything else means AND. */
static void parse_cond(const am_json_value *src, am_cond *dst, int default_relation)
{
    memset(dst, 0, sizeof(*dst));
    dst->relation = default_relation;
    if (!src) return;

    json_int(src, "type", AM_COND_IMAGE, &dst->type);
    json_int(src, "relation", default_relation, &dst->relation);
    json_int(src, "state", 1, &dst->state);
    json_int(src, "item_state", -1, &dst->item_state);
    json_int(src, "timeout", 0, &dst->timeout);
    json_int(src, "reset_timeout", 0, &dst->reset_timeout);
    if (am_json_get(src, "reset_timeout") && am_json_get(src, "reset_timeout")->type == AM_JSON_BOOL)
        dst->reset_timeout = am_json_get(src, "reset_timeout")->num ? 1 : 0;

    copy_json_str(dst->image_id, sizeof(dst->image_id), src, "image_id");
    copy_json_str(dst->search_id, sizeof(dst->search_id), src, "search_id");
    copy_json_str(dst->deviation_id, sizeof(dst->deviation_id), src, "deviation_id");
    copy_json_str(dst->var_id, sizeof(dst->var_id), src, "variable_id");
    if (!dst->var_id[0]) copy_json_str(dst->var_id, sizeof(dst->var_id), src, "var_id");
    copy_json_str(dst->value, sizeof(dst->value), src, "value");
}

/*
 * AM_NEXT_* is derived from the action type, mirroring Android:
 *   - EditorEvent.breakable() returns true when ANY action implements the
 *     marker interface cn.autoeditor.editor.action.a. The runtime then breaks
 *     out of the event scan after executing it, which (given that f999a is
 *     reset to -1 right after) means "next tick restarts from the top of the
 *     scene".
 *   - EditorFinishAction (type 10) sets c.f1120d0, which stops the script.
 *
 * The marker set is exactly the 14 classes found by grepping `implements a`:
 *   App(16) ClickColor(21) ClickText(15) Delay(14) Finish(10) Gesture(22)
 *   Image(2) Input(6) Label(18) Node(24) Slide(7) SystemKey(11) Tap(1) Zoom(8)
 */
static int action_next_mode(int type)
{
    switch (type) {
        case AM_ACT_FINISH:
            return AM_NEXT_STOP;
        case AM_ACT_TAP:
        case AM_ACT_IMAGE:
        case AM_ACT_SLIDE:
        case AM_ACT_ZOOM:
        case AM_ACT_INPUT:
        case AM_ACT_DELAY:
        case AM_ACT_CLICK_TEXT:
        case AM_ACT_APP:
        case AM_ACT_LABEL:
        case AM_ACT_CLICK_COLOR:
        case AM_ACT_GESTURE:
        case AM_ACT_NODE:
        case AM_ACT_SYSTEM_KEY:
            return AM_NEXT_RESTART;
        default:
            return AM_NEXT_CONTINUE;
    }
}

static void parse_action(const am_json_value *src, am_action *dst)
{
    memset(dst, 0, sizeof(*dst));
    if (!src) return;

    json_int(src, "type", AM_ACT_UNKNOWN, &dst->type);
    dst->raw_type = dst->type;

    dst->postpone = json_double(src, "postpone", 0.0);
    dst->press_time = json_double(src, "press_time", 0.0);
    dst->interval = json_double(src, "interval", 0.0);
    json_int(src, "click_times", 1, &dst->click_times);
    json_int(src, "button", 1, &dst->button);

    copy_json_str(dst->image_id, sizeof(dst->image_id), src, "image_id");
    copy_json_str(dst->search_id, sizeof(dst->search_id), src, "search_id");
    copy_json_str(dst->deviation_id, sizeof(dst->deviation_id), src, "deviation_id");

    if (dst->click_times < 1) dst->click_times = 1;

    dst->next_mode = action_next_mode(dst->type);
}

/* ------------------------------------------------------------------ *
 * load
 * ------------------------------------------------------------------ */

static void parse_template_group(const am_script *s, const am_json_value *src, am_template_group *g)
{
    am_script *m = (am_script *)s;      /* only overflow counters are written */
    memset(g, 0, sizeof(*g));
    copy_json_str(g->name, sizeof(g->name), src, "name");
    copy_json_str(g->id, sizeof(g->id), src, "id");

    /* sim lives on the GROUP, not on each variant: `"sim":"0.8"` (a string) */
    g->sim = json_double(src, "sim", 0.8);
    if (g->sim <= 0.0 || g->sim > 1.0) g->sim = 0.8;

    {
        const am_json_value *at = am_json_get(src, "adapter_type");
        if (at && (at->type == AM_JSON_NUMBER || at->type == AM_JSON_STRING)) {
            char tmp[32];
            copy_json_str_value(tmp, sizeof(tmp), at);
            g->adapter_type = am_parse_int(tmp, -1);
        } else {
            g->adapter_type = -1;      /* absent => fall back to script-level adapter */
        }
    }

    const am_json_value *imgs = am_json_get(src, "images");
    const size_t n = am_json_count(imgs);
    for (size_t i = 0; i < n; i++) {
        const am_json_value *v = am_json_at(imgs, i);
        if (!v) continue;
        if (g->variant_count >= AM_MAX_VARIANTS) { m->overflow_variants++; continue; }

        am_template_variant *tv = &g->variants[g->variant_count];
        memset(tv, 0, sizeof(*tv));

        copy_json_str(tv->file, sizeof(tv->file), v, "file");
        copy_json_str(tv->ori, sizeof(tv->ori), v, "ori");

        char rect[64];
        copy_json_str(rect, sizeof(rect), v, "rect");
        if (am_parse_rect(rect, &tv->rect) != 0) continue;   /* unusable variant */

        json_int(v, "type", 1, &tv->type);
        tv->threshold = json_double(v, "threshold", 0.0);
        json_int(v, "filter_color", 0, &tv->filter_color);
        tv->filter_sim = json_double(v, "filter_sim", 0.0);
        parse_screen_info(v, &tv->screen, "screen_info");

        g->variant_count++;
    }
}

static void parse_var(am_script *s, const am_json_value *src, am_var *v)
{
    memset(v, 0, sizeof(*v));
    copy_json_str(v->id, sizeof(v->id), src, "id");
    copy_json_str(v->name, sizeof(v->name), src, "name");
    copy_json_str(v->value, sizeof(v->value), src, "value");
    json_int(src, "type", 0, &v->type);

    const am_json_value *crops = am_json_get(src, "crops");
    const size_t n = am_json_count(crops);
    for (size_t i = 0; i < n; i++) {
        const am_json_value *c = am_json_at(crops, i);
        if (!c) continue;
        if (v->crop_count >= AM_MAX_CROPS) { s->overflow_crops++; continue; }

        char rect[64];
        copy_json_str(rect, sizeof(rect), c, "rect");
        am_rect r;
        if (am_parse_rect(rect, &r) != 0) continue;

        v->crops[v->crop_count].rect = r;
        json_int(c, "orientation", 2, &v->crops[v->crop_count].orientation);
        copy_json_str(v->crops[v->crop_count].ori, sizeof(v->crops[0].ori), c, "ori");
        parse_screen_info(c, &v->crops[v->crop_count].screen, "screen_info");
        v->crop_count++;
    }
}

/*
 * One scene. `item_group` is a nested condition group of type 5 whose
 * `item_list` are the leaf items; Android flattens nested groups, and the
 * sample only ever has one level, so flattening one level here is exact for the
 * scripts we must run. Nested groups deeper than that are refused explicitly
 * rather than silently mis-evaluated.
 */
/*
 * Fill `ev`'s conditions from an object carrying an `item_group` node (a scene
 * body, an entry of `event_list`, or a `scene_event`). Shared by parse_scene and
 * the scene-gate reader so the two can never drift apart -- Android builds both
 * through the same i.m factory.
 */
static void parse_item_group(am_script *s, const am_json_value *src, am_event *ev)
{
    const am_json_value *ig = am_json_get(src, "item_group");
    if (!ig) ig = src;                  /* a bare condition group object */

    int group_relation = 1;
    json_int(ig, "relation", 1, &group_relation);
    ev->relation = group_relation;

    const am_json_value *items = am_json_get(ig, "item_list");
    const size_t n = am_json_count(items);
    for (size_t i = 0; i < n; i++) {
        const am_json_value *it = am_json_at(items, i);
        if (!it) continue;
        if (ev->item_count >= AM_MAX_ITEMS) { s->overflow_items++; continue; }

        int t = AM_COND_IMAGE;
        json_int(it, "type", AM_COND_IMAGE, &t);
        if (t == AM_COND_GROUP) s->unsupported_groups++;

        parse_cond(it, &ev->items[ev->item_count], 1);
        ev->item_count++;
    }
}

/*
 * One scene. `item_group` is a condition group of type 5 whose `item_list` are
 * the leaf items; the reference scripts use exactly one level of nesting, which
 * is what gets flattened into events[0].items. Deeper nesting is counted in
 * s->unsupported_groups rather than being mis-evaluated as a leaf.
 *
 * The event array is heap allocated with exactly `event_count` entries, so a
 * scene only pays for the events it declares.
 */
static int parse_scene(am_script *s, const am_json_value *src, am_scene *sc)
{
    memset(sc, 0, sizeof(*sc));
    copy_json_str(sc->name, sizeof(sc->name), src, "name");
    copy_json_str(sc->id, sizeof(sc->id), src, "id");

    {
        const am_json_value *d = am_json_get(src, "disabled");
        sc->disabled = (d && (d->type == AM_JSON_BOOL || d->type == AM_JSON_NUMBER)) ? (d->num ? 1 : 0) : 0;
    }

    /* Number of events this scene declares. The reference format keeps the
     * condition/action pair in the scene body itself, i.e. exactly one implicit
     * event; an explicit `event_list` (a newer editor) is honoured when present. */
    const am_json_value *ev_list = am_json_get(src, "event_list");
    size_t declared = am_json_count(ev_list);
    const int has_event_list = (declared > 0);
    if (declared == 0) declared = 1;
    if (declared > AM_MAX_EVENTS) { s->overflow_events += (int)(declared - AM_MAX_EVENTS); declared = AM_MAX_EVENTS; }

    sc->events = (am_event *)calloc(declared, sizeof(am_event));
    if (!sc->events) { s->error_fatal = 1; return -1; }
    sc->event_count = (int)declared;

    for (size_t e = 0; e < declared; e++) {
        const am_json_value *evsrc = has_event_list ? am_json_at(ev_list, e) : src;
        if (!evsrc) evsrc = src;

        am_event *ev = &sc->events[e];
        ev->id = (int)e;

        parse_item_group(s, evsrc, ev);

        const am_json_value *acts = am_json_get(evsrc, "action_list");
        const size_t an = am_json_count(acts);
        for (size_t i = 0; i < an; i++) {
            if (ev->action_count >= AM_MAX_ACTIONS) { s->overflow_actions++; continue; }
            parse_action(am_json_at(acts, i), &ev->actions[ev->action_count]);
            ev->action_count++;
        }

        /* EditorEvent.breakable(): set when ANY action of the event is one of
         * the marker-interface classes. See the am_event field comment. */
        for (int i = 0; i < ev->action_count; i++) {
            if (ev->actions[i].next_mode == AM_NEXT_RESTART) { ev->breakable = 1; break; }
        }
    }

    /* Scene gate (scene_event). Absent/null in every reference script, but a
     * newer editor may use it, and it is what decides whether the scene takes
     * part in the run at all. It is a condition group of exactly the same shape
     * as an event's item_group, so it parses through the same helper. */
    {
        const am_json_value *gate = am_json_get(src, "scene_event");
        if (gate && gate->type == AM_JSON_OBJECT) {
            am_event *g = (am_event *)calloc(1, sizeof(am_event));
            if (!g) { s->error_fatal = 1; return -1; }
            g->id = -1;
            parse_item_group(s, gate, g);
            if (g->item_count == 0) {
                /* An empty gate would mean "never active", which is almost
                 * certainly an editor artifact rather than intent; treat it as
                 * no gate at all. */
                free(g);
            } else {
                sc->gate = g;
            }
        }
    }

    return 0;
}

void am_script_init(am_script *s, const am_script_io *io)
{
    if (!s) return;
    memset(s, 0, sizeof(*s));
    if (io) s->io = *io;
    am_screen_make(&s->screen, 0, 0, 0);
    s->cache_gen = 1;
}

void am_script_free(am_script *s)
{
    if (!s) return;
    if (s->cache) {
        for (int i = 0; i < s->template_group_count; i++) {
            am_mat_free(&s->cache[i].mat);
        }
        free(s->cache);
        s->cache = NULL;
    }
    /* Scenes own their event arrays and their scene gate (see am_scene). */
    for (int i = 0; i < s->scene_count; i++) {
        free(s->scenes[i].events);
        s->scenes[i].events = NULL;
        free(s->scenes[i].gate);
        s->scenes[i].gate = NULL;
    }
    if (s->zip) {
        am_auto_close(s->zip);
        s->zip = NULL;
    }
    free(s->zip_ctx);
    s->zip_ctx = NULL;
    s->io.ctx = NULL;
    s->io.read = NULL;
    s->io.release = NULL;
}

void am_script_set_screen(am_script *s, const am_screen *screen)
{
    if (!s || !screen) return;
    s->screen = *screen;
    s->cache_gen++;                 /* invalidate every cached template render */
}

int am_script_load_json(am_script *s, const char *json, size_t len, const am_screen *screen)
{
    if (!s || !json) return -1;

    am_json doc;
    if (am_json_parse(&doc, json, len) != 0) {
        snprintf(s->error, sizeof(s->error), "script.json: %s", doc.error);
        am_json_free(&doc);
        return -1;
    }

    const am_json_value *root = doc.root;
    if (!root || root->type != AM_JSON_OBJECT) {
        snprintf(s->error, sizeof(s->error), "script.json: top level is not an object");
        am_json_free(&doc);
        return -1;
    }

    /* header */
    copy_json_str(s->header.name, sizeof(s->header.name), root, "name");
    copy_json_str(s->header.id, sizeof(s->header.id), root, "id");
    copy_json_str(s->header.init, sizeof(s->header.init), root, "init");
    json_int(root, "loop_mode", 1, &s->header.loop_mode);
    json_int(root, "expand_size", 0, &s->header.expand_size);
    json_int(root, "adapter", 1, &s->header.adapter);
    json_int(root, "task_mode", 0, &s->header.task_mode);
    json_int(root, "input_type", 1, &s->header.input_type);
    json_int(root, "capture_direction", -1, &s->header.capture_direction);
    {
        /* JSON stores loop_interval in MILLISECONDS. */
        const double ms = json_double(root, "loop_interval", 30.0);
        s->header.loop_interval = ms / 1000.0;
        if (s->header.loop_interval <= 0.0) s->header.loop_interval = 0.030;
    }

    /* templates */
    {
        const am_json_value *arr = am_json_get(root, "image_list");
        const size_t n = am_json_count(arr);
        for (size_t i = 0; i < n; i++) {
            const am_json_value *g = am_json_at(arr, i);
            if (!g) continue;
            if (s->template_group_count >= AM_MAX_TEMPLATE_GROUPS) { s->overflow_groups++; continue; }
            parse_template_group(s, g, &s->groups[s->template_group_count++]);
        }
    }

    /* variables */
    {
        const am_json_value *arr = am_json_get(root, "var_list");
        const size_t n = am_json_count(arr);
        for (size_t i = 0; i < n; i++) {
            const am_json_value *v = am_json_at(arr, i);
            if (!v) continue;
            if (s->var_count >= AM_MAX_VARS) { s->overflow_vars++; continue; }
            parse_var(s, v, &s->vars[s->var_count++]);
        }
    }

    /* scenes: scene_list first, default_scene appended last (EditorScript.createTask) */
    {
        const char *keys[2];
        keys[0] = "scene_list";
        keys[1] = "default_scene";
        for (int k = 0; k < 2; k++) {
            const am_json_value *arr = am_json_get(root, keys[k]);
            const size_t n = am_json_count(arr);
            for (size_t i = 0; i < n; i++) {
                const am_json_value *sc = am_json_at(arr, i);
                if (!sc) continue;
                if (s->scene_count >= AM_MAX_SCENES) { s->overflow_scenes++; continue; }
                if (parse_scene(s, sc, &s->scenes[s->scene_count]) != 0) {
                    snprintf(s->error, sizeof(s->error), "out of memory for scene events");
                    s->error_fatal = 1;
                    am_json_free(&doc);
                    return -1;
                }
                s->scene_count++;
            }
        }
    }

    if (s->scene_count == 0) {
        snprintf(s->error, sizeof(s->error), "script.json: no scenes");
        s->error_fatal = 1;
        am_json_free(&doc);
        return -1;
    }

    /* per-group cache slots */
    if (s->template_group_count > 0) {
        s->cache = (void *)calloc((size_t)s->template_group_count, sizeof(*s->cache));
        if (!s->cache) {
            snprintf(s->error, sizeof(s->error), "out of memory for template cache");
            s->error_fatal = 1;
            am_json_free(&doc);
            return -1;
        }
    }

    am_json_free(&doc);

    if (screen) am_script_set_screen(s, screen);

    if (am_script_overflowed(s)) {
        snprintf(s->error, sizeof(s->error),
                 "input truncated: groups=%d variants=%d vars=%d crops=%d scenes=%d "
                 "events=%d items=%d actions=%d -- raise the AM_MAX_* ceiling",
                 s->overflow_groups, s->overflow_variants, s->overflow_vars,
                 s->overflow_crops, s->overflow_scenes, s->overflow_events,
                 s->overflow_items, s->overflow_actions);
    } else if (s->unsupported_groups > 0) {
        /* Not fatal: the flattened level is evaluated; only depth > 1 is refused. */
        snprintf(s->error, sizeof(s->error),
                 "note: %d nested condition group(s) encountered", s->unsupported_groups);
    } else {
        s->error[0] = '\0';
    }
    return 0;
}

int am_script_overflowed(const am_script *s)
{
    if (!s) return 0;
    return (s->overflow_groups | s->overflow_variants | s->overflow_vars |
            s->overflow_crops  | s->overflow_scenes   | s->overflow_events |
            s->overflow_items  | s->overflow_actions) != 0;
}

/* ------------------------------------------------------------------ *
 * lookup
 * ------------------------------------------------------------------ */

am_template_group *am_script_find_group(am_script *s, const char *name_or_id)
{
    if (!s || !name_or_id) return NULL;
    for (int i = 0; i < s->template_group_count; i++) {
        if (strcmp(s->groups[i].name, name_or_id) == 0) return &s->groups[i];
        if (strcmp(s->groups[i].id, name_or_id) == 0) return &s->groups[i];
    }
    return NULL;
}

am_var *am_script_find_var(am_script *s, const char *id)
{
    if (!s || !id || !*id) return NULL;
    for (int i = 0; i < s->var_count; i++) {
        if (strcmp(s->vars[i].id, id) == 0) return &s->vars[i];
    }
    return NULL;
}

/* ------------------------------------------------------------------ *
 * variant selection (EditorImage.createImage + getAdapterInfo)
 * ------------------------------------------------------------------ */

/*
 * Returns the chosen variant index, or -1 when the group has no usable variant.
 *
 * Priority, exactly as Android does it (EditorImage.createImage):
 *   1. a variant whose screen_info EQUALS the current screen's five fields
 *      (getImageInfo) -- this is what makes a device whose resolution was
 *      recorded use the template pixel-for-pixel, with no resampling at all
 *   2. otherwise, if the effective adapter mode is non-zero, the variant with
 *      the smallest adapter distance (getAdapterInfo)
 *   3. otherwise nothing (adapter == 0 means "do not adapt", NOT "use variant 0")
 *
 * The effective adapter mode is the group's adapter_type when present, else the
 * script-level `adapter` (default 1). mode == 2 selects the aspect-ratio metric.
 *
 * Divergence from Android, deliberate: Android's metric is a bare density
 * comparison, and iOS has no densityDpi. We keep density primary and use the
 * resolution distance only to break an exact density tie, which keeps the
 * recorded-resolution variant winning on a device that matches one and gives a
 * sane answer on devices that match none.
 */
static int choose_variant(am_script *s, const am_template_group *g)
{
    if (g->variant_count <= 0) return -1;

    const int mode = (g->adapter_type >= 0) ? g->adapter_type : s->header.adapter;

    /* exact match first */
    for (int i = 0; i < g->variant_count; i++) {
        const am_screen_info *v = &g->variants[i].screen;
        if (v->width == s->screen.width && v->height == s->screen.height &&
            v->density == s->screen.density && v->pixel_stride == 4 && v->row_padding == 0) {
            return i;
        }
    }

    if (mode == 0) return -1;

    int best = 0;
    long best_score = (mode == 2)
                    ? aspect_distance(&s->screen, &g->variants[0].screen)
                    : am_variant_distance(&s->screen, &g->variants[0].screen);
    long best_edge = edge_distance(&s->screen, &g->variants[0].screen);

    for (int i = 1; i < g->variant_count; i++) {
        const long sc = (mode == 2)
                      ? aspect_distance(&s->screen, &g->variants[i].screen)
                      : am_variant_distance(&s->screen, &g->variants[i].screen);
        const long ed = edge_distance(&s->screen, &g->variants[i].screen);

        if (sc < best_score || (sc == best_score && ed < best_edge)) {
            best_score = sc;
            best_edge = ed;
            best = i;
        }
    }
    return best;
}

/* ------------------------------------------------------------------ *
 * geometry
 * ------------------------------------------------------------------ */

am_rect am_script_group_rect(am_script *s, const am_template_group *g)
{
    am_rect zero;
    memset(&zero, 0, sizeof(zero));
    if (!s || !g || g->variant_count <= 0) return zero;

    const int vi = choose_variant(s, g);
    if (vi < 0) return zero;

    return am_adapt_rect(&s->screen, &g->variants[vi].screen, g->variants[vi].rect);
}

am_rect am_script_crop_rect(am_script *s, const am_var *v, int index)
{
    am_rect zero;
    memset(&zero, 0, sizeof(zero));
    if (!s || !v || index < 0 || index >= v->crop_count) return zero;

    return am_adapt_rect(&s->screen, &v->crops[index].screen, v->crops[index].rect);
}

/*
 * base/c.e(cVar): the search region when an action has no search_id is the
 * template's own rectangle grown by expand_size on all four sides.
 */
am_rect am_script_search_rect_from_template(am_script *s, am_rect tpl_rect)
{
    am_rect out = tpl_rect;
    if (!s) return out;
    const int f = s->header.expand_size;
    if (f == 0) return out;
    out.x -= f;
    out.y -= f;
    out.w += 2 * f;
    out.h += 2 * f;
    return out;
}

/* ------------------------------------------------------------------ *
 * template rendering
 * ------------------------------------------------------------------ */

/*
 * Decode a variant's PNG and scale it to the current screen, mirroring
 * EditorImage.createImage / framework.base.c.f(cVar) (the `i8 == 1` branch):
 *
 *     f8   = one factor for BOTH axes  (c.java:246: new Size(w*f8, h*f8))
 *     rect = am_adapt_rect(rec, rect)  (the same uniform factor)
 *
 * so the template and its rectangle always stay in the same scale. The template
 * PNG is stored at its variant's resolution, hence scaling it by the variant's
 * recorded->current factor is what puts it in current-frame pixels.
 *
 * When the factor is 1.0 the decoded pixels are used as-is: on a device whose
 * resolution matches a recorded variant there is no resampling at all, so NCC
 * sees exactly the recorded template (this is the pixel-exact fast path).
 */
static int render_variant(am_script *s, const am_template_variant *tv, am_mat *out)
{
    if (!s->io.read) return -1;

    char name[160];
    snprintf(name, sizeof(name), "image/%s", tv->file);

    void *png = NULL;
    size_t png_size = 0;
    if (s->io.read(s->io.ctx, name, &png, &png_size) != 0) {
        /* flat layouts (test fixtures) store the file without the image/ prefix */
        if (s->io.read(s->io.ctx, tv->file, &png, &png_size) != 0) return -1;
    }

    int w = 0, h = 0;
    if (am_png_size(png, png_size, &w, &h) != 0 || w <= 0 || h <= 0) {
        if (s->io.release) s->io.release(s->io.ctx, png); else free(png);
        return -1;
    }

    unsigned char *gray = (unsigned char *)malloc((size_t)w * (size_t)h);
    if (!gray) {
        if (s->io.release) s->io.release(s->io.ctx, png); else free(png);
        return -1;
    }

    int dw = 0, dh = 0;
    if (am_png_decode_gray(png, png_size, gray, (size_t)w * (size_t)h, &dw, &dh) != 0) {
        free(gray);
        if (s->io.release) s->io.release(s->io.ctx, png); else free(png);
        return -1;
    }
    if (s->io.release) s->io.release(s->io.ctx, png); else free(png);

    /*
     * Record what the template was recorded at, then decide the target size.
     * The template's PNG is stored at its variant's resolution (a 1200x2000
     * variant of 幻想 is a 165x26 blob), so the target factor is the variant's
     * recorded screen -> current screen, i.e. exactly am_adapt_factors.
     * framework/base/c.java:243-246 scales width AND height by one factor f8.
     */
    const am_screen_info *rec = &tv->screen;

    double scale_x = 1.0, scale_y = 1.0;
    am_adapt_factors(&s->screen, rec, &scale_x, &scale_y);
    const double scale = scale_x;

    int tw = (int)lround((double)dw * scale);
    int th = (int)lround((double)dh * scale);
    if (tw < 1) tw = 1;
    if (th < 1) th = 1;

    /* (void)scale_y: the factor is uniform by construction; kept for clarity. */
    (void)scale_y;

    if (tw == dw && th == dh) {
        out->pixels = gray;
        out->width = dw;
        out->height = dh;
        out->stride = dw;
        return 0;
    }

    /* bilinear resample; keeps template gradients smooth so NCC peaks stay
     * comparable to what OpenCV produced on Android */
    unsigned char *scaled = (unsigned char *)malloc((size_t)tw * (size_t)th);
    if (!scaled) { free(gray); return -1; }

    for (int y = 0; y < th; y++) {
        const double sy = ((double)y + 0.5) * (double)dh / (double)th - 0.5;
        int y0 = (int)floor(sy);
        double fy = sy - (double)y0;
        if (y0 < 0) { y0 = 0; fy = 0.0; }
        int y1 = y0 + 1;
        if (y1 > dh - 1) { y1 = dh - 1; }
        if (y0 > dh - 1) { y0 = dh - 1; }

        for (int x = 0; x < tw; x++) {
            const double sx = ((double)x + 0.5) * (double)dw / (double)tw - 0.5;
            int x0 = (int)floor(sx);
            double fx = sx - (double)x0;
            if (x0 < 0) { x0 = 0; fx = 0.0; }
            int x1 = x0 + 1;
            if (x1 > dw - 1) { x1 = dw - 1; }
            if (x0 > dw - 1) { x0 = dw - 1; }

            const double p00 = gray[(size_t)y0 * dw + x0];
            const double p10 = gray[(size_t)y0 * dw + x1];
            const double p01 = gray[(size_t)y1 * dw + x0];
            const double p11 = gray[(size_t)y1 * dw + x1];

            const double top = p00 + (p10 - p00) * fx;
            const double bot = p01 + (p11 - p01) * fx;
            double v = top + (bot - top) * fy;
            if (v < 0.0) v = 0.0;
            if (v > 255.0) v = 255.0;
            scaled[(size_t)y * tw + x] = (unsigned char)(v + 0.5);
        }
    }

    free(gray);
    out->pixels = scaled;
    out->width = tw;
    out->height = th;
    out->stride = tw;
    return 0;
}

const am_mat *am_script_template(am_script *s, am_template_group *g)
{
    if (!s || !g || !s->cache) return NULL;

    const int idx = (int)(g - s->groups);
    if (idx < 0 || idx >= s->template_group_count) return NULL;

    if (s->cache[idx].valid && s->cache[idx].gen == s->cache_gen) {
        return &s->cache[idx].mat;
    }

    am_mat_free(&s->cache[idx].mat);
    s->cache[idx].valid = 0;

    const int vi = choose_variant(s, g);
    if (vi < 0) return NULL;

    if (render_variant(s, &g->variants[vi], &s->cache[idx].mat) != 0) {
        am_mat_free(&s->cache[idx].mat);
        return NULL;
    }

    s->cache[idx].variant = vi;
    s->cache[idx].gen = s->cache_gen;
    s->cache[idx].valid = 1;
    return &s->cache[idx].mat;
}

/* ------------------------------------------------------------------ *
 * .auto (ZIP) loading
 * ------------------------------------------------------------------ */

/* Callback context: a borrowed pointer to the archive the script owns. The
 * struct itself is heap allocated because am_script_io::ctx must outlive this
 * call and is freed by am_script_free. */
typedef struct {
    am_auto *zip;
} am_auto_io_ctx;

static int auto_io_read(void *ctx, const char *name, void **out_data, size_t *out_size)
{
    am_auto_io_ctx *c = (am_auto_io_ctx *)ctx;
    if (!c || !c->zip || !name || !out_data || !out_size) return -1;
    if (!am_auto_has(c->zip, name)) return -1;
    return am_auto_read_alloc(c->zip, name, (unsigned char **)out_data, out_size);
}

static void auto_io_release(void *ctx, void *data)
{
    (void)ctx;
    free(data);
}

/*
 * Load straight from a .auto file (ZIP). The archive is kept open for the
 * lifetime of the script because templates are still read lazily, so this
 * function takes ownership of it: the archive is closed by am_script_free.
 *
 * For a flat directory layout (test fixtures keep every PNG beside
 * script.json) use am_script_init + am_script_load_json and install your own
 * read callback instead.
 */
int am_script_load_auto(am_script *s, const char *auto_path, const am_screen *screen)
{
    if (!s || !auto_path) return -1;

    am_auto *zip = NULL;
    if (am_auto_open(auto_path, &zip) != 0) {
        snprintf(s->error, sizeof(s->error), "cannot open .auto: %s", auto_path);
        return -1;
    }

    unsigned char *json = NULL;
    size_t json_size = 0;
    if (am_auto_read_alloc(zip, "script.json", &json, &json_size) != 0) {
        snprintf(s->error, sizeof(s->error), ".auto has no script.json");
        am_auto_close(zip);
        return -1;
    }

    am_auto_io_ctx *ctx = (am_auto_io_ctx *)malloc(sizeof(*ctx));
    if (!ctx) {
        free(json);
        am_auto_close(zip);
        return -1;
    }
    ctx->zip = zip;

    s->zip = zip;
    s->zip_ctx = ctx;
    s->io.ctx = ctx;
    s->io.read = auto_io_read;
    s->io.release = auto_io_release;

    const int rc = am_script_load_json(s, (const char *)json, json_size, screen);
    free(json);
    if (rc != 0) {
        am_script_free(s);          /* closes the archive and frees the ctx */
        return -1;
    }
    return 0;
}

const char *am_action_type_name(int type)
{
    switch (type) {
        case AM_ACT_TAP:          return "Tap";
        case AM_ACT_IMAGE:        return "Image";
        case AM_ACT_VARIABLE:     return "ModifyVariable";
        case AM_ACT_SCREEN_VALUE: return "ScreenValue";
        case AM_ACT_IMAGE_COORD:  return "ImageCoord";
        case AM_ACT_INPUT:        return "Input";
        case AM_ACT_SLIDE:        return "Slide";
        case AM_ACT_ZOOM:         return "Zoom";
        case AM_ACT_RESET:        return "Reset";
        case AM_ACT_FINISH:       return "Finish";
        case AM_ACT_SYSTEM_KEY:   return "SystemKey";
        case AM_ACT_JS:           return "JS";
        case AM_ACT_DELAY:        return "Delay";
        case AM_ACT_CLICK_TEXT:   return "ClickText";
        case AM_ACT_APP:          return "App";
        case AM_ACT_LABEL:        return "Label";
        case AM_ACT_LABEL_COORD:  return "LabelCoord";
        case AM_ACT_PLUGIN:       return "Plugin";
        case AM_ACT_CLICK_COLOR:  return "ClickColor";
        case AM_ACT_GESTURE:      return "Gesture";
        case AM_ACT_NODE_TEXT:    return "NodeText";
        case AM_ACT_NODE:         return "Node";
        case AM_ACT_NODE_COORD:   return "NodeCoord";
        case AM_ACT_COLOR_COORD:  return "ColorCoord";
        case AM_ACT_TEXT_COORD:   return "TextCoord";
        case AM_ACT_UPDATE_IMAGE: return "UpdateImage";
        case AM_ACT_JS_PLUGIN:    return "JSPlugin";
        default:                  return "Unknown";
    }
}

