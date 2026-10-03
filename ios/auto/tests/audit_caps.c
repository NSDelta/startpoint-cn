/*
 * audit_caps.c -- 把 sample.auto 灌进引擎，量出它在**每一个编译期上限**上实际用了多少。
 *
 * 为什么要单独一个工具：core/auto_script.h 里的 AM_MAX_* 是当初按最坏情况估的，
 * 估错了有两种后果，而且都不出声：
 *   · 估小了 ⇒ am_script_load_auto 把多出来的组/变体/事件**静默丢掉**
 *     （只置 s->overflow_* 计数，脚本照样"加载成功"）⇒ 现场表现是"有些按钮不点"，
 *     而日志里什么都看不出来；
 *   · 估大了 ⇒ sizeof(am_script) 变大（现在 350 KB），但这个已经在
 *     AM_SCRIPT_MAX_BYTES 的静态断言里守住了，不构成风险。
 * 所以这里只查"够不够用"，并把 headroom 打出来，供以后换脚本时对照。
 *
 * 用法：audit_caps.exe <脚本所在目录或 .auto 文件>
 *   audit_caps.exe matcher_golden_pkg/pkg     （目录夹具，走 am_script_load_json）
 *   audit_caps.exe matcher_golden_pkg         （真 .auto，走 am_script_load_auto）
 *
 * 退出码：0 = 无溢出（所有 overflow_* 计数为 0 且没有任何组被判 unsupported）
 *         1 = 有溢出，逐项打印哪一维爆了
 *         2 = 加载失败
 */
#include "auto_script.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_bad = 0;

/* 每一项都打印 used/limit 与余量百分比；余量低于 25% 时标注。 */
static void row(const char *what, long used, long limit)
{
    const long slack = limit - used;
    const char *flag = "";
    if (used > limit)      { flag = "  <<< 溢出"; g_bad = 1; }
    else if (slack * 4 < limit) { flag = "  <<< 余量不足 25%"; }
    printf("  %-28s %6ld / %-6ld  余 %5ld  (%s)%s\n",
           what, used, limit, slack, limit > 0 ? "上限" : "无上限", flag);
}

/* 目录夹具与真 .auto 都支持的读取器：和 test_script.c 里 dir_read 同一套语义，
   但这里只用于目录形态。 */
typedef struct { char dir[512]; } dir_ctx;

static int dir_read(void *ctx, const char *name, void **out_data, size_t *out_size)
{
    dir_ctx *c = (dir_ctx *)ctx;
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s", c->dir, name);

    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    long n = ftell(f);
    if (n < 0) { fclose(f); return -1; }
    rewind(f);
    unsigned char *p = (unsigned char *)malloc((size_t)n);
    if (!p) { fclose(f); return -1; }
    if (n > 0 && fread(p, 1u, (size_t)n, f) != (size_t)n) { free(p); fclose(f); return -1; }
    fclose(f);
    *out_data = p;
    *out_size = (size_t)n;
    return 0;
}

static void dir_release(void *ctx, void *data) { (void)ctx; free(data); }

int main(int argc, char **argv)
{
    if (argc < 2) {
        printf("用法：audit_caps <脚本目录|.auto 文件>\n");
        return 2;
    }
    setvbuf(stdout, NULL, _IONBF, 0);

    const char *in = argv[1];
    char script_json[1024];
    snprintf(script_json, sizeof(script_json), "%s/script.json", in);
    FILE *probe = fopen(script_json, "rb");

    am_script *s = (am_script *)calloc(1u, sizeof(am_script));
    if (!s) { printf("calloc 失败\n"); return 2; }
    printf("sizeof(am_script) = %zu 字节（上限 %u）\n", sizeof(am_script), (unsigned)AM_SCRIPT_MAX_BYTES);

    dir_ctx dc;
    int rc;
    if (probe) {
        fclose(probe);
        memset(&dc, 0, sizeof(dc));
        snprintf(dc.dir, sizeof(dc.dir), "%s", in);
        am_script_io io;
        memset(&io, 0, sizeof(io));
        io.ctx = &dc;
        io.read = dir_read;
        io.release = dir_release;
        printf("形态：目录夹具  %s/script.json\n", in);

        /* am_script_load_json 收的是【文本】而不是路径 —— 目录形态要先自己读进来
           （am_script_load_auto 才是收路径、并靠 io 回调惰性读图片的那个）。 */
        void *json = NULL;
        size_t json_len = 0;
        if (dir_read(&dc, "script.json", &json, &json_len) != 0) {
            printf("读不到 %s/script.json\n", in);
            free(s);
            return 2;
        }
        am_script_init(s, &io);
        rc = am_script_load_json(s, (const char *)json, json_len, NULL);
        io.release(&dc, json);
    } else {
        printf("形态：.auto 压缩包  %s\n", in);
        am_script_init(s, NULL);
        rc = am_script_load_auto(s, in, NULL);
    }

    if (rc != 0) {
        printf("加载失败：error='%s' error_fatal=%d\n", s->error, s->error_fatal);
        am_script_free(s);
        free(s);
        return 2;
    }
    printf("加载成功：header.name='%s' header.id='%s'\n", s->header.name, s->header.id);

    /* ── 实际用量 ─────────────────────────────────────────────── */
    long max_act = 0, max_item = 0, max_crop = 0;
    long max_ev = 0, max_variants = 0;

    for (int i = 0; i < s->scene_count; i++) {
        const am_scene *sc = &s->scenes[i];
        if (sc->event_count > max_ev) max_ev = sc->event_count;
        for (int e = 0; e < sc->event_count; e++) {
            const am_event *ev = &sc->events[e];
            if (ev->item_count   > max_item) max_item = ev->item_count;
            if (ev->action_count > max_act)  max_act  = ev->action_count;
        }
    }
    for (int i = 0; i < s->var_count; i++)
        if (s->vars[i].crop_count > max_crop) max_crop = s->vars[i].crop_count;
    for (int i = 0; i < s->template_group_count; i++)
        if (s->groups[i].variant_count > max_variants) max_variants = s->groups[i].variant_count;

    /* ★ AM_MAX_EVENTS / AM_MAX_ITEMS / ... 都是【单容器】的容量，所以这里比的
       必须是"最大的那一个容器"，不是总数。（拿总数去比会得出"上限不够用"的
       假结论 —— 11 个模板组和 AM_MAX_TEMPLATE_GROUPS=128 才是同一维的东西。） */
    printf("\n实际用量 vs 编译期上限：\n");
    row("模板组 template_group", s->template_group_count, AM_MAX_TEMPLATE_GROUPS);
    row("变量 var",              s->var_count,             AM_MAX_VARS);
    row("场景 scene",            s->scene_count,           AM_MAX_SCENES);
    row("单场景最大事件 event",  max_ev,                   AM_MAX_EVENTS);
    row("单事件最大条件 item",   max_item,                 AM_MAX_ITEMS);
    row("单事件最大动作 action", max_act,                  AM_MAX_ACTIONS);
    row("单变量最大裁切 crop",   max_crop,                 AM_MAX_CROPS);
    row("单组最大变体 variant",  max_variants,             AM_MAX_VARIANTS);

    /* ── 溢出计数（静默丢弃的证据）───────────────────────────── */
    printf("\n溢出计数（非 0 就说明有东西被静默丢掉了）：\n");
    printf("  overflow_groups=%d overflow_variants=%d overflow_vars=%d overflow_crops=%d\n",
           s->overflow_groups, s->overflow_variants, s->overflow_vars, s->overflow_crops);
    printf("  overflow_scenes=%d overflow_events=%d overflow_items=%d overflow_actions=%d\n",
           s->overflow_scenes, s->overflow_events, s->overflow_items, s->overflow_actions);
    printf("  unsupported_groups=%d  error_fatal=%d\n",
           s->unsupported_groups, s->error_fatal);

    if (s->overflow_groups || s->overflow_variants || s->overflow_vars || s->overflow_crops ||
        s->overflow_scenes || s->overflow_events || s->overflow_items || s->overflow_actions ||
        s->unsupported_groups || s->error_fatal) {
        printf("\n溢出明细：\n");
        if (s->overflow_groups)   printf("  模板组超出 %d 个\n",  s->overflow_groups);
        if (s->overflow_variants) printf("  变体超出 %d 个\n",    s->overflow_variants);
        if (s->overflow_vars)     printf("  变量超出 %d 个\n",    s->overflow_vars);
        if (s->overflow_crops)    printf("  裁切超出 %d 个\n",    s->overflow_crops);
        if (s->overflow_scenes)   printf("  场景超出 %d 个\n",    s->overflow_scenes);
        if (s->overflow_events)   printf("  事件超出 %d 个\n",    s->overflow_events);
        if (s->overflow_items)    printf("  条件超出 %d 个\n",    s->overflow_items);
        if (s->overflow_actions)  printf("  动作超出 %d 个\n",    s->overflow_actions);
        if (s->unsupported_groups)printf("  不支持的模板组 %d 个（PNG 无法解码等）\n", s->unsupported_groups);
        if (s->error_fatal)       printf("  error_fatal 已置位\n");
        g_bad = 1;
    } else {
        printf("\n没有任何溢出 —— 这份脚本完整装进了引擎。\n");
    }

    am_script_free(s);
    free(s);
    return g_bad ? 1 : 0;
}
