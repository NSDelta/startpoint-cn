/* test_json.c —— am_json 的正确性验证
 *
 * 用法: test_json.exe <matcher_golden_pkg 目录>
 *
 * 第 1 部分：内联的窄用例（转义、代理对、嵌套、错误路径）
 * 第 2 部分：解析真实 script.json（19KB），与已知事实逐项核对
 *
 * 已知事实来自 Python 侧独立解析（tools/dump_sample.py / make_package_golden.py）：
 *   - 顶层 31 个键
 *   - image_list 11 组、images 变体共 23 个
 *   - var_list 9 个，每个 1 个 crop
 *   - default_scene 10 个场景，其中 8 个各有 1 条件 + 1 动作，2 个 disabled
 *   - name == "幻想连战"，id == "zf6IupVIdAcTt6st"，init == "i8YacrIuyf5VFqi1"
 */
#include "am_json.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int g_pass = 0;
static int g_fail = 0;

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

static void check_int(const char *what, long got, long want)
{
    if (got == want) { ok(what); return; }
    char d[160];
    snprintf(d, sizeof(d), "got %ld want %ld", got, want);
    bad(what, d);
}

static void check_str(const char *what, const char *got, const char *want)
{
    if (!got && !want) { ok(what); return; }
    if (got && want && strcmp(got, want) == 0) { ok(what); return; }
    char d[320];
    snprintf(d, sizeof(d), "got \"%s\" want \"%s\"", got ? got : "(null)", want ? want : "(null)");
    bad(what, d);
}

/* ---------- 第 1 部分：窄用例 ---------- */

static void test_scalars(void)
{
    puts("[1] scalars / escapes / nesting");

    {
        const char *s = "{\"a\":1,\"b\":-2.5e2,\"c\":true,\"d\":false,\"e\":null,\"f\":\"x\"}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse scalars", j.error); return; }
        check_int("  int", am_json_geti(j.root, "a", -1), 1);
        check_int("  exp number", (long)am_json_getn(j.root, "b", 0), -250);
        check_int("  true", am_json_getb(j.root, "c", 0), 1);
        check_int("  false", am_json_getb(j.root, "d", 1), 0);
        check_int("  null is null", am_json_is_null(am_json_get(j.root, "e")), 1);
        check_str("  string", am_json_gets(j.root, "f", NULL), "x");
        check_int("  missing -> default", am_json_geti(j.root, "zzz", 42), 42);
        check_int("  count", (long)am_json_count(j.root), 6);
        am_json_free(&j);
    }

    {
        /* \uXXXX、代理对、常见转义 */
        const char *s = "{\"cn\":\"\\u5e7b\\u60f3\",\"emoji\":\"\\ud83d\\ude00\","
                        "\"esc\":\"a\\tb\\nc\\\"d\\\\e\\/f\"}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse escapes", j.error); return; }
        check_str("  \\uXXXX => UTF-8", am_json_gets(j.root, "cn", NULL), "\xe5\xb9\xbb\xe6\x83\xb3");
        check_str("  surrogate pair => U+1F600", am_json_gets(j.root, "emoji", NULL),
                  "\xf0\x9f\x98\x80");
        check_str("  escapes", am_json_gets(j.root, "esc", NULL), "a\tb\nc\"d\\e/f");
        am_json_free(&j);
    }

    {
        /* 嵌套数组/对象 + 数组索引 */
        const char *s = "{\"arr\":[{\"n\":1},{\"n\":2},[10,20,{\"deep\":\"yes\"}]],"
                        "\"empty_a\":[],\"empty_o\":{}}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse nested", j.error); return; }
        am_json_value *arr = am_json_get(j.root, "arr");
        check_int("  array count", (long)am_json_count(arr), 3);
        check_int("  [1].n", am_json_geti(am_json_at(arr, 1), "n", 0), 2);
        am_json_value *inner = am_json_at(arr, 2);
        check_int("  [2][1]", am_json_int(am_json_at(inner, 1), 0), 20);
        check_str("  [2][2].deep", am_json_gets(am_json_at(inner, 2), "deep", NULL), "yes");
        check_int("  out of range -> NULL", am_json_at(arr, 99) == NULL, 1);
        check_int("  empty array count", (long)am_json_count(am_json_get(j.root, "empty_a")), 0);
        check_int("  empty object count", (long)am_json_count(am_json_get(j.root, "empty_o")), 0);
        am_json_free(&j);
    }

    {
        /* 键名重复时取第一个（与 Java JSONObject 的 put 语义不同，但 .auto 不会重复） */
        const char *s = "{\"k\":1,\"k\":2}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse dup key", j.error); return; }
        check_int("  dup key -> first", am_json_geti(j.root, "k", 0), 1);
        am_json_free(&j);
    }

    {
        /* 成员顺序保真 */
        const char *s = "{\"z\":1,\"a\":2,\"m\":3}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse order", j.error); return; }
        const char *want[3] = {"z", "a", "m"};
        int good = 1;
        int i = 0;
        for (am_json_value *m = j.root->first; m; m = m->next, i++) {
            if (i >= 3 || strcmp(m->key, want[i]) != 0) { good = 0; break; }
        }
        check_int("  member order preserved", good && i == 3, 1);
        am_json_free(&j);
    }

    {
        /* BOM */
        const char *s = "\xEF\xBB\xBF{\"a\":1}";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse BOM", j.error); return; }
        check_int("  UTF-8 BOM skipped", am_json_geti(j.root, "a", 0), 1);
        am_json_free(&j);
    }

    {
        /* 前后空白 */
        const char *s = "  \r\n\t [ 1 , 2 ]  \n ";
        am_json j;
        if (am_json_parse(&j, s, strlen(s)) != 0) { bad("parse ws", j.error); return; }
        check_int("  surrounding whitespace", (long)am_json_count(j.root), 2);
        am_json_free(&j);
    }
}

static void test_errors(void)
{
    puts("[2] error paths must be rejected (and must not crash)");

    struct { const char *text; const char *what; } cases[] = {
        { "",                             "empty input" },
        { "{",                            "unterminated object" },
        { "{\"a\"}",                      "missing colon" },
        { "{\"a\":1,}",                   "trailing comma" },
        { "[1,2",                         "unterminated array" },
        { "[1,2,]",                       "trailing comma in array" },
        { "\"abc",                        "unterminated string" },
        { "{\"a\":tru}",                  "bad literal" },
        { "{\"a\":01x}",                  "bad number tail" },
        { "{\"a\":\"\\q\"}",              "bad escape" },
        { "{\"a\":\"\\u00\"}",            "short \\u escape" },
        { "{} {}",                        "trailing garbage" },
        { "{'a':1}",                      "single quotes" },
        { "{\"a\":\"x\ty\"}",             "raw tab in string" },
    };
    const size_t n = sizeof(cases) / sizeof(cases[0]);
    for (size_t i = 0; i < n; i++) {
        am_json j;
        int rc = am_json_parse(&j, cases[i].text, strlen(cases[i].text));
        if (rc == 0) { bad(cases[i].what, "accepted invalid input"); am_json_free(&j); continue; }
        if (j.error[0] == '\0') { bad(cases[i].what, "rejected without a message"); am_json_free(&j); continue; }
        char label[128];
        snprintf(label, sizeof(label), "%s (rejected: %s)", cases[i].what, j.error);
        ok(label);
        am_json_free(&j);
    }

    /* truncation sweep：任意前缀都不得崩溃 */
    {
        const char *s = "{\"a\":[1,2,{\"b\":\"\\u5e7b\\u60f3\"}],\"c\":true,\"d\":null}";
        size_t len = strlen(s);
        int crashed = 0;
        for (size_t k = 0; k <= len; k++) {
            am_json j;
            (void)am_json_parse(&j, s, k);
            am_json_free(&j);
        }
        check_int("  truncation sweep (all prefixes)", crashed, 0);
    }

    /* 双重 free 安全 */
    {
        const char *s = "{\"a\":1}";
        am_json j;
        am_json_parse(&j, s, strlen(s));
        am_json_free(&j);
        am_json_free(&j);
        ok("  double free is safe");
    }
}

/* ---------- 第 2 部分：真实 script.json ---------- */

static char *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)n);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    if (got != (size_t)n) { free(buf); return NULL; }
    *out_len = got;
    return buf;
}

/* 找 id == want 的组 */
static am_json_value *find_image_group(am_json_value *list, const char *want)
{
    size_t n = am_json_count(list);
    for (size_t i = 0; i < n; i++) {
        am_json_value *g = am_json_at(list, i);
        const char *id = am_json_gets(g, "id", NULL);
        if (id && strcmp(id, want) == 0) return g;
    }
    return NULL;
}

static void test_real_script(const char *dir)
{
    char path[1024];
    snprintf(path, sizeof(path), "%s/pkg/script.json", dir);

    puts("[3] real script.json (the .auto sample)");

    size_t len = 0;
    char *buf = read_file(path, &len);
    if (!buf) {
        char d[1200];
        snprintf(d, sizeof(d), "cannot read %s", path);
        bad("load script.json", d);
        return;
    }
    printf("  loaded %s (%lu bytes)\n", path, (unsigned long)len);

    am_json j;
    if (am_json_parse(&j, buf, len) != 0) {
        char d[300];
        snprintf(d, sizeof(d), "line-offset %lu: %s", (unsigned long)j.error_offset, j.error);
        bad("parse script.json", d);
        free(buf);
        return;
    }

    check_int("  top-level type is object", j.root->type == AM_JSON_OBJECT, 1);
    check_int("  top-level key count == 31", (long)am_json_count(j.root), 31);

    check_str("  name", am_json_gets(j.root, "name", NULL), "\xe5\xb9\xbb\xe6\x83\xb3\xe8\xbf\x9e\xe6\x88\x98");
    check_str("  id", am_json_gets(j.root, "id", NULL), "zf6IupVIdAcTt6st");
    check_str("  init", am_json_gets(j.root, "init", NULL), "i8YacrIuyf5VFqi1");
    check_int("  loop_mode", am_json_geti(j.root, "loop_mode", -1), 1);
    check_int("  version", am_json_geti(j.root, "version", -1), 7);
    check_str("  lowest_app_version", am_json_gets(j.root, "lowest_app_version", NULL), "4.3");
    check_int("  concurrency", am_json_getb(j.root, "concurrency", -1), 1);
    check_int("  expand_size", am_json_geti(j.root, "expand_size", -1), 0);
    check_int("  capture_direction", am_json_geti(j.root, "capture_direction", -99), -1);
    check_int("  adapter", am_json_geti(j.root, "adapter", -1), 1);
    check_int("  loop_interval", am_json_geti(j.root, "loop_interval", -1), 30);
    check_int("  contains_config", am_json_getb(j.root, "contains_config", -1), 0);
    check_int("  user_accessibility", am_json_getb(j.root, "user_accessibility", -1), 1);

    /* image_list */
    am_json_value *imgs = am_json_get(j.root, "image_list");
    check_int("  image_list groups == 11", (long)am_json_count(imgs), 11);
    size_t variants = 0;
    for (size_t i = 0; i < am_json_count(imgs); i++) {
        variants += am_json_count(am_json_get(am_json_at(imgs, i), "images"));
    }
    check_int("  image_list total variants == 23", (long)variants, 23);

    /* 逐组核对一个具体变体（招募 id=BqhUaUbSkADiXx5r, 1080x1920 变体 rect=444,1221,186,46） */
    {
        am_json_value *g = find_image_group(imgs, "BqhUaUbSkADiXx5r");
        if (!g) { bad("find group BqhUaUbSkADiXx5r", "not found"); }
        else {
            check_str("  \xe6\x8b\x9b\xe5\x8b\x9f sim", am_json_gets(g, "sim", NULL), "0.8");
            am_json_value *arr = am_json_get(g, "images");
            check_int("  \xe6\x8b\x9b\xe5\x8b\x9f variant count == 2", (long)am_json_count(arr), 2);
            int found1080 = 0;
            for (size_t i = 0; i < am_json_count(arr); i++) {
                am_json_value *v = am_json_at(arr, i);
                am_json_value *si = am_json_get(v, "screen_info");
                if (am_json_geti(si, "width", 0) == 1080 && am_json_geti(si, "height", 0) == 1920) {
                    found1080 = 1;
                    check_str("  1080 variant rect", am_json_gets(v, "rect", NULL), "444,1221,186,46");
                    /* 注意：file 与 ori 都是【裸文件名】，没有 image/ 或 ori/ 前缀；
                     * 且两者的时间戳【不相同】—— file 是模板裁剪图，ori 是它被裁出来的那张全屏截图。
                     * （以 tools/make_package_golden.py 的做法为准：模板读 image/<file>，
                     *   截图读 ori/<ori>，两个目录下各有一份同名文件。） */
                    check_str("  1080 variant file (basename)", am_json_gets(v, "file", NULL),
                              "1789816658183.png");
                    check_str("  1080 variant ori (basename, different ts)",
                              am_json_gets(v, "ori", NULL), "1789816658174.png");
                    check_int("  1080 variant type", am_json_geti(v, "type", -1), 1);
                    check_int("  1080 variant threshold", am_json_geti(v, "threshold", -1), 150);
                    check_int("  1080 variant density", am_json_geti(si, "density", -1), 280);
                    check_int("  1080 variant pixelStride", am_json_geti(si, "pixelStride", -1), 4);
                    check_int("  1080 variant rowPadding", am_json_geti(si, "rowPadding", -1), 0);
                }
            }
            check_int("  found the 1080x1920 variant", found1080, 1);
        }
    }

    /* var_list：9 个变量，各 1 个 crop；招募动作的 search_id 指向一个实际存在的变量 */
    am_json_value *vars = am_json_get(j.root, "var_list");
    check_int("  var_list == 9", (long)am_json_count(vars), 9);
    {
        int all_one_crop = 1;
        for (size_t i = 0; i < am_json_count(vars); i++) {
            am_json_value *v = am_json_at(vars, i);
            if (am_json_geti(v, "type", -1) != 2) all_one_crop = 0;
            if (am_json_count(am_json_get(v, "crops")) != 1) all_one_crop = 0;
        }
        check_int("  every var type==2 and has exactly 1 crop", all_one_crop, 1);
    }

    /* default_scene：10 个场景 */
    am_json_value *scenes = am_json_get(j.root, "default_scene");
    check_int("  default_scene == 10", (long)am_json_count(scenes), 10);
    check_int("  scene_list == 0", (long)am_json_count(am_json_get(j.root, "scene_list")), 0);

    /* 逐场景核对：条件/动作字段 + search_id 能在 var_list 里找到 */
    {
        int scenes_ok = 0, scenes_disabled = 0, refs_ok = 1;
        for (size_t i = 0; i < am_json_count(scenes); i++) {
            am_json_value *sc = am_json_at(scenes, i);
            if (am_json_getb(sc, "disabled", 0)) { scenes_disabled++; continue; }

            am_json_value *ig = am_json_get(sc, "item_group");
            am_json_value *items = am_json_get(ig, "item_list");
            am_json_value *acts = am_json_get(sc, "action_list");

            if (am_json_count(items) < 1 || am_json_count(acts) < 1) continue;

            /* 每个 item / action 的 search_id 必须指向真实变量 */
            for (int pass = 0; pass < 2; pass++) {
                am_json_value *list = pass ? acts : items;
                for (size_t k = 0; k < am_json_count(list); k++) {
                    am_json_value *it = am_json_at(list, k);
                    const char *sid = am_json_gets(it, "search_id", NULL);
                    if (!sid) { refs_ok = 0; continue; }
                    int found = 0;
                    for (size_t vi = 0; vi < am_json_count(vars); vi++) {
                        const char *vid = am_json_gets(am_json_at(vars, vi), "id", NULL);
                        if (vid && strcmp(vid, sid) == 0) { found = 1; break; }
                    }
                    if (!found) refs_ok = 0;
                }
            }
            scenes_ok++;
        }
        check_int("  scenes with search_id all resolve", refs_ok, 1);
        check_int("  active scenes == 8", scenes_ok, 8);
        check_int("  disabled scenes == 2", scenes_disabled, 2);
    }

    /* 具体核对「幻想」场景（default_scene[0]）：1 个条件 + 1 个动作，动作 type=2。
     * 注意：场景列表里【没有】叫「招募」的场景 —— 「招募」只是模板组名，
     * 它被「没开招募」场景当作 item 与 action 的 image_id 使用。 */
    {
        am_json_value *target = NULL;
        for (size_t i = 0; i < am_json_count(scenes); i++) {
            const char *nm = am_json_gets(am_json_at(scenes, i), "name", NULL);
            /* "\xe5\xb9\xbb\xe6\x83\xb3" = 幻想 */
            if (nm && strcmp(nm, "\xe5\xb9\xbb\xe6\x83\xb3") == 0) { target = am_json_at(scenes, i); break; }
        }
        if (!target) { bad("find scene \xe5\xb9\xbb\xe6\x83\xb3", "not found"); }
        else {
            am_json_value *items = am_json_get(am_json_get(target, "item_group"), "item_list");
            am_json_value *acts = am_json_get(target, "action_list");
            check_int("  \xe5\xb9\xbb\xe6\x83\xb3: item count == 1", (long)am_json_count(items), 1);
            check_int("  \xe5\xb9\xbb\xe6\x83\xb3: action count == 1", (long)am_json_count(acts), 1);
            am_json_value *a = am_json_at(acts, 0);
            check_int("  action type == 2 (image)", am_json_geti(a, "type", -1), 2);
            check_int("  action press_time == 0", am_json_geti(a, "press_time", -1), 0);
            check_int("  action click_times == 1", am_json_geti(a, "click_times", -1), 1);
            check_int("  action interval == 0", am_json_geti(a, "interval", -1), 0);
            check_int("  action postpone == 1", am_json_geti(a, "postpone", -1), 1);
            check_int("  action button == 1", am_json_geti(a, "button", -1), 1);
            check_str("  action image_id", am_json_gets(a, "image_id", NULL), "M1GhcK6preOl4bU3");
        }
    }

    /* 「没开招募」场景确实有 2 个条件项（AND） */
    {
        am_json_value *target = NULL;
        for (size_t i = 0; i < am_json_count(scenes); i++) {
            const char *nm = am_json_gets(am_json_at(scenes, i), "name", NULL);
            if (nm && strcmp(nm, "\xe6\xb2\xa1\xe5\xbc\x80\xe6\x8b\x9b\xe5\x8b\x9f") == 0) {
                target = am_json_at(scenes, i); break;
            }
        }
        if (!target) { bad("find scene \xe6\xb2\xa1\xe5\xbc\x80\xe6\x8b\x9b\xe5\x8b\x9f", "not found"); }
        else {
            am_json_value *items = am_json_get(am_json_get(target, "item_group"), "item_list");
            check_int("  \xe6\xb2\xa1\xe5\xbc\x80\xe6\x8b\x9b\xe5\x8b\x9f: item count == 2", (long)am_json_count(items), 2);
            int relations_are_1 = 1;
            for (size_t k = 0; k < am_json_count(items); k++) {
                if (am_json_geti(am_json_at(items, k), "relation", -1) != 1) relations_are_1 = 0;
            }
            check_int("  both items relation == 1 (AND)", relations_are_1, 1);
        }
    }

    am_json_free(&j);
    free(buf);
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);   /* 崩溃别吞输出 */
    const char *dir = (argc > 1) ? argv[1] : "matcher_golden_pkg";
    printf("== am_json test (dir=%s) ==\n", dir);

    test_scalars();
    test_errors();
    test_real_script(dir);

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
