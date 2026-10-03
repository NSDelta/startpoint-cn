/* am_json.c —— 最小 JSON 解析器实现。设计说明见 am_json.h。
 *
 * 实现分两趟：
 *   第 1 趟（scan_*）扫结构、量字符串字节数、数节点数 —— 不分配。
 *   第 2 趟（parse_*）用预先算好的容量一次性建树，过程零 malloc。
 * 这样失败路径只需要 free 两块内存，不存在半成品 DOM 泄漏。
 */
#include "am_json.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>   /* snprintf -- the error formatter */

/* ---------- 错误记录 ---------- */

/* 只保留最早的原因（后续错误多半是级联的） */
static void fail_at(am_json *j, const char *buf, const char *at, const char *what)
{
    if (j->error[0]) return;
    j->error_offset = (size_t)(at - buf);
    snprintf(j->error, sizeof(j->error), "%s", what);
}

/* ---------- UTF-8 ---------- */

static int utf8_encode(unsigned cp, char *out)
{
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static int hex4(const char *p, unsigned *out)
{
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

/* ---------- 字符串（量长度 / 解码，共用同一套转义规则）---------- */

/* p 指向开引号之后。返回值：0 成功；*out_len = 解码后字节数（不含 NUL），
 * *out_close 指向闭引号。 */
static int measure_string(am_json *j, const char *buf, const char *p, const char *end,
                          size_t *out_len, const char **out_close)
{
    size_t n = 0;
    while (p < end) {
        unsigned char c = (unsigned char)*p;
        if (c == '"') { *out_len = n; *out_close = p; return 0; }
        if (c == '\\') {
            p++;
            if (p >= end) { fail_at(j, buf, p, "string ends with a lone backslash"); return -1; }
            switch (*p) {
            case '"': case '\\': case '/': case 'b': case 'f':
            case 'n': case 'r': case 't':
                n += 1; p++; break;
            case 'u': {
                unsigned cp;
                if (p + 5 > end || hex4(p + 1, &cp) != 0) {
                    fail_at(j, buf, p, "bad \\u escape"); return -1;
                }
                p += 5;
                if (cp >= 0xD800 && cp <= 0xDBFF && p + 6 <= end && p[0] == '\\' && p[1] == 'u') {
                    unsigned lo;
                    if (hex4(p + 2, &lo) == 0 && lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                        p += 6;
                    }
                }
                if (cp < 0x80) n += 1;
                else if (cp < 0x800) n += 2;
                else if (cp < 0x10000) n += 3;
                else n += 4;
                break;
            }
            default:
                fail_at(j, buf, p, "unknown escape sequence"); return -1;
            }
        } else if (c < 0x20) {
            fail_at(j, buf, p, "raw control character inside string");
            return -1;
        } else {
            n += 1; p++;
        }
    }
    fail_at(j, buf, end, "unterminated string");
    return -1;
}

/* dst 必须有 measure 出的长度 + 1 字节。返回写入的字节数（不含 NUL）。 */
static size_t decode_string(const char *p, const char *close, char *dst)
{
    char *d = dst;
    while (p < close) {
        unsigned char c = (unsigned char)*p;
        if (c != '\\') { *d++ = (char)c; p++; continue; }
        p++;
        switch (*p) {
        case '"':  *d++ = '"';  p++; break;
        case '\\': *d++ = '\\'; p++; break;
        case '/':  *d++ = '/';  p++; break;
        case 'b':  *d++ = '\b'; p++; break;
        case 'f':  *d++ = '\f'; p++; break;
        case 'n':  *d++ = '\n'; p++; break;
        case 'r':  *d++ = '\r'; p++; break;
        case 't':  *d++ = '\t'; p++; break;
        case 'u': {
            unsigned cp = 0;
            hex4(p + 1, &cp);
            p += 5;
            if (cp >= 0xD800 && cp <= 0xDBFF && p + 6 <= close && p[0] == '\\' && p[1] == 'u') {
                unsigned lo = 0;
                if (hex4(p + 2, &lo) == 0 && lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                    p += 6;
                }
            }
            d += utf8_encode(cp, d);
            break;
        }
        default: p++; break;   /* 不可达：measure_string 已校验 */
        }
    }
    *d = '\0';
    return (size_t)(d - dst);
}

/* ---------- 空白 / 字面量 ---------- */

static void skip_ws(const char **pp, const char *end)
{
    const char *p = *pp;
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    *pp = p;
}

static int match_lit(const char **pp, const char *end, const char *lit)
{
    size_t n = strlen(lit);
    if ((size_t)(end - *pp) < n || memcmp(*pp, lit, n) != 0) return -1;
    *pp += n;
    return 0;
}

static int scan_number(const char **pp, const char *end)
{
    const char *s = *pp;
    if (*pp < end && **pp == '-') (*pp)++;
    while (*pp < end && **pp >= '0' && **pp <= '9') (*pp)++;
    if (*pp < end && **pp == '.') {
        (*pp)++;
        while (*pp < end && **pp >= '0' && **pp <= '9') (*pp)++;
    }
    if (*pp < end && (**pp == 'e' || **pp == 'E')) {
        (*pp)++;
        if (*pp < end && (**pp == '+' || **pp == '-')) (*pp)++;
        while (*pp < end && **pp >= '0' && **pp <= '9') (*pp)++;
    }
    return (*pp == s) ? -1 : 0;
}

/* ---------- 第 1 趟：预算 ---------- */

typedef struct {
    size_t nodes;       /* 需要的节点数（值 + 对象成员各算一个） */
    size_t str_bytes;   /* 字符串池需要的字节数（每个字符串 +1 给 NUL）。
                         * 注意：数字也要在池里存一份字面量（因为 strtod 需要
                         * NUL 结尾，而源缓冲不是），所以数字的字面量长度也算进来。 */
} budget;

static int scan_string(am_json *j, const char *buf, const char **pp, const char *end,
                       budget *b, size_t *out_len)
{
    size_t len;
    const char *close;
    if (**pp != '"') { fail_at(j, buf, *pp, "expected a string"); return -1; }
    if (measure_string(j, buf, *pp + 1, end, &len, &close) != 0) return -1;
    b->str_bytes += len + 1;
    if (out_len) *out_len = len;
    *pp = close + 1;
    return 0;
}

static int scan_value(am_json *j, const char *buf, const char **pp, const char *end,
                      budget *b, int depth)
{
    if (depth > 64) { fail_at(j, buf, *pp, "nesting too deep"); return -1; }
    skip_ws(pp, end);
    if (*pp >= end) { fail_at(j, buf, end, "unexpected end of input"); return -1; }

    char c = **pp;

    if (c == '{') {
        (*pp)++;
        skip_ws(pp, end);
        if (*pp < end && **pp == '}') { (*pp)++; return 0; }
        for (;;) {
            skip_ws(pp, end);
            b->nodes++;                                     /* 成员节点 */
            if (scan_string(j, buf, pp, end, b, NULL) != 0) return -1;
            skip_ws(pp, end);
            if (*pp >= end || **pp != ':') { fail_at(j, buf, *pp, "expected ':'"); return -1; }
            (*pp)++;
            if (scan_value(j, buf, pp, end, b, depth + 1) != 0) return -1;
            skip_ws(pp, end);
            if (*pp < end && **pp == ',') { (*pp)++; continue; }
            if (*pp < end && **pp == '}') { (*pp)++; return 0; }
            fail_at(j, buf, *pp, "expected ',' or '}'");
            return -1;
        }
    }

    if (c == '[') {
        (*pp)++;
        skip_ws(pp, end);
        if (*pp < end && **pp == ']') { (*pp)++; return 0; }
        for (;;) {
            if (scan_value(j, buf, pp, end, b, depth + 1) != 0) return -1;
            skip_ws(pp, end);
            if (*pp < end && **pp == ',') { (*pp)++; continue; }
            if (*pp < end && **pp == ']') { (*pp)++; return 0; }
            fail_at(j, buf, *pp, "expected ',' or ']'");
            return -1;
        }
    }

    b->nodes++;                                             /* 标量/字符串值节点 */

    if (c == '"') return scan_string(j, buf, pp, end, b, NULL);
    if (c == 't') { if (match_lit(pp, end, "true")  != 0) { fail_at(j, buf, *pp, "bad literal"); return -1; } return 0; }
    if (c == 'f') { if (match_lit(pp, end, "false") != 0) { fail_at(j, buf, *pp, "bad literal"); return -1; } return 0; }
    if (c == 'n') { if (match_lit(pp, end, "null")  != 0) { fail_at(j, buf, *pp, "bad literal"); return -1; } return 0; }
    if (c == '-' || (c >= '0' && c <= '9')) {
        const char *s = *pp;
        if (scan_number(pp, end) != 0) { fail_at(j, buf, *pp, "bad number"); return -1; }
        b->str_bytes += (size_t)(*pp - s) + 1;   /* 数字字面量也要占池（见 budget 注释） */
        return 0;
    }

    fail_at(j, buf, *pp, "unexpected character");
    return -1;
}

/* ---------- 第 2 趟：建树 ---------- */

typedef struct {
    am_json_value *nodes;
    size_t node_cap;
    size_t node_used;
    char *strs;
    size_t str_cap;
    size_t str_used;
} pool;

static char *pool_str(pool *pl, size_t n)
{
    if (pl->str_used + n > pl->str_cap) return NULL;
    char *r = pl->strs + pl->str_used;
    pl->str_used += n;
    return r;
}

static am_json_value *pool_node(pool *pl, am_json_type t)
{
    if (pl->node_used >= pl->node_cap) return NULL;
    am_json_value *v = &pl->nodes[pl->node_used++];
    memset(v, 0, sizeof(*v));
    v->type = t;
    return v;
}

static am_json_value *parse_value(am_json *j, const char *buf, const char **pp,
                                  const char *end, pool *pl, int depth);

/* 取一个字符串字段并存进池子。返回 0 成功。 */
static int parse_into_string(am_json *j, const char *buf, const char **pp, const char *end,
                             pool *pl, am_json_value *dst)
{
    size_t len;
    const char *close;
    const char *p = *pp;
    if (*p != '"') { fail_at(j, buf, p, "expected a string"); return -1; }
    if (measure_string(j, buf, p + 1, end, &len, &close) != 0) return -1;
    char *d = pool_str(pl, len + 1);
    if (!d) { fail_at(j, buf, p, "string pool exhausted"); return -1; }
    decode_string(p + 1, close, d);
    dst->str = d;
    dst->len = len;
    *pp = close + 1;
    return 0;
}

/* 解析一个「对象成员」：先把 key 装进 member 节点，再把 member 当值节点填。
 * 复用同一个节点是安全的 —— key 与值互不重叠。 */
static am_json_value *parse_member(am_json *j, const char *buf, const char **pp,
                                   const char *end, pool *pl, int depth)
{
    am_json_value *m = pool_node(pl, AM_JSON_NULL);
    if (!m) { fail_at(j, buf, *pp, "node pool exhausted"); return NULL; }

    /* Object members are reached from two places: parse_value's object loop
     * (which skips whitespace itself) and the '{' branch below (which does
     * not). parse_value skips at ITS entry, so a member reached by the second
     * path would otherwise start on the whitespace that follows a comma. */
    skip_ws(pp, end);
    if (*pp >= end) { fail_at(j, buf, end, "unexpected end of input"); return NULL; }

    /* key */
    if (parse_into_string(j, buf, pp, end, pl, m) != 0) return NULL;
    m->key = m->str;
    m->key_len = m->len;
    m->str = NULL;
    m->len = 0;

    skip_ws(pp, end);
    if (*pp >= end || **pp != ':') { fail_at(j, buf, *pp, "expected ':'"); return NULL; }
    (*pp)++;

    /* value：直接写进 m（覆盖 type/num/str/first，不碰 key/key_len） */
    skip_ws(pp, end);
    if (*pp >= end) { fail_at(j, buf, end, "unexpected end of input"); return NULL; }
    char c = **pp;

    if (c == '{' || c == '[') {
        const int is_obj = (c == '{');
        (*pp)++;
        m->type = is_obj ? AM_JSON_OBJECT : AM_JSON_ARRAY;
        skip_ws(pp, end);
        char closec = is_obj ? '}' : ']';
        if (*pp < end && **pp == closec) { (*pp)++; return m; }
        am_json_value *tail = NULL;
        for (;;) {
            am_json_value *child = is_obj
                ? parse_member(j, buf, pp, end, pl, depth + 1)
                : parse_value(j, buf, pp, end, pl, depth + 1);
            if (!child) {
                return NULL;
            }
            if (tail) tail->next = child; else m->first = child;
            tail = child;
            skip_ws(pp, end);
            if (*pp < end && **pp == ',') { (*pp)++; continue; }
            if (*pp < end && **pp == closec) {
                (*pp)++;
                return m;
            }
            fail_at(j, buf, *pp, is_obj ? "expected ',' or '}'" : "expected ',' or ']'");
            return NULL;
        }
    }

    if (c == '"') {
        m->type = AM_JSON_STRING;
        if (parse_into_string(j, buf, pp, end, pl, m) != 0) return NULL;
        return m;
    }

    if (c == 't' || c == 'f' || c == 'n') {
        const char *p = *pp;
        if (c == 't') {
            if (match_lit(pp, end, "true") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            m->type = AM_JSON_BOOL; m->num = 1;
        } else if (c == 'f') {
            if (match_lit(pp, end, "false") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            m->type = AM_JSON_BOOL; m->num = 0;
        } else {
            if (match_lit(pp, end, "null") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            m->type = AM_JSON_NULL;
        }
        return m;
    }

    if (c == '-' || (c >= '0' && c <= '9')) {
        const char *s = *pp;
        if (scan_number(pp, end) != 0) { fail_at(j, buf, s, "bad number"); return NULL; }
        size_t n = (size_t)(*pp - s);
        char *lit = pool_str(pl, n + 1);
        if (!lit) { fail_at(j, buf, s, "string pool exhausted"); return NULL; }
        memcpy(lit, s, n);
        lit[n] = '\0';
        m->type = AM_JSON_NUMBER;
        m->str = lit;
        m->len = n;
        m->num = strtod(lit, NULL);
        return m;
    }

    fail_at(j, buf, *pp, "unexpected character");
    return NULL;
}

static am_json_value *parse_value(am_json *j, const char *buf, const char **pp,
                                  const char *end, pool *pl, int depth)
{
    if (depth > 64) { fail_at(j, buf, *pp, "nesting too deep"); return NULL; }
    skip_ws(pp, end);
    if (*pp >= end) { fail_at(j, buf, end, "unexpected end of input"); return NULL; }

    char c = **pp;

    if (c == '{') {
        am_json_value *obj = pool_node(pl, AM_JSON_OBJECT);
        if (!obj) { fail_at(j, buf, *pp, "node pool exhausted"); return NULL; }
        (*pp)++;
        skip_ws(pp, end);
        if (*pp < end && **pp == '}') { (*pp)++; return obj; }
        am_json_value *tail = NULL;
        for (;;) {
            skip_ws(pp, end);
            am_json_value *m = parse_member(j, buf, pp, end, pl, depth + 1);
            if (!m) return NULL;
            if (tail) tail->next = m; else obj->first = m;
            tail = m;
            skip_ws(pp, end);
            if (*pp < end && **pp == ',') { (*pp)++; continue; }
            if (*pp < end && **pp == '}') { (*pp)++; return obj; }
            fail_at(j, buf, *pp, "expected ',' or '}'");
            return NULL;
        }
    }

    if (c == '[') {
        am_json_value *arr = pool_node(pl, AM_JSON_ARRAY);
        if (!arr) { fail_at(j, buf, *pp, "node pool exhausted"); return NULL; }
        (*pp)++;
        skip_ws(pp, end);
        if (*pp < end && **pp == ']') { (*pp)++; return arr; }
        am_json_value *tail = NULL;
        for (;;) {
            am_json_value *e = parse_value(j, buf, pp, end, pl, depth + 1);
            if (!e) return NULL;
            if (tail) tail->next = e; else arr->first = e;
            tail = e;
            skip_ws(pp, end);
            if (*pp < end && **pp == ',') { (*pp)++; continue; }
            if (*pp < end && **pp == ']') { (*pp)++; return arr; }
            fail_at(j, buf, *pp, "expected ',' or ']'");
            return NULL;
        }
    }

    if (c == '"') {
        am_json_value *v = pool_node(pl, AM_JSON_STRING);
        if (!v) { fail_at(j, buf, *pp, "node pool exhausted"); return NULL; }
        if (parse_into_string(j, buf, pp, end, pl, v) != 0) return NULL;
        return v;
    }

    if (c == 't' || c == 'f' || c == 'n') {
        const char *p = *pp;
        am_json_value *v;
        if (c == 't') {
            if (match_lit(pp, end, "true") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            v = pool_node(pl, AM_JSON_BOOL); if (!v) return NULL; v->num = 1;
        } else if (c == 'f') {
            if (match_lit(pp, end, "false") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            v = pool_node(pl, AM_JSON_BOOL); if (!v) return NULL; v->num = 0;
        } else {
            if (match_lit(pp, end, "null") != 0) { fail_at(j, buf, p, "bad literal"); return NULL; }
            v = pool_node(pl, AM_JSON_NULL); if (!v) return NULL;
        }
        return v;
    }

    if (c == '-' || (c >= '0' && c <= '9')) {
        const char *s = *pp;
        if (scan_number(pp, end) != 0) { fail_at(j, buf, s, "bad number"); return NULL; }
        size_t n = (size_t)(*pp - s);
        char *lit = pool_str(pl, n + 1);
        if (!lit) { fail_at(j, buf, s, "string pool exhausted"); return NULL; }
        memcpy(lit, s, n);
        lit[n] = '\0';
        am_json_value *v = pool_node(pl, AM_JSON_NUMBER);
        if (!v) return NULL;
        v->str = lit;
        v->len = n;
        v->num = strtod(lit, NULL);
        return v;
    }

    fail_at(j, buf, *pp, "unexpected character");
    return NULL;
}

/* ---------- 公开 API ---------- */

int am_json_parse(am_json *j, const char *buf, size_t len)
{
    if (!j) return -1;
    memset(j, 0, sizeof(*j));
    if (!buf) { snprintf(j->error, sizeof(j->error), "null buffer"); return -1; }

    const char *base = buf;
    const char *p = buf;
    const char *end = buf + len;

    /* 跳过 UTF-8 BOM */
    if (len >= 3 && (unsigned char)buf[0] == 0xEF
        && (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) {
        p = buf + 3;
    }

    /* 第 1 趟：预算 */
    budget b;
    memset(&b, 0, sizeof(b));
    const char *q = p;
    if (scan_value(j, base, &q, end, &b, 0) != 0) return -1;
    skip_ws(&q, end);
    if (q != end) { fail_at(j, base, q, "trailing garbage after top-level value"); return -1; }
    if (b.nodes == 0) { snprintf(j->error, sizeof(j->error), "empty input"); return -1; }

    /* 第 2 趟：两块连续内存，过程零 malloc */
    pool pl;
    memset(&pl, 0, sizeof(pl));
    pl.node_cap = b.nodes + 8;
    pl.nodes = (am_json_value *)calloc(pl.node_cap, sizeof(am_json_value));
    pl.str_cap = b.str_bytes + 8;
    pl.strs = (char *)malloc(pl.str_cap);
    if (!pl.nodes || !pl.strs) {
        free(pl.nodes);
        free(pl.strs);
        snprintf(j->error, sizeof(j->error), "out of memory");
        return -1;
    }
    /* 池的所有权先交给 j —— 后续任何失败路径都由 am_json_free 统一回收 */
    j->pool = pl.nodes;
    j->strpool = pl.strs;

    const char *r = p;
    am_json_value *root = parse_value(j, base, &r, end, &pl, 0);
    if (!root) return -1;
    j->root = root;
    return 0;
}

void am_json_free(am_json *j)
{
    if (!j) return;
    free(j->pool);
    free(j->strpool);
    memset(j, 0, sizeof(*j));
}

am_json_value *am_json_get(const am_json_value *obj, const char *key)
{
    if (!obj || obj->type != AM_JSON_OBJECT || !key) return NULL;
    size_t klen = strlen(key);
    for (am_json_value *m = obj->first; m; m = m->next) {
        if (m->key_len == klen && m->key && memcmp(m->key, key, klen) == 0) return m;
    }
    return NULL;
}

am_json_value *am_json_at(const am_json_value *arr, size_t index)
{
    if (!arr || arr->type != AM_JSON_ARRAY) return NULL;
    size_t i = 0;
    for (am_json_value *e = arr->first; e; e = e->next, i++) {
        if (i == index) return e;
    }
    return NULL;
}

size_t am_json_count(const am_json_value *v)
{
    if (!v || (v->type != AM_JSON_ARRAY && v->type != AM_JSON_OBJECT)) return 0;
    size_t n = 0;
    for (am_json_value *e = v->first; e; e = e->next) n++;
    return n;
}

const char *am_json_str(const am_json_value *v, const char *def)
{
    if (!v || v->type != AM_JSON_STRING || !v->str) return def;
    return v->str;
}

double am_json_num(const am_json_value *v, double def)
{
    if (!v) return def;
    if (v->type == AM_JSON_NUMBER || v->type == AM_JSON_BOOL) return v->num;
    return def;
}

int am_json_int(const am_json_value *v, int def)
{
    if (!v) return def;
    if (v->type == AM_JSON_NUMBER || v->type == AM_JSON_BOOL) return (int)v->num;
    return def;
}

int am_json_bool(const am_json_value *v, int def)
{
    if (!v) return def;
    switch (v->type) {
    case AM_JSON_BOOL:
    case AM_JSON_NUMBER: return v->num != 0.0;
    case AM_JSON_STRING: return v->str && v->str[0] != '\0'
                                && strcmp(v->str, "false") != 0
                                && strcmp(v->str, "0") != 0;
    case AM_JSON_NULL:   return 0;
    case AM_JSON_ARRAY:
    case AM_JSON_OBJECT: return 1;
    }
    return def;
}

int am_json_is_null(const am_json_value *v)
{
    return !v || v->type == AM_JSON_NULL;
}

const char *am_json_type_name(am_json_type t)
{
    switch (t) {
    case AM_JSON_NULL:   return "null";
    case AM_JSON_BOOL:   return "bool";
    case AM_JSON_NUMBER: return "number";
    case AM_JSON_STRING: return "string";
    case AM_JSON_ARRAY:  return "array";
    case AM_JSON_OBJECT: return "object";
    }
    return "?";
}

const char *am_json_gets(const am_json_value *obj, const char *key, const char *def)
{
    return am_json_str(am_json_get(obj, key), def);
}

int am_json_geti(const am_json_value *obj, const char *key, int def)
{
    return am_json_int(am_json_get(obj, key), def);
}

double am_json_getn(const am_json_value *obj, const char *key, double def)
{
    return am_json_num(am_json_get(obj, key), def);
}

int am_json_getb(const am_json_value *obj, const char *key, int def)
{
    return am_json_bool(am_json_get(obj, key), def);
}
