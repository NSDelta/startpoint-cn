/* auto_script.h —— `.auto` 脚本的模型层（纯 C99，零平台依赖）
 *
 * `.auto` 是 Android App「自动化编辑器」v4.3.8（cn.autoeditor）导出的工程文件：
 * 一个 ZIP，含 `version` / `script_version` / `script.json` / `image/<ms>.png`
 * （模板裁图）/ `ori/<ms>.png`（整屏截图）。本文件把 script.json 解析成
 * 定长上限的结构体数组，并提供「录制分辨率 → 当前屏幕分辨率」的适配计算。
 *
 * 三层分工：
 *   auto_script.[ch]  模型：解析 JSON / 读 .auto 归档 / 适配坐标
 *   auto_match.[ch]   算法：模板匹配（FFT 版 NCC）
 *   auto_engine.[ch]  执行：每帧状态机、条件求值、点击点抽取
 *
 * ★ 生命周期：`am_script` 必须【堆分配】（calloc(1, sizeof(am_script))）。
 *   它内联了 groups[128] / vars[128] / scenes[256]，实测 sizeof ≈ 350 KB。
 *   放在栈上会立刻 0xC00000FD（STATUS_STACK_OVERFLOW），且 printf 一行都不出。
 *   本文件末尾的 AM_STATIC_ASSERT 会在有人把某个 AM_MAX_* 上限抬得太高时
 *   编译期报错 —— 别删它，它是唯一挡住 457 MB 版本复辟的东西。
 *
 * ★ 线程安全：加载完成后整体只读，唯一的例外是 am_script_template() 会填
 *   惰性缓存（每组的 template cache 与 s->cache_gen）。⇒ **同一个 am_script
 *   不可并发访问**；一个引擎一个实例。
 *
 * 与 Android 的差异（刻意的，逐条都写了理由）：
 *   1. am_adapt_rect 用【单一均匀系数】，不复制 Android 的双系数规则。见该
 *      函数注释里的理由与回归哨兵。
 *   2. am_variant_distance 只比 density（= Android getAdapterInfo 的默认分支），
 *      边距仅作 density 完全并列时的 tie-break。
 */
#ifndef AUTO_SCRIPT_H
#define AUTO_SCRIPT_H

#include <stddef.h>

#include "am_container.h"   /* am_auto (ZIP) 与 am_png_* */
#include "am_json.h"
#include "auto_match.h"     /* am_mat —— 全工程只在这里定义一次 */

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ *
 * 上限
 *
 * 全部按「样本实测用量 + 一个数量级余量」定，超限不静默丢弃而是计数
 * （见 am_script_overflowed）。样本实测：11 个模板组（最多 3 个变体）、
 * 9 个变量（各 1 个 crop）、10 个场景（各 1 个事件）、每事件最多 2 个条件、
 * 每事件恒 1 个动作。
 * ------------------------------------------------------------------ */
#define AM_MAX_TEMPLATE_GROUPS 128
#define AM_MAX_VARIANTS          8
#define AM_MAX_VARS            128
#define AM_MAX_CROPS             8
#define AM_MAX_SCENES          256
#define AM_MAX_EVENTS           16
#define AM_MAX_ITEMS            32
#define AM_MAX_ACTIONS          16

#define AM_MAX_TEXT             64   /* 变量值 / 条件比较值 */
#define AM_MAX_NAME             64   /* 组名、场景名（UTF-8，中文按字节算） */
#define AM_MAX_ID               32   /* id 是 16 字符的 base64-ish 串 */

/* ------------------------------------------------------------------ *
 * 基本几何
 * ------------------------------------------------------------------ */

typedef struct {
    int x, y, w, h;
} am_rect;

/* 8 位灰度位图（am_mat）与「无拥有权视图」（am_gray）都定义在 auto_match.h，
 * 这里直接复用 —— 曾经两边各定义一次 am_mat，结果是 `error C2371: 'am_mat':
 * redefinition; different basic types`（凡是同时 include 两个头的 .c 都中招）。 */

/* 屏幕描述：width/height 是【原样】的，long_edge/short_edge 是派生量。
 * 为什么两套都要：JSON 里录制的 screen_info 是原样的（editor/a.java 直接
 * optInt("width")），而 Android 的当前屏幕是归一化的（EditorScript
 * updateScreenInfo() 里 f866a 恒为长边、f867b 恒为短边）。适配计算只读
 * long_edge/short_edge，所以两种来源都能喂进来。 */
typedef struct {
    int width, height;
    int density;
    int long_edge;              /* max(width, height)，clamp 到 >= 1 */
    int short_edge;             /* min(width, height)，clamp 到 >= 1 */
} am_screen;

/* 录制端记录的一台设备的屏幕，对应 JSON 的 screen_info 对象。 */
typedef struct {
    int width, height;
    int density;
    int pixel_stride;           /* JSON "pixelStride"，缺省 4 */
    int row_padding;            /* JSON "rowPadding"，缺省 0 */
} am_screen_info;

/* ------------------------------------------------------------------ *
 * 条件与动作
 * ------------------------------------------------------------------ */

/* 条件叶子类型。编号与 Android 一致：图像条件是 1、变量条件是 2、条件组是 5
 * （样本里 item_group.type == 5）。让编号跟 Android 对齐是因为 JSON 里的
 * "type" 是裸整数，直接赋给枚举 —— 编号一旦不一致就会把类型映射歪。 */
typedef enum {
    AM_COND_IMAGE = 1,
    AM_COND_VAR   = 2,
    AM_COND_GROUP = 5
} am_cond_type;

/* 动作类型。编号逐条对应 Android `h` 包下的类（h.f.java 是 type=2 的图像
 * 动作），见 auto_script.c 的 action_next_mode() 注释。只有 AM_ACT_IMAGE
 * 与 AM_ACT_TAP 被执行引擎实现，其余保留编号以便如实报告"这个脚本用到了
 * 本移植版不支持的动作"。 */
typedef enum {
    AM_ACT_UNKNOWN       = 0,
    AM_ACT_TAP           = 1,    /* h.v  —— 点击坐标（可引用变量） */
    AM_ACT_IMAGE         = 2,    /* h.f  —— 找到模板后点击 */
    AM_ACT_VARIABLE      = 3,    /* h.m  —— 修改变量 */
    AM_ACT_SCREEN_VALUE  = 4,    /* h.s  */
    AM_ACT_IMAGE_COORD   = 5,    /* h.g  */
    AM_ACT_INPUT         = 6,    /* h.h  */
    AM_ACT_SLIDE         = 7,    /* h.t  */
    AM_ACT_ZOOM          = 8,    /* h.z  */
    AM_ACT_RESET         = 9,    /* h.r  */
    AM_ACT_FINISH        = 10,   /* h.d  —— 停止脚本 */
    AM_ACT_SYSTEM_KEY    = 11,   /* h.u  */
    AM_ACT_JS            = 12,   /* h.i  */
    AM_ACT_DELAY         = 14,   /* h.c  */
    AM_ACT_CLICK_TEXT    = 15,   /* h.w  */
    AM_ACT_APP           = 16,   /* h.a  */
    AM_ACT_LABEL         = 18,   /* h.k  */
    AM_ACT_LABEL_COORD   = 19,   /* h.l  */
    AM_ACT_PLUGIN        = 20,   /* h.q  */
    AM_ACT_CLICK_COLOR   = 21,   /* h.b  */
    AM_ACT_GESTURE       = 22,   /* h.e  */
    AM_ACT_NODE_TEXT     = 23,   /* h.p  */
    AM_ACT_NODE          = 24,   /* h.n  */
    AM_ACT_NODE_COORD    = 25,   /* h.o  */
    AM_ACT_COLOR_COORD   = 27,   /* h.x  */
    AM_ACT_TEXT_COORD    = 28,   /* h.y  */
    AM_ACT_UPDATE_IMAGE  = 29,   /* h.j  */
    AM_ACT_JS_PLUGIN     = 30
} am_action_type;

/* 动作执行完之后的走法。这不是"跳到哪一条动作"，而是 Android
 * EditorEvent.breakable() 的编码：任一动作实现了标记接口
 * cn.autoeditor.editor.action.a，breakable() 就为真，运行期随即跳出事件扫描
 * （framework/b.java:100-132）—— 净效果是"下一个 tick 从场景头重新扫"。 */
typedef enum {
    AM_NEXT_CONTINUE = 0,       /* 继续跑同一个事件的下一个动作 */
    AM_NEXT_RESTART  = 1,       /* breakable：本轮到此为止 */
    AM_NEXT_STOP     = 2        /* 停止整个脚本（AM_ACT_FINISH） */
} am_next_mode;

/* 一个条件叶子。timeout / reset_timeout 挂在【叶子】上（Android i.h 的字段），
 * 组级超时约定取第一个叶子的值（见 auto_engine.c 的 am_engine_eval_event）。 */
typedef struct {
    int  type;                  /* am_cond_type */
    int  relation;              /* 1 = AND，2 = OR（其余按 AND 处理） */
    int  state;                 /* 期望状态，缺省 1 */
    int  item_state;            /* 运行期状态回填，缺省 -1 */
    int  timeout;               /* 秒；"连续成立超过这么久"才算成立 */
    int  reset_timeout;         /* 成立一次就重新计时（脉冲式） */
    char image_id[AM_MAX_ID];   /* 模板组 */
    char search_id[AM_MAX_ID];  /* 搜索范围变量 */
    char deviation_id[AM_MAX_ID];/* 偏差变量（点击点抖动范围） */
    char var_id[AM_MAX_ID];     /* JSON "variable_id"（回退键 "var_id"） */
    char value[AM_MAX_TEXT];    /* 变量比较值 */
} am_cond;

/* 一个动作。postpone 是【动作之后】的延迟秒数 —— Android h.f.a() 的返回值
 * 交给 framework/a.b() 的 Thread.sleep((int)(r*1000))，所以落在动作之后。 */
typedef struct {
    int    type;                /* am_action_type */
    int    raw_type;            /* JSON 里原始的 type，用于如实报告未知类型 */
    double postpone;            /* 动作之后的延迟，秒 */
    double press_time;          /* 按住时长，秒；<=0 时用随机 20..49 ms */
    double interval;            /* 重复点击之间的间隔，秒 */
    int    click_times;         /* 点击次数，至少 1 */
    int    button;              /* 鼠标键（Android 语义，iOS 侧忽略） */
    char   image_id[AM_MAX_ID];
    char   search_id[AM_MAX_ID];
    char   deviation_id[AM_MAX_ID];
    int    next_mode;           /* am_next_mode */
} am_action;

/* 一个事件 = 一组条件（items）+ 一组动作。items/actions 是【内联数组】：
 * 引擎按 &ev->items[i] 取址，且事件本身是堆分配的（见 am_scene.events）。 */
typedef struct {
    int        id;              /* 事件在场景内的下标；场景门用 -1 */
    int        relation;        /* 条件组的关系 */
    int        breakable;       /* 任一动作的 next_mode == AM_NEXT_RESTART */
    int        item_count;
    am_cond    items[AM_MAX_ITEMS];
    int        action_count;
    am_action  actions[AM_MAX_ACTIONS];
} am_event;

/* ------------------------------------------------------------------ *
 * 模板与变量
 * ------------------------------------------------------------------ */

/* 一个模板变体 = 一张模板图 + 它在录制屏上的位置。
 * ★ 实测不变量：rect.w x rect.h 恰好等于该变体 PNG 的像素尺寸。所以"不缩放"
 *   的意思是"渲染出的尺寸 == rect.w x rect.h"，不是"== 录制屏幕尺寸"。 */
typedef struct {
    char           file[AM_MAX_NAME];   /* ZIP 内名字，形如 "image/1789.png" */
    char           ori[AM_MAX_NAME];    /* 对应的整屏截图（仅诊断用） */
    am_rect        rect;                /* 模板在录制屏上的位置与尺寸 */
    am_screen_info screen;              /* 该变体录制的屏幕 */
    int            type;                /* 缺省 1 */
    double         threshold;           /* 缺省 0（不是百分比，是 OpenCV 阈值） */
    int            filter_color;        /* 缺省 0 */
    double         filter_sim;          /* 缺省 0 */
} am_template_variant;

/* 一个模板组（编辑器里的一个"图片"）—— 同一张图在不同设备上的多个变体。 */
typedef struct {
    char                name[AM_MAX_NAME];
    char                id[AM_MAX_ID];
    int                 adapter_type;   /* -1 = 缺省（用脚本头的 adapter） */
    double              sim;            /* 匹配阈值，缺省 0.8；越界则回落 0.8 */
    int                 variant_count;
    am_template_variant variants[AM_MAX_VARIANTS];
} am_template_group;

/* 一个搜索范围裁图（变量里的 crops[0] 就是"在哪找"）。 */
typedef struct {
    am_rect        rect;
    int            orientation;         /* 缺省 2（竖屏） */
    char           ori[AM_MAX_NAME];
    am_screen_info screen;
} am_crop;

/* 一个变量。type 决定 value 是坐标/字符串/数字，本移植版只用到 crops。 */
typedef struct {
    char    id[AM_MAX_ID];
    char    name[AM_MAX_NAME];
    char    value[AM_MAX_TEXT];
    int     type;
    int     crop_count;
    am_crop crops[AM_MAX_CROPS];
} am_var;

/* ------------------------------------------------------------------ *
 * 场景与脚本
 * ------------------------------------------------------------------ */

/* 一个场景。
 * ★ events 与 gate 都是【指针 + 拥有所有权】：am_event 实测 11792 字节，
 *   内联 256 份会白扔 3 MB（这正是当初 sizeof(am_script) == 457 MB 的原因）。
 *   解析时按 JSON 里声明的数量 calloc。【没有 has_scene_event 字段】——
 *   有没有门就看 gate 是否为 NULL。 */
typedef struct {
    char       name[AM_MAX_NAME];
    char       id[AM_MAX_ID];
    int        disabled;
    int        event_count;
    am_event  *events;          /* event_count 个，拥有所有权；可为 NULL */
    am_event  *gate;            /* scene_event，NULL = 无门，拥有所有权 */
} am_scene;

typedef struct {
    char   name[AM_MAX_NAME];
    char   id[AM_MAX_ID];
    char   init[AM_MAX_NAME];   /* 初始化事件名（字符串，可能为空） */
    int    loop_mode;           /* 缺省 1 */
    int    expand_size;         /* 缺省 0；【-1 = 搜索全帧的哨兵值】 */
    int    adapter;             /* 缺省 1 */
    int    task_mode;           /* 缺省 0 */
    int    input_type;          /* 缺省 1 */
    int    capture_direction;   /* 缺省 -1；序列化了但从不在运行期读 */
    double loop_interval;       /* ★ 模型里是【秒】；JSON 里是毫秒，加载时 /1000 */
} am_script_header;

/* 归档读取回调。`name` 形如 "script.json" / "image/1789.png"；read 负责
 * malloc 出 *out_data 并把大小写进 *out_size，成功返回 0。
 * release 为 NULL 时调用方用 free()。 */
typedef struct {
    void *ctx;
    int  (*read)(void *ctx, const char *name, void **out_data, size_t *out_size);
    void (*release)(void *ctx, void *data);
} am_script_io;

/* 惰性模板缓存项：一组一格，key 是组的下标。 */
typedef struct {
    am_mat mat;
    int    variant;             /* 选中的变体下标 */
    int    gen;                 /* 生成号；!= cache_gen 即失效 */
    int    valid;
} am_template_cache;

typedef struct {
    am_script_header header;
    am_script_io     io;

    /* 当前屏幕。必须在 load_json / load_auto 之前或之后用
     * am_script_set_screen 设好（set 会让全体模板缓存失效）。 */
    am_screen        screen;

    int                template_group_count;
    am_template_group  groups[AM_MAX_TEMPLATE_GROUPS];

    int     var_count;
    am_var  vars[AM_MAX_VARS];

    int      scene_count;
    am_scene scenes[AM_MAX_SCENES];

    /* 模板缓存的代际号。am_script_init 置 1；am_script_set_screen 自增。 */
    int                 cache_gen;
    am_template_cache  *cache;  /* template_group_count 个，堆分配 */

    /* 解析失败原因。am_engine_last_error 之外，脚本自己的错误也放这里。 */
    char error[256];
    int  error_fatal;           /* 1 = 模型不可用（内存不足等），别再往里喂 */

    /* 超限计数。任何一项非零都说明脚本被截断过 —— 平台层据此警告用户。 */
    int overflow_groups;
    int overflow_variants;
    int overflow_vars;
    int overflow_crops;
    int overflow_scenes;
    int overflow_events;
    int overflow_items;
    int overflow_actions;
    int unsupported_groups;     /* 嵌套条件组：被拍平或跳过 */

    /* 直接读 .auto 时，ZIP 与它的上下文由脚本持有（模板是惰性解压的，所以
     * ZIP 必须活到 am_script_free）。 */
    struct am_auto *zip;
    void           *zip_ctx;
} am_script;

/* 尺寸预算：350 KB 左右是正常值。谁把上限抬到 MB 级会在这里编译期失败。 */
#define AM_SCRIPT_MAX_BYTES (8u * 1024u * 1024u)

#if defined(__cplusplus)
#define AM_STATIC_ASSERT(cond, msg) static_assert(cond, msg)
#else
#define AM_STATIC_ASSERT(cond, msg) _Static_assert(cond, msg)
#endif

AM_STATIC_ASSERT(sizeof(am_script) <= AM_SCRIPT_MAX_BYTES,
                 "am_script exceeds its size budget: lower an AM_MAX_* ceiling");

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/* 解析 "x,y,w,h"（容忍空格与正负号）。必须恰好 4 个数，否则返回 -1。
 * ★ `am_script` 是 350 KB 的结构，所有 API 都走指针，别传值。 */

int    am_parse_rect(const char *text, am_rect *out);
double am_parse_double(const char *text, double def);
int    am_parse_int(const char *text, int def);

/* 填好 long_edge/short_edge（clamp 到 >= 1，防后面除零）。 */
void am_screen_make(am_screen *out, int width, int height, int density);

/* 1 = 横屏，2 = 竖屏。因为 Android 的当前屏幕 f866a 恒为长边，比较
 * width/height 等价于比较长/短边。 */
int  am_screen_orientation(const am_screen_info *si);

/* ------------------------------------------------------------------ *
 * 坐标适配
 * ------------------------------------------------------------------ */

/* 录制屏 → 当前屏的缩放系数。★ 本移植版保证 out_dx == out_dy（单一均匀
 * 系数），见 am_adapt_rect 的注释。
 * 两者都非 NULL；out_dy 可为 NULL（表示调用方只关心一个）。 */
void am_adapt_factors(const am_screen *cur, const am_screen_info *rec,
                      double *out_dx, double *out_dy);

/* 把一个录制期的矩形映射到当前屏幕。
 *
 * ★ 有意与 Android 不同：Android EditorCrop.getAdapterValue() 在竖屏当前帧下
 *   是 dx = 当前长边/录制短边、dy = 当前短边/录制短边（同一分母、不同分子
 *   ⇒ 非均匀，1080x1920 播 1200x2000 的录制会横向拉伸 78%）。Android 只在
 *   录制机型上跑所以看不出来，但 iOS 要面向任意机型，非均匀会把"crop 必须
 *   容得下模板"这个不变量破坏掉（搜索区永远装不下模板 ⇒ 场景静默不触发）。
 *   因此这里改用单一均匀系数：竖屏 f = 当前短边/录制短边，横屏
 *   f = 当前长边/录制长边 —— 这也正是 Android 对模板【像素】的算法
 *   （framework/base/c.java 的 new Size(w*f8, h*f8)）。
 *   回归哨兵：若某天看到 x=278,w=857（1080x1920 播 1200x2000），说明有人把
 *   Android 的双系数规则搬回来了。
 * 用 lround 而非截断，且强制 w,h >= 1 —— Android 的整数除法会让小屏上的
 * rect 塌成 0 面积，从而静默跳过整个场景。 */
am_rect am_adapt_rect(const am_screen *cur, const am_screen_info *rec, am_rect r);

/* 变体打分：|Δdensity|。Android EditorImage.getAdapterInfo() 的默认分支就是
 * Math.abs(variant.density - current.density)，【没有边距项】；本函数保持
 * 一致。density 完全并列时由选择逻辑用边距做 tie-break。 */
long am_variant_distance(const am_screen *cur, const am_screen_info *v);

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/* 绑定 io 回调并清零模型。★ s 必须是堆分配的（见文件头）。
 * io 可为 NULL（表示随后用 am_script_load_json 直接喂文本）。 */
void am_script_init(am_script *s, const am_script_io *io);

/* 释放脚本持有的一切：模板缓存、逐场景的 events/gate，以及 .auto 的 ZIP。 */
void am_script_free(am_script *s);

/* 设置当前屏幕并让全体模板缓存失效（cache_gen++）。 */
void am_script_set_screen(am_script *s, const am_screen *screen);

/* 解析 script.json 文本。成功返回 0；失败返回 -1 并把原因写进 s->error。
 * screen 非 NULL 时等价于先调一次 am_script_set_screen。 */
int am_script_load_json(am_script *s, const char *json, size_t len,
                        const am_screen *screen);

/* 打开 .auto 归档（ZIP）并解析其中的 script.json。ZIP 会保持打开（模板惰性
 * 解压），所有权交给脚本，am_script_free 负责关闭。 */
int am_script_load_auto(am_script *s, const char *auto_path,
                        const am_screen *screen);

/* 任何一项 overflow_* 非零即为真 —— 说明脚本被上限截断过。 */
int am_script_overflowed(const am_script *s);

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/* 按名字【或】id 查模板组；找不到返回 NULL。 */
am_template_group *am_script_find_group(am_script *s, const char *name_or_id);

/* 按 id 查变量；找不到返回 NULL。 */
am_var *am_script_find_var(am_script *s, const char *id);

/* 模板组在当前屏幕上的位置与尺寸（已按 am_adapt_rect 适配）。
 * 组不存在 / 无变体时返回零矩形。 */
am_rect am_script_group_rect(am_script *s, const am_template_group *g);

/* 第 index 个 crop 在当前屏幕上的位置（已适配）。越界或指针为 NULL 返回零矩形。 */
am_rect am_script_crop_rect(am_script *s, const am_var *v, int index);

/* 模板 rect 按 header.expand_size 四边各外扩。expand_size == 0 时恒等返回；
 * expand_size == -1 是"搜索全帧"的哨兵，由【调用方】（auto_engine）处理。 */
am_rect am_script_search_rect_from_template(am_script *s, am_rect tpl_rect);

/* 取出该组在当前屏幕下应使用的模板位图（已缩放）。惰性构造并缓存，
 * 失败返回 NULL。★ 返回值归脚本所有，调用方不得 free；下一次
 * am_script_set_screen 会使其失效。 */
const am_mat *am_script_template(am_script *s, am_template_group *g);

/* 动作类型的中文/英文名（用于诊断输出）。未知类型返回 "Unknown"。 */
const char *am_action_type_name(int type);

#ifdef __cplusplus
}
#endif

#endif /* AUTO_SCRIPT_H */
