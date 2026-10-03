/*
 * auto_engine.h -- per-frame state machine that drives an am_script.
 *
 * Mirrors the run loop of the Android reference implementation (cn.autoeditor
 * v4.3.8). The reverse-engineering evidence for every rule below is in
 * .research/ios-design.md section 2; the class names refer to the decompiled
 * sources under ios/auto/decomp/sources.
 *
 * What the engine owns: which scene is current, that scene's condition
 * timeouts, and the per-frame match cache. What it does NOT own: the screen, the
 * clock and the touch injector. Those arrive through am_engine_host so the whole
 * thing can be unit tested on a desktop with a recorded screenshot as "the
 * screen" -- which is exactly what tools/test_engine does.
 *
 * ROUND STRUCTURE (mirrors framework/c.java:335-399):
 *   1. ask the host for a frame; a failure is not fatal, the round is skipped
 *   2. increment the frame counter (this is what invalidates the match cache,
 *      exactly like c.f1140w in the reference implementation)
 *   3. re-run the scene that won the previous round; if it reports inactive,
 *      scan the scene table in order and take the first active one
 *   4. run that scene's event loop
 *   5. pause by the script's loop_interval (clamped to a floor, see below)
 *
 * EVENT LOOP (mirrors framework/b.java:100-132):
 *   Scan events in order. The first event whose conditions hold gets its actions
 *   run, and then the scan ENDS for this round -- Android's `break` is reached
 *   for every image action because EditorImageAction is one of the 14 classes
 *   implementing the cn.autoeditor.editor.action.a marker interface, which is
 *   what EditorEvent.breakable() tests. Only the handful of action types that
 *   are not "breakable" fall through to the next event in the same round.
 *
 * SCENE GATES (scene_event): the reference scripts have none, but the mechanism
 * is implemented because a script from a newer editor may use it. A scene with
 * no gate is always active. See am_engine_scene_step for the one behaviour that
 * is deliberately not copied from Android (an ungated scene permanently
 * shadowing the gated scenes after it -- see the comment there).
 */
#ifndef AUTO_ENGINE_H
#define AUTO_ENGINE_H

#include "auto_script.h"
#include "auto_match.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- host callbacks ---------- */

/*
 * The platform side. Every callback is optional except capture; a missing one
 * degrades gracefully (touch does nothing, sleep returns immediately).
 * Return conventions: `capture` and `touch` return 0 on success and non-zero on
 * failure -- and a failing touch is reported to the caller of
 * am_engine_step() rather than aborting the scene, because a single dropped tap
 * must not kill a long run.
 */
typedef struct {
    void *ctx;

    /* Grab the current frame as 8-bit grayscale, `w` x `h`, row-major with
     * `stride` bytes per row (stride >= w; pass 0 to mean w). The buffer belongs
     * to the host and stays valid until the next capture. Return non-zero if the
     * frame is unavailable, which skips this round. */
    int (*capture)(void *ctx, unsigned char *dst, int w, int h, int stride);

    /* Synthesize a tap at (x, y) held for `press_ms` milliseconds. */
    int (*touch)(void *ctx, int x, int y, int press_ms);

    /* Sleep for `ms` milliseconds. NULL means "do not sleep" -- used by tests to
     * run a script as fast as possible. */
    void (*sleep_ms)(void *ctx, int ms);

    /* Monotonic milliseconds since an arbitrary epoch. Only used for condition
     * timeouts (`timeout` seconds). NULL disables timeouts (they never expire). */
    long long (*now_ms)(void *ctx);

    /* Optional trace hook; NULL is fine. Called for each scene change, match and
     * tap. Kept as a callback so the core never pulls in stdio. */
    void (*trace)(void *ctx, const char *msg);
} am_engine_host;

/* ---------- engine ---------- */

/* Bounded history of what the engine did, for tests and on-device diagnosis. */
typedef struct {
    int  frame;             /* frame counter this tap belongs to */
    int  scene;             /* scene index, or -1 */
    int  event;             /* event index within the scene, or -1 */
    int  action;            /* action index within the event, or -1 */
    int  type;              /* am_action_type */
    int  x, y;              /* the point actually tapped (already jittered) */
    int  press_ms;
    double peak;            /* match peak that justified the tap, or 0 */
    am_rect match;          /* where the template was found (current-screen pixels) */
    am_rect rect;           /* the rect the point was drawn inside */
} am_tap_record;

#define AM_MAX_TAPS 256

/* Pseudo-event index used to evaluate a scene's gate through the same
 * condition machinery as a normal event. Chosen negative so it can never
 * collide with a real event index. */
#define AM_ENGINE_GATE_EVENT (-1)

/* Floor for the sleep at the end of a round, so a hand-edited script with a
 * nonsensical loop_interval cannot spin the CPU. The reference scripts ask for
 * 30 ms, which is the editor's own default (loop_interval in the JSON is
 * milliseconds; the model stores seconds). */
#define AM_ENGINE_MIN_INTERVAL_MS 5

/* Seed for the click-point PRNG. A fixed seed makes a recorded frame produce
 * byte-identical taps, which is what lets the "uniform random point inside the
 * match rectangle" rule be asserted in a unit test. The platform layer may
 * override am_engine::rng after init to get a per-run sequence. */
#define AM_ENGINE_RNG_SEED 0x2545F491u

/* am_engine::last_error */
#define AM_ENGINE_OK            0
#define AM_ENGINE_ERR_ARG     (-1)
#define AM_ENGINE_ERR_MEMORY  (-2)
#define AM_ENGINE_ERR_CAPTURE (-3)
#define AM_ENGINE_ERR_TOUCH   (-4)

typedef struct {
    am_script      *script;         /* borrowed; must outlive the engine */
    am_engine_host  host;

    int   width, height;            /* frame size the host will produce */
    int   frame;                    /* = c.f1140w, the frame counter */

    int   current_scene;            /* -1 = none */
    int   running;                  /* 0 after a stop action, 1 while running */
    int   started;

    /* xorshift32 state. Android seeds java.util.Random from the clock; a fixed
     * seed makes a recorded screenshot produce byte-identical taps, which is
     * what lets the click-point rule be asserted in a unit test. */
    unsigned int rng;

    int   unsupported;              /* count of conditions whose leaf type this
                                     * port cannot evaluate (colour/text/node);
                                     * see am_engine_check_supported() */

    /* Scene gate state (scene_event). gates[i] == 0 means "scene i has no gate",
     * which is always active. */
    struct {
        int       active;           /* last computed activity of the gate */
        long long since_ms;         /* when it became active; 0 = never */
    } gates[AM_MAX_SCENES];

    /* Per-event condition timeout state, indexed [scene][event]. Android keeps
     * this on the condition objects themselves (i.h.f7999c/f8000d); the scripts
     * only ever use one condition object per event, and events are stateful
     * across frames, so we key it the same way. */
    struct {
        long long entered_ms;       /* 0 = not yet satisfied */
        long long held_ms;
    } *timeouts;                    /* scene_count * event_count entries, heap */

    /* Tap log (ring is unnecessary: it is capped and reused). */
    am_tap_record taps[AM_MAX_TAPS];
    int           tap_count;

    /* Scratch: the current frame, so the caller does not have to own a buffer. */
    unsigned char *frame_buf;
    size_t         frame_cap;

    /* Per-frame match cache. Keyed by (rect, group), valid only for one frame.
     * This is what keeps a scene with several image conditions affordable: the
     * same template in the same search rect is matched once per frame, exactly
     * like the HashMap in cn/autoeditor/framework/base/c.g(). */
    struct {
        int  frame;                 /* frame the entry was computed on, -1 = empty */
        int  group;                 /* template group index */
        am_rect rect;               /* search rect, in current-screen pixels */
        am_match_result res;        /* res.found == 0 means "template did not fit" */
    } *cache;
    int cache_count;

    /* Per-scene cursor: index of the event that ended the previous round, or -1.
     * Mirrors b.f999a. A round never revisits an event at or before this index,
     * which is how Android avoids firing two events of the same scene in one
     * frame even when both conditions hold. */
    int *cursor;                    /* scene_count entries, heap */

    int  last_error;                /* 0 = ok; see am_engine_error_name */
    char error[256];
} am_engine;

/* ---------- lifetime ---------- */

/*
 * Bind an engine to a script and a host. `width`/`height` is the frame size the
 * host will capture (the current screen). The host struct is copied.
 * Returns 0 on success, -1 on allocation failure. The script must already have
 * had am_script_set_screen() called with the same size.
 */
int  am_engine_init(am_engine *e, am_script *s, const am_engine_host *host,
                    int width, int height);

/* Release the engine's own allocations. Does not touch the script. */
void am_engine_free(am_engine *e);

/* Reset to the "just started" state: scene cursor, gates, timeouts, tap log. */
void am_engine_reset(am_engine *e);

/* ---------- driving ---------- */

/*
 * Grab a frame into the engine's own buffer. am_engine_step() calls this itself,
 * so a normal driver never needs it -- but am_engine_scene_active() and
 * am_engine_eval_event() read the frame, and with no frame captured they have
 * nothing to match against and report "no condition holds". Anything that wants
 * to inspect conditions BEFORE the first round (a preview in the UI, or a test
 * that checks the condition fold without firing the scene's actions) must call
 * this first. Returns 1 on success, 0 if the host cannot produce a frame.
 */
int am_engine_capture(am_engine *e);

/*
 * Advance the script by one round: capture, pick a scene, run its event loop,
 * then sleep by loop_interval.
 * Returns 1 if the script is still running, 0 if it stopped (a stop action ran,
 * or the host kept failing to capture), -1 on a programming error (not
 * initialised).
 */
int am_engine_step(am_engine *e);

/* Run up to `max_rounds` rounds, stopping early when the script stops or the
 * host cannot produce a frame. Returns the number of rounds actually run. */
int am_engine_run(am_engine *e, int max_rounds);

/* Stop the script (equivalent to a stop action: the next step returns 0). */
void am_engine_stop(am_engine *e);

/* ---------- inspection (for tests and on-device diagnosis) ---------- */

const am_tap_record *am_engine_taps(const am_engine *e, int *out_count);
void am_engine_clear_taps(am_engine *e);

const char *am_engine_error_name(int code);
const char *am_engine_last_error(const am_engine *e);

/* ---------- individual steps, exported for testing ---------- */

/*
 * Evaluate one event's conditions. `instant` selects Android's z flag: z=true
 * (used for scene gates) refreshes timeout bookkeeping but ignores timeouts when
 * deciding, so the caller sees the raw condition result. z=false (the normal
 * path) is the one that applies `timeout` seconds.
 *
 * `scene`/`event` index am_engine::timeouts. Returns 1 for "holds", 0 for "does
 * not hold".
 */
int am_engine_eval_event(am_engine *e, int scene, int event, int instant);

/* Evaluate the scene gate of `scene`. A scene with no gate is always active. */
int am_engine_scene_active(am_engine *e, int scene);

/* Search rect for an image/reference action, in current-screen pixels.
 * Mirrors cn/autoeditor/framework/base/c.e(): the search variable's crop rect
 * when there is one, otherwise the template rect grown by expand_size.
 * Returns 0 on success, -1 when the template has no usable rect. */
int am_engine_search_rect(am_engine *e, am_template_group *g, am_var *search,
                          am_rect *out);

/* Match `g` inside `search`, with the one-frame cache. Always returns a result;
 * check res.found and res.peak. */
void am_engine_match(am_engine *e, am_template_group *g, am_rect search,
                     am_match_result *out);

/* Invalidate the match cache. Called automatically when the frame counter
 * changes, and exported for tests. */
void am_engine_invalidate_cache(am_engine *e);

/* Uniform random in [0, n) from the engine's own PRNG (n <= 0 yields 0).
 * Exported so tests can pin the sequence. */
unsigned int am_engine_rand_below(am_engine *e, unsigned int n);

/*
 * Count the conditions this port cannot evaluate (colour, label, node, text)
 * into e->unsupported and return the total. A script whose conditions all fall
 * into that set would run blind, so the platform layer refuses to start unless
 * the user explicitly accepts it. Returns 0 when everything is evaluable.
 */
int am_engine_check_supported(am_engine *e);

#ifdef __cplusplus
}
#endif

#endif /* AUTO_ENGINE_H */
