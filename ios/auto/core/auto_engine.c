/*
 * auto_engine.c -- per-frame state machine driving an am_script.
 *
 * Every rule here comes from the decompiled Android reference implementation
 * (cn.autoeditor v4.3.8). Class/method references in comments point at
 * ios/auto/decomp/sources so any of them can be re-checked. The four places
 * where we knowingly differ are marked DEVIATION with the reason.
 *
 * Pure C99 plus auto_script/auto_match. No stdio, no time source, no platform
 * headers -- the clock and the touch injector arrive through am_engine_host,
 * which is what makes the whole engine testable against recorded screenshots.
 */
#include "auto_engine.h"

/* MSVC deprecates the whole str* family in favour of the _s variants; the plain
 * ones are correct C99 and are what every other platform here uses. The build
 * passes /D_CRT_SECURE_NO_WARNINGS instead of defining it here, because <string.h>
 * is pulled in by the header above. */
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

static void trace(am_engine *e, const char *msg)
{
    if (e->host.trace) e->host.trace(e->host.ctx, msg);
}

static void set_error(am_engine *e, int code, const char *msg)
{
    e->last_error = code;
    if (msg) {
        strncpy(e->error, msg, sizeof(e->error) - 1);
        e->error[sizeof(e->error) - 1] = '\0';
    } else {
        e->error[0] = '\0';
    }
}

static long long host_now(am_engine *e)
{
    return e->host.now_ms ? e->host.now_ms(e->host.ctx) : 0;
}

static void host_sleep(am_engine *e, int ms)
{
    if (ms > 0 && e->host.sleep_ms) e->host.sleep_ms(e->host.ctx, ms);
}

/* Deterministic PRNG. Android draws from java.util.Random (a 48-bit LCG) seeded
 * from the clock; what matters for the port is the DISTRIBUTION -- a uniform
 * point inside the matched rectangle -- not the sequence. Marsaglia xorshift32
 * is uniform enough for that and, with a fixed seed, reproducible, which is what
 * lets the click-point rule be asserted in a unit test against a recorded
 * screenshot. See am_engine_rand_below. */
unsigned int am_engine_rand_below(am_engine *e, unsigned int n)
{
    if (!e || n == 0) return 0;
    unsigned int x = e->rng ? e->rng : 0x2545F491u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    e->rng = x;
    return x % n;
}

/*
 * The first-leaf fold of framework/i/m.b().
 *
 * Folding leaf k into the running result, the reference computes
 *
 *     result = (relation == 2) ? (result | leaf) : (result & leaf)
 *
 * for every leaf AFTER the first, starting from `result = true`. For the first
 * leaf it takes a different branch whose decompiled body is a chain of empty
 * if-statements followed by `z8 = d8` -- i.e. the running result is REPLACED by
 * the leaf rather than combined with it. Two consequences:
 *   - a one-leaf group returns exactly its leaf (the common case, and what any
 *     sane reading would expect);
 *   - for a two-leaf group the first leaf contributes nothing, so an AND group
 *     holds iff its SECOND leaf holds.
 *
 * The second point is a real quirk of the reference implementation, and it is
 * observable on the device: the sample script's "mei kai zhao mu" scene has two
 * AND-ed image conditions and fires as soon as the second one matches. We
 * reproduce it, because a port that is "more correct" here would fire a scene
 * the user never saw fire on Android.
 */
static int fold_first_leaf(int leaf)
{
    return leaf;
}

static int rect_valid(am_rect r)
{
    return r.w > 0 && r.h > 0;
}

static am_rect rect_empty(void)
{
    am_rect r;
    r.x = r.y = r.w = r.h = 0;
    return r;
}

/* Intersect, OpenCV Rect semantics: a non-overlapping intersection is empty. */
static am_rect rect_intersect(am_rect a, am_rect b)
{
    const int x0 = a.x > b.x ? a.x : b.x;
    const int y0 = a.y > b.y ? a.y : b.y;
    const int x1 = (a.x + a.w) < (b.x + b.w) ? (a.x + a.w) : (b.x + b.w);
    const int y1 = (a.y + a.h) < (b.y + b.h) ? (a.y + a.h) : (b.y + b.h);
    am_rect r;
    r.x = x0;
    r.y = y0;
    r.w = x1 - x0;
    r.h = y1 - y0;
    if (r.w < 0) r.w = 0;
    if (r.h < 0) r.h = 0;
    return r;
}

/* ------------------------------------------------------------------ *
 * lifetime
 * ------------------------------------------------------------------ */

void am_engine_reset(am_engine *e)
{
    if (!e || !e->script) return;
    const int ns = e->script->scene_count;

    e->frame = 0;
    e->current_scene = -1;
    e->running = 1;
    e->started = 0;
    e->tap_count = 0;
    e->last_error = 0;
    e->error[0] = '\0';
    e->rng = AM_ENGINE_RNG_SEED;
    e->unsupported = 0;

    for (int i = 0; i < ns && i < AM_MAX_SCENES; i++) {
        e->gates[i].active = 0;
        e->gates[i].since_ms = 0;
    }
    if (e->timeouts) {
        memset(e->timeouts, 0,
               sizeof(e->timeouts[0]) * (size_t)ns * (size_t)AM_MAX_EVENTS);
    }
    if (e->cursor) {
        for (int i = 0; i < ns; i++) e->cursor[i] = -1;
    }
    if (e->cache) {
        for (int i = 0; i < e->cache_count; i++) e->cache[i].frame = -1;
    }
}

int am_engine_init(am_engine *e, am_script *s, const am_engine_host *host,
                   int width, int height)
{
    if (!e) return -1;
    memset(e, 0, sizeof(*e));
    if (!s || width <= 0 || height <= 0) {
        set_error(e, AM_ENGINE_ERR_ARG, "engine needs a script and a frame size");
        return -1;
    }
    e->script = s;
    if (host) e->host = *host;
    e->width = width;
    e->height = height;

    const int ns = s->scene_count > 0 ? s->scene_count : 1;

    e->timeouts = (void *)calloc((size_t)ns * (size_t)AM_MAX_EVENTS,
                                 sizeof(e->timeouts[0]));
    e->cursor = (int *)calloc((size_t)ns, sizeof(int));
    if (!e->timeouts || !e->cursor) {
        am_engine_free(e);
        set_error(e, AM_ENGINE_ERR_MEMORY, "out of memory sizing the engine");
        return -1;
    }

    /* Match cache: the number of DISTINCT (template, search rect) pairs a scene
     * can ask about is bounded by the condition count, so size it from the
     * script: one entry per condition of every scene, with a floor so tiny
     * scripts still get a usable cache. */
    int want = 0;
    for (int i = 0; i < s->scene_count; i++) {
        const am_scene *sc = &s->scenes[i];
        for (int j = 0; j < sc->event_count; j++) want += sc->events[j].item_count;
        if (sc->gate) want += sc->gate->item_count;
    }
    if (want < 8) want = 8;
    if (want > 512) want = 512;

    e->cache = (void *)calloc((size_t)want, sizeof(e->cache[0]));
    if (!e->cache) {
        am_engine_free(e);
        set_error(e, AM_ENGINE_ERR_MEMORY, "out of memory sizing the match cache");
        return -1;
    }
    e->cache_count = want;

    am_engine_reset(e);
    return 0;
}

void am_engine_free(am_engine *e)
{
    if (!e) return;
    free(e->timeouts);
    free(e->cursor);
    free(e->cache);
    free(e->frame_buf);
    e->timeouts = NULL;
    e->cursor = NULL;
    e->cache = NULL;
    e->frame_buf = NULL;
    e->frame_cap = 0;
}

void am_engine_stop(am_engine *e)
{
    if (e) e->running = 0;
}

/* ------------------------------------------------------------------ *
 * match cache
 * ------------------------------------------------------------------ */

void am_engine_invalidate_cache(am_engine *e)
{
    if (!e || !e->cache) return;
    for (int i = 0; i < e->cache_count; i++) e->cache[i].frame = -1;
}

static int rect_equal(am_rect a, am_rect b)
{
    return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h;
}

/*
 * Match `g` inside `search`, reusing the per-frame cache.
 *
 * The cache key is (template group index, search rect), which is what Android
 * keys on (the Rect instance itself, per template). It is valid for exactly one
 * frame: cn/autoeditor/framework/base/c.g() compares its stored frame counter
 * (f1047b) against c.f1140w and throws the whole map away when they differ. That
 * is the mechanism that keeps a scene with several image conditions affordable
 * -- the same template and rect is matched once per frame no matter how many
 * conditions and actions ask for it.
 */
void am_engine_match(am_engine *e, am_template_group *g, am_rect search,
                     am_match_result *out)
{
    memset(out, 0, sizeof(*out));
    if (!e || !e->script || !g) return;

    const int gi = (int)(g - e->script->groups);
    if (gi < 0 || gi >= e->script->template_group_count) return;

    if (e->cache) {
        for (int i = 0; i < e->cache_count; i++) {
            if (e->cache[i].frame == e->frame
                && e->cache[i].group == gi
                && rect_equal(e->cache[i].rect, search)) {
                *out = e->cache[i].res;
                return;
            }
        }
    }

    am_match_result res;
    memset(&res, 0, sizeof(res));

    /* The search rect has to be usable AND inside the frame. Android clips it
     * (base/c.java d(): shift by the negative offset, clamp the far edge to the
     * frame) and then gives up if what is left is smaller than the template.
     * Clipping matters whenever expand_size or a crop rect pokes past the edge,
     * which is normal on a different aspect ratio. */
    am_rect r = rect_intersect(search, (am_rect){ 0, 0, e->width, e->height });

    const am_mat *tpl = am_script_template(e->script, g);
    if (tpl && tpl->pixels && tpl->width > 0 && tpl->height > 0
        && rect_valid(r) && r.w >= tpl->width && r.h >= tpl->height) {
        if (!e->frame_buf) {
            /* am_engine_scene_active()/am_engine_eval_event() are public, so a
             * caller may evaluate a condition before the first capture. There is
             * no frame to search yet; report "no match" rather than dereferencing
             * a NULL frame. */
            *out = res;
            return;
        }
        const int stride = (int)(e->frame_cap / (size_t)e->height);
        am_gray roi;
        roi.data = e->frame_buf + (size_t)r.y * (size_t)stride + (size_t)r.x;
        roi.width = r.w;
        roi.height = r.h;
        roi.stride = stride;
        if (am_match_template(&roi, tpl ? &(am_gray){ tpl->pixels, tpl->width, tpl->height, tpl->stride } : NULL,
                              &res)) {
            /* Back to frame coordinates, like base/c.java does when it stores
             * p1.f1442a = maxLoc.x + rect.x. */
            res.x += r.x;
            res.y += r.y;
        }
    }

    if (e->cache) {
        /* Linear scan; the entry count equals the script's condition count
         * (tens), so it beats hashing. First free/matching slot wins, evicting
         * the oldest frame when full. */
        int slot = -1;
        for (int i = 0; i < e->cache_count; i++) {
            if (e->cache[i].frame != e->frame) { slot = i; break; }
        }
        if (slot < 0) slot = 0;
        e->cache[slot].frame = e->frame;
        e->cache[slot].group = gi;
        e->cache[slot].rect = search;
        e->cache[slot].res = res;
    }

    *out = res;
}

/* ------------------------------------------------------------------ *
 * search rect
 * ------------------------------------------------------------------ */

/*
 * Mirrors cn/autoeditor/framework/base/c.e().
 *
 *   F = expand_size (c.F, the script's expand_size)
 *   expand_size == -1  ->  the whole frame
 *   no search variable ->  the template rect grown by expand_size on all sides
 *   search variable    ->  that variable's first crop rect, intersected with the
 *                          template rect. Android wraps this in
 *                          `if (this.f1050e == null && !f(cVar)) return null`,
 *                          i.e. the template must be loadable first.
 *
 * The returned rect may lie partly outside the frame; am_engine_match clips it.
 */
int am_engine_search_rect(am_engine *e, am_template_group *g, am_var *search,
                          am_rect *out)
{
    if (!e || !e->script) return -1;
    *out = rect_empty();

    if (e->script->header.expand_size == -1) {
        out->x = 0;
        out->y = 0;
        out->w = e->width;
        out->h = e->height;
        return 0;
    }

    const am_rect tpl = am_script_group_rect(e->script, g);
    if (!rect_valid(tpl)) return -1;

    if (!search) {
        *out = am_script_search_rect_from_template(e->script, tpl);
        return rect_valid(*out) ? 0 : -1;
    }

    const am_rect crop = am_script_crop_rect(e->script, search, 0);
    if (!rect_valid(crop)) return -1;

    /* DEVIATION (searching): Android intersects unconditionally. On a different
     * aspect ratio that intersection can come out empty -- e.g. a 12:9 recording
     * replayed on a 9:19.5 phone, where the crop rect and the template rect no
     * longer overlap -- and the scene then silently never fires. When the
     * intersection is empty we fall back to the template rect grown by
     * expand_size, which still constrains the search to the neighbourhood where
     * the template was recorded instead of scanning the whole frame. */
    am_rect r = rect_intersect(tpl, crop);
    if (!rect_valid(r)) r = am_script_search_rect_from_template(e->script, tpl);

    *out = r;
    return rect_valid(r) ? 0 : -1;
}

/* ------------------------------------------------------------------ *
 * conditions
 * ------------------------------------------------------------------ */

static int cond_image(am_engine *e, const am_cond *c, am_match_result *out)
{
    am_template_group *g = am_script_find_group(e->script, c->image_id);
    if (!g) return 0;

    am_var *search = c->search_id[0] ? am_script_find_var(e->script, c->search_id) : NULL;

    am_rect r;
    if (am_engine_search_rect(e, g, search, &r) != 0) return 0;

    am_match_result m;
    am_engine_match(e, g, r, &m);
    if (out) *out = m;

    /* cn/autoeditor/framework/i/c.java g(): `return p1.f1446e >= this.f7959i.f1049d
     * ? 1 : 2;` -- the comparison is `peak >= sim`, and sim is the GROUP's
     * threshold (base/c.java f1049d, set from the image's sim). */
    if (!m.found) return 0;
    return m.peak >= g->sim ? 1 : 0;
}

/*
 * Integer comparison for variable conditions.
 *
 * The editor's relation operator is not in the condition record we parse
 * (cn.autoeditor.editor.EditorCondition keeps it, the runtime i.m leaf does not),
 * so this is the equality-only form that the reference scripts' own default
 * implies. A variable condition on a non-numeric value compares as strings.
 */
static int cond_var(am_engine *e, const am_cond *c)
{
    const am_var *v = am_script_find_var(e->script, c->var_id);
    if (!v) return 0;
    return strcmp(v->value, c->value) == 0 ? 1 : 0;
}

/*
 * One leaf condition. `out_match` receives the match for image conditions so
 * callers can log where the template was found.
 *
 * DEVIATION (unsupported leaves): color / label / node / text conditions need
 * the Android OCR and accessibility layers, which this port does not implement.
 * They evaluate to "does not hold" and are counted so the caller can refuse the
 * script rather than silently running it wrong. See am_engine_check_supported().
 */
static int cond_eval(am_engine *e, const am_cond *c, am_match_result *out_match)
{
    if (out_match) memset(out_match, 0, sizeof(*out_match));

    switch (c->type) {
    case AM_COND_IMAGE:
        return cond_image(e, c, out_match);

    case AM_COND_VAR:
        return cond_var(e, c);

    case AM_COND_GROUP:
        /* parse_item_group() counts these into unsupported_groups and does NOT
         * flatten them into items, so a nested group never reaches here unless a
         * leaf's own type field says 5. Treat it as not holding. */
        return 0;

    default:
        return 0;
    }
}

int am_engine_eval_event(am_engine *e, int scene, int event, int instant)
{
    if (!e || !e->script) return 0;
    if (scene < 0 || scene >= e->script->scene_count) return 0;

    const am_scene *sc = &e->script->scenes[scene];
    const am_event *ev;
    if (event == AM_ENGINE_GATE_EVENT) {
        if (!sc->gate) return 1;        /* no gate: always active */
        ev = sc->gate;
    } else {
        if (event < 0 || event >= sc->event_count) return 0;
        ev = &sc->events[event];
    }

    /* An event with no conditions at all fires unconditionally -- that is what
     * framework/b.java does (`mVar5 != null ? mVar5.b(...) : true`). */
    if (ev->item_count == 0) return 1;

    /*
     * Combine the leaves. framework/i/m.b() folds leaf k into the running result
     * as
     *
     *     result = (relation == 2) ? (result | leaf) : (result & leaf)
     *
     * where `relation` is the GROUP's (ev->relation) and every leaf's own is
     * ignored. The reference starts from `result = true`, but for the FIRST leaf
     * it takes a different branch that replaces the running result instead of
     * combining with it (see fold_first_leaf), so the first leaf's value passes
     * through uncombined.
     */
    int result = 1;
    for (int i = 0; i < ev->item_count; i++) {
        const int leaf = cond_eval(e, &ev->items[i], NULL);
        result = (i == 0) ? fold_first_leaf(leaf)
                          : ((ev->relation == 2) ? (result | leaf) : (result & leaf));
    }

    /*
     * Timeout layer, framework/i/h.java d()/b().
     *
     *   timeout > 0: the event holds once the raw condition has been continuously
     *                true for more than `timeout` seconds. `reset_timeout` clears
     *                the start stamp as soon as it holds, so the next evaluation
     *                restarts the clock -- a "hold for N seconds, then fire once
     *                per N seconds" pulse.
     *   timeout == 0: the raw result.
     *
     * `instant` is Android's z flag: the scene gate is evaluated with it, which
     * refreshes the bookkeeping but ignores the timeout when deciding. Because
     * the gate has no timeout in practice, the visible effect is the raw result.
     */
    const int idx = (event == AM_ENGINE_GATE_EVENT) ? 0 : (event + 1);
    if (idx < AM_MAX_EVENTS && e->timeouts) {
        const int slot = scene * AM_MAX_EVENTS + idx;
        const int tmo = ev->items[0].timeout;       /* group-level, on the first leaf */
        if (tmo > 0 && !instant) {
            const long long now = host_now(e);
            if (result) {
                if (e->timeouts[slot].entered_ms == 0) {
                    e->timeouts[slot].entered_ms = now;
                }
                e->timeouts[slot].held_ms = now - e->timeouts[slot].entered_ms;
                if (e->timeouts[slot].held_ms > (long long)tmo * 1000) {
                    if (ev->items[0].reset_timeout) e->timeouts[slot].entered_ms = 0;
                    return 1;
                }
                return 0;
            }
            e->timeouts[slot].entered_ms = 0;
            e->timeouts[slot].held_ms = 0;
            return 0;
        }
    }

    return result;
}

int am_engine_scene_active(am_engine *e, int scene)
{
    if (!e || !e->script) return 0;
    if (scene < 0 || scene >= e->script->scene_count) return 0;

    const am_scene *sc = &e->script->scenes[scene];
    if (sc->disabled) return 0;

    /* framework/b.java:39-46. With no gate the reference sets f1004f=false and
     * relies on the static f998h handshake to let one ungated scene take over;
     * see the DEVIATION note in am_engine_step(). */
    if (!sc->gate) return 1;

    return am_engine_eval_event(e, scene, AM_ENGINE_GATE_EVENT, 1);
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

static void record_tap(am_engine *e, int scene, int event, int action,
                       const am_action *a, int x, int y, int press_ms,
                       double peak, am_rect match, am_rect rect)
{
    if (e->tap_count >= AM_MAX_TAPS) return;
    am_tap_record *t = &e->taps[e->tap_count++];
    t->frame = e->frame;
    t->scene = scene;
    t->event = event;
    t->action = action;
    t->type = a ? a->type : 0;
    t->x = x;
    t->y = y;
    t->press_ms = press_ms;
    t->peak = peak;
    t->match = match;
    t->rect = rect;
}

/*
 * The image action, h/f.java a().
 *
 *   if (match == NULL || match.peak < sim) return 0;      -- no tap, no delay
 *   for (i = 0; i < click_times; i++) {
 *       if (i > 0) sleep(interval);
 *       x = rand(tpl_w) + match.x
 *       y = rand(tpl_h) + match.y
 *       press = press_time > 0 ? press_time : rand(30) + 20   // MILLISECONDS
 *       touch(x, y, press)
 *   }
 *   return postpone;
 *
 * Two things worth stating because they are easy to assume otherwise:
 *   - the click point is a UNIFORM RANDOM point inside the matched rectangle,
 *     not its centre (this is the single most important behaviour for the port
 *     to be acceptable to the game's own anti-bot heuristics);
 *   - `press_time` is in SECONDS in the model and the default is 20..49 ms.
 */
static double action_image(am_engine *e, int scene, int event, int action_idx,
                           const am_action *a)
{
    am_template_group *g = am_script_find_group(e->script, a->image_id);
    if (!g) {
        trace(e, "image action: template not found");
        return 0.0;
    }

    am_var *search = a->search_id[0] ? am_script_find_var(e->script, a->search_id) : NULL;

    am_rect sr;
    if (am_engine_search_rect(e, g, search, &sr) != 0) return 0.0;

    am_match_result m;
    am_engine_match(e, g, sr, &m);

    if (!m.found || m.peak < g->sim) return 0.0;   /* h/f.java: `return 0.0d` */

    am_rect hit;
    hit.x = m.x;
    hit.y = m.y;
    hit.w = m.w;
    hit.h = m.h;
    if (!rect_valid(hit)) return 0.0;

    const am_mat *tpl = am_script_template(e->script, g);
    if (tpl && tpl->width > 0 && tpl->height > 0) {
        hit.w = tpl->width;
        hit.h = tpl->height;
    }

    int times = a->click_times > 0 ? a->click_times : 1;
    for (int i = 0; i < times; i++) {
        if (i > 0 && a->interval > 0.0) {
            host_sleep(e, (int)(a->interval * 1000.0));
        }

        const int x = (int)(am_engine_rand_below(e, (unsigned)hit.w)) + hit.x;
        const int y = (int)(am_engine_rand_below(e, (unsigned)hit.h)) + hit.y;

        int press_ms = (int)(a->press_time * 1000.0);
        if (press_ms <= 0) press_ms = (int)(am_engine_rand_below(e, 30u)) + 20;

        if (e->host.touch) {
            if (e->host.touch(e->host.ctx, x, y, press_ms) != 0) {
                /* A dropped tap must not kill the scene: log it, keep the scene
                 * alive, and let the caller decide (see am_engine_step). */
                set_error(e, AM_ENGINE_ERR_TOUCH, "touch injection failed");
            }
        }
        record_tap(e, scene, event, action_idx, a, x, y, press_ms, m.peak, hit, hit);
    }

    return a->postpone;
}

static double action_variable(am_engine *e, int scene, int event, int action_idx,
                              const am_action *a)
{
    (void)scene; (void)event; (void)action_idx;
    am_var *v = am_script_find_var(e->script, a->image_id);
    if (!v || v->crop_count == 0) return 0.0;

    const am_rect r = am_script_crop_rect(e->script, v, 0);
    if (!rect_valid(r)) return 0.0;

    int press_ms = (int)(a->press_time * 1000.0);
    if (press_ms <= 0) press_ms = (int)(am_engine_rand_below(e, 30u)) + 10;

    const int x = (int)(am_engine_rand_below(e, (unsigned)r.w)) + r.x;
    const int y = (int)(am_engine_rand_below(e, (unsigned)r.h)) + r.y;

    if (e->host.touch && e->host.touch(e->host.ctx, x, y, press_ms) != 0) {
        set_error(e, AM_ENGINE_ERR_TOUCH, "touch injection failed");
    }
    record_tap(e, scene, event, action_idx, a, x, y, press_ms, 0.0, r, r);
    return a->postpone;
}

/*
 * Run one action; returns the value cn/autoeditor/framework/a.b() sleeps on.
 * Only the types the port implements do anything; every other type reports the
 * delay it would have used and is counted by am_engine_check_supported().
 */
static double action_run(am_engine *e, int scene, int event, int action_idx,
                         const am_action *a)
{
    switch (a->type) {
    case AM_ACT_IMAGE:
        return action_image(e, scene, event, action_idx, a);

    case AM_ACT_TAP:
        return action_variable(e, scene, event, action_idx, a);

    case AM_ACT_DELAY:
        host_sleep(e, (int)(a->postpone * 1000.0));
        return 0.0;

    case AM_ACT_FINISH:
        e->running = 0;
        return 0.0;

    default:
        /* Known-but-unimplemented (colour, text, node, gesture, ...) and unknown
         * types both land here: do nothing, keep the script running. */
        return a->postpone;
    }
}

/*
 * One event: run its actions in order, sleeping by each action's return value.
 * Mirrors a.b() (cn/autoeditor/framework/a.java:36-42).
 */
static void event_run(am_engine *e, int scene, int event, const am_event *ev)
{
    for (int i = 0; i < ev->action_count; i++) {
        const double delay = action_run(e, scene, event, i, &ev->actions[i]);
        if (delay > 0.0) host_sleep(e, (int)(delay * 1000.0));
        if (!e->running) break;
    }
}

/* ------------------------------------------------------------------ *
 * the round
 * ------------------------------------------------------------------ */

/*
 * A scene's event loop: framework/b.java:100-132.
 *
 *   for (i = 0; i < events; i++) {
 *       if (i <= cursor) continue;              // f999a
 *       if (!conditions(i)) continue;
 *       cursor = i;
 *       run actions(i);
 *       if (breakable(i) || stop_requested) break;
 *   }
 *
 * `breakable` is EditorEvent.breakable(): true when ANY action implements the
 * cn.autoeditor.editor.action.a marker interface. EditorImageAction does, so an
 * image event always ends its scene's round. That is what makes the "first
 * matching event wins" behaviour visible: a scene whose second event would also
 * match does not fire it in the same frame.
 *
 * am_event::breakable is computed at parse time from the same marker-interface
 * class list (see action_next_mode), because the property belongs to the event
 * and not to any single action of it.
 */
static void scene_run_events(am_engine *e, int scene)
{
    const am_scene *sc = &e->script->scenes[scene];
    const int cursor = (e->cursor && scene < AM_MAX_SCENES) ? e->cursor[scene] : -1;

    for (int i = 0; i < sc->event_count; i++) {
        if (i <= cursor) continue;          /* never revisit an event this round */
        if (!am_engine_eval_event(e, scene, i, 0)) continue;

        if (e->cursor && scene < AM_MAX_SCENES) e->cursor[scene] = i;
        event_run(e, scene, i, &sc->events[i]);

        if (sc->events[i].breakable) {
            if (e->cursor && scene < AM_MAX_SCENES) e->cursor[scene] = -1;
            return;
        }
        if (!e->running) return;
    }

    /* Android resets the cursor at the end of the round
     * (`if (f999a >= size - 1) f999a = -1`), so the next round starts at the
     * scene head again. */
    if (e->cursor && scene < AM_MAX_SCENES) e->cursor[scene] = -1;
}

/*
 * Grab a frame into the engine's own buffer.
 *
 * This is public because am_engine_scene_active() and am_engine_eval_event() are
 * too, and both read the frame: with no frame captured they have nothing to match
 * against and would report "no condition holds". A host that wants to inspect a
 * scene before the first round -- or a test that wants to check the condition
 * fold without also firing the scene's actions -- calls this first.
 *
 * Returns 1 on success, 0 when the host cannot produce a frame (or has no
 * capture callback at all).
 */
int am_engine_capture(am_engine *e)
{
    const size_t need = (size_t)e->width * (size_t)e->height;
    if (!e || !e->host.capture) return 0;

    if (e->frame_cap < need) {
        unsigned char *p = (unsigned char *)realloc(e->frame_buf, need);
        if (!p) {
            set_error(e, AM_ENGINE_ERR_MEMORY, "cannot allocate the frame buffer");
            return 0;
        }
        e->frame_buf = p;
        e->frame_cap = need;
    }
    if (e->host.capture(e->host.ctx, e->frame_buf, e->width, e->height, e->width) != 0) {
        return 0;
    }
    /* Growing the buffer can only happen on the first frame; after that the
     * stride is stable, and am_engine_match reads it back from frame_cap. */
    return 1;
}

int am_engine_step(am_engine *e)
{
    if (!e || !e->script) return -1;
    if (!e->started) {
        am_engine_reset(e);
        e->started = 1;
    }
    if (!e->running) return 0;

    if (!am_engine_capture(e)) {
        set_error(e, AM_ENGINE_ERR_CAPTURE, "frame capture failed");
        return 0;
    }

    /* The frame counter is the match-cache generation key (c.f1140w), so it has
     * to advance before anything matches. */
    e->frame++;
    am_engine_invalidate_cache(e);

    /* Step 1: re-run the scene that won the previous round, if it is still
     * active. Mirrors the `bVar != null` branch of framework/c.java:354-366. */
    int scene = -1;
    if (e->current_scene >= 0 && e->current_scene < e->script->scene_count
        && am_engine_scene_active(e, e->current_scene)) {
        scene = e->current_scene;
    } else {
        /* Step 2: otherwise take the first active scene, in table order.
         *
         * DEVIATION (scene selection): Android's chaining is
         *   - f1004f (scene active) is false for every scene WITHOUT a gate, so
         *     such a scene can never become `bVar` through the scan;
         *   - the static f998h flag lets ONE ungated scene take over per frame
         *     when no gate is currently active;
         * and the net effect on a script whose scenes are all ungated -- which
         * is every script the editor produces today -- is "the first enabled
         * scene runs forever". We implement that directly: an ungated scene is
         * simply always active. A gated script still behaves as documented above
         * (the first active scene in table order wins and keeps winning while
         * its gate holds). Copying f998h literally would add a cross-scene
         * static to a per-engine struct for no observable difference. */
        for (int i = 0; i < e->script->scene_count; i++) {
            if (am_engine_scene_active(e, i)) { scene = i; break; }
        }
    }

    if (scene < 0) {
        /* No scene is active. Not an error: a gated script can sit here waiting.
         * Sleep one interval so the caller is not spun. */
        host_sleep(e, (int)(e->script->header.loop_interval * 1000.0) + 1);
        return e->running;
    }

    if (scene != e->current_scene) {
        /* Entering a scene resets its condition timeouts, like the gate
         * transition in framework/b.java:71-79. */
        if (e->timeouts) {
            memset(&e->timeouts[scene * AM_MAX_EVENTS], 0,
                   sizeof(e->timeouts[0]) * (size_t)AM_MAX_EVENTS);
        }
        if (e->cursor) e->cursor[scene] = -1;
        e->current_scene = scene;
        trace(e, e->script->scenes[scene].name);
    }

    scene_run_events(e, scene);

    /* loop_interval, clamped. The reference scripts ask for 30 ms, which is a
     * sane frame period for a phone game; a 0 or negative value in a hand-edited
     * script would spin the CPU and flood the touch path, so the floor applies
     * to everything except an explicit "as fast as possible" host (no sleep
     * callback at all). */
    double interval = e->script->header.loop_interval;
    if (!(interval > 0.0)) interval = 0.030;
    int ms = (int)(interval * 1000.0);
    if (ms < AM_ENGINE_MIN_INTERVAL_MS) ms = AM_ENGINE_MIN_INTERVAL_MS;
    host_sleep(e, ms);

    return e->running;
}

int am_engine_run(am_engine *e, int max_rounds)
{
    int rounds = 0;
    while (rounds < max_rounds) {
        const int r = am_engine_step(e);
        if (r < 0) return rounds;
        rounds++;
        if (r == 0) break;
    }
    return rounds;
}

/* ------------------------------------------------------------------ *
 * inspection
 * ------------------------------------------------------------------ */

const am_tap_record *am_engine_taps(const am_engine *e, int *out_count)
{
    if (out_count) *out_count = e ? e->tap_count : 0;
    return e ? e->taps : NULL;
}

void am_engine_clear_taps(am_engine *e)
{
    if (e) e->tap_count = 0;
}

const char *am_engine_error_name(int code)
{
    switch (code) {
    case AM_ENGINE_OK:          return "ok";
    case AM_ENGINE_ERR_ARG:     return "bad-argument";
    case AM_ENGINE_ERR_MEMORY:  return "out-of-memory";
    case AM_ENGINE_ERR_CAPTURE: return "capture-failed";
    case AM_ENGINE_ERR_TOUCH:   return "touch-failed";
    default:                    return "unknown";
    }
}

const char *am_engine_last_error(const am_engine *e)
{
    return (e && e->error[0]) ? e->error : "";
}

/*
 * Walk every condition in the script and count the leaf types this port cannot
 * evaluate. The Android original covers colour picking, on-screen text (OCR via
 * a bundled model), accessibility nodes and system keys; none of those have an
 * equivalent here, and a condition that cannot be evaluated evaluates to "does
 * not hold" -- which silently turns a scene into a no-op. Reporting the count
 * lets the platform layer refuse the script up front instead of watching it do
 * nothing.
 */
int am_engine_check_supported(am_engine *e)
{
    if (!e || !e->script) return 0;
    int n = 0;
    for (int i = 0; i < e->script->scene_count; i++) {
        const am_scene *sc = &e->script->scenes[i];
        for (int j = 0; j < sc->event_count; j++) {
            for (int k = 0; k < sc->events[j].item_count; k++) {
                const int t = sc->events[j].items[k].type;
                if (t != AM_COND_IMAGE && t != AM_COND_VAR) n++;
            }
        }
        if (sc->gate) {
            for (int k = 0; k < sc->gate->item_count; k++) {
                const int t = sc->gate->items[k].type;
                if (t != AM_COND_IMAGE && t != AM_COND_VAR) n++;
            }
        }
    }
    e->unsupported = n;
    return n;
}
