/* am_json.h —— 最小 JSON 解析器（纯 C99，零依赖）
 *
 * 为什么自己写：iOS tweak 里不想引第三方；解析对象只是 .auto 的 script.json
 * （20KB，UTF-8，标准 JSON，无 BOM，无注释）。
 *
 * 设计取舍：
 *   - 先扫描一遍算出「值节点总数」和「所有字符串的字节数」，然后一次性
 *     分配两块连续内存。解析过程中不再 malloc —— 失败时只需释放两块内存，
 *     不存在半成品 DOM 泄漏。
 *   - 零拷贝：字符串是原缓冲里的切片（对 \uXXXX 与 \n 这类转义，先量出
 *     编码后的字节长度，再就地写入）。
 *   - 不做数字到 double 的转换，只保留字面量切片 + 一个 double 字段，
 *     避免精度/本地化问题。
 *
 * 线程安全：无全局状态。同一个 am_json 不可并发读（惰性字段除外）。
 */
#ifndef AM_JSON_H
#define AM_JSON_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    AM_JSON_NULL = 0,
    AM_JSON_BOOL,
    AM_JSON_NUMBER,
    AM_JSON_STRING,
    AM_JSON_ARRAY,
    AM_JSON_OBJECT
} am_json_type;

/* 值节点。对象成员与数组元素都复用同一结构。
 * 对象用链表串起成员（JSON 成员顺序有意义，.auto 的 toJson 顺序要保真）。 */
typedef struct am_json_value {
    am_json_type type;

    /* STRING / NUMBER 的字面量（NUMBER 是已解码的裸字面量，如 "-1.5e3"） */
    const char *str;
    size_t len;

    /* NUMBER 的数值；BOOL 时 0/1；NULL 时为 0 */
    double num;

    /* 对象成员名（仅作为「成员」出现时非 NULL） */
    const char *key;
    size_t key_len;

    /* 子节点 */
    struct am_json_value *first;   /* ARRAY/OBJECT 的首个子节点 */
    struct am_json_value *next;    /* 同一父节点下的下一个兄弟 */
} am_json_value;

typedef struct {
    am_json_value *root;           /* 顶层值；解析失败为 NULL */
    void *pool;                    /* 节点池，由 am_json_free 释放 */
    void *strpool;                 /* 字符串池 */
    char error[192];               /* 失败原因（含字节偏移） */
    size_t error_offset;
} am_json;

/* 解析 buf[0..len)。成功返回 0；失败返回 -1 并填 json->error。
 * 成功后必须调用 am_json_free。 */
int am_json_parse(am_json *json, const char *buf, size_t len);

/* 释放；可安全重复调用（会清空结构） */
void am_json_free(am_json *json);

/* ---- 取值辅助（全部对 NULL 安全，缺字段返回缺省值）---- */

am_json_value *am_json_get(const am_json_value *obj, const char *key);
/* 按索引取数组元素；越界返回 NULL */
am_json_value *am_json_at(const am_json_value *arr, size_t index);
size_t am_json_count(const am_json_value *arr_or_obj);

const char *am_json_str(const am_json_value *v, const char *def);   /* STRING；否则 def */
double am_json_num(const am_json_value *v, double def);             /* NUMBER/BOOL */
int am_json_int(const am_json_value *v, int def);
int am_json_bool(const am_json_value *v, int def);                  /* 任意类型松散解释 */
int am_json_is_null(const am_json_value *v);

const char *am_json_type_name(am_json_type t);

/* 对象字段快捷取值 */
const char *am_json_gets(const am_json_value *obj, const char *key, const char *def);
int am_json_geti(const am_json_value *obj, const char *key, int def);
double am_json_getn(const am_json_value *obj, const char *key, double def);
int am_json_getb(const am_json_value *obj, const char *key, int def);

#ifdef __cplusplus
}
#endif

#endif /* AM_JSON_H */
