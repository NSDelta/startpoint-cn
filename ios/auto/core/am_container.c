/*
 * am_container.c —— .auto(ZIP) + PNG 读取层实现。纯 C99，内置 inflate（无 zlib 依赖）。
 *
 * 安全性说明：.auto 是**用户提供的不可信输入**，本文件所有偏移/长度都做了边界检查，
 * 不允许出现越界读。inflate 的输出缓冲区大小由 ZIP 中央目录的 uncompressed size 精确给出，
 * 每次写字节都校验剩余空间。
 */
#include "am_container.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── 基础工具 ───────────────────────────────────────────────────────────── */
const char *am_strerror(int s)
{
    switch (s) {
    case AM_OK: return "ok";
    case AM_ERR_ARG: return "invalid argument";
    case AM_ERR_IO: return "i/o error or not found";
    case AM_ERR_FORMAT: return "malformed data";
    case AM_ERR_DEFLATE: return "corrupt deflate stream";
    case AM_ERR_UNSUPPORTED: return "unsupported format variant";
    case AM_ERR_TRUNCATED: return "buffer too small or data truncated";
    case AM_ERR_NOMEM: return "out of memory";
    default: return "unknown error";
    }
}

static size_t rd16(const unsigned char *p) { return (size_t)p[0] | ((size_t)p[1] << 8); }
static size_t rd32(const unsigned char *p)
{
    return (size_t)p[0] | ((size_t)p[1] << 8) | ((size_t)p[2] << 16) | ((size_t)p[3] << 24);
}

/* ZIP 是小端，PNG 是大端 —— 两者混用会让 chunk 长度读成天文数字，
 * 于是 while 循环第一轮就因 "p + 12 + clen > size" 跳出，IHDR 从未被解析（本文件踩过这个坑）。 */
static size_t rd32be(const unsigned char *p)
{
    return ((size_t)p[0] << 24) | ((size_t)p[1] << 16) | ((size_t)p[2] << 8) | (size_t)p[3];
}

/* ── inflate ────────────────────────────────────────────────────────────── */
#define AM_MAXBITS 15
#define AM_FASTBITS 9

typedef struct {
    short count[AM_MAXBITS + 1];
    short sym[288];
} am_huff;

typedef struct {
    unsigned char lens[1 << AM_FASTBITS];   /* 每个槽位对应的码长（0 = 无效） */
    short symbols[1 << AM_FASTBITS];
} am_lookup;

typedef struct {
    unsigned char *out;
    size_t cap, len;
    unsigned bitbuf;
    int bitcnt;
    int err;
} am_bitstream;

static int am_ensure(am_bitstream *s, size_t extra)
{
    if (s->err) return 0;
    if (s->len + extra > s->cap) { s->err = AM_ERR_TRUNCATED; return 0; }
    return 1;
}

static int am_bits(am_bitstream *s, const unsigned char *in, size_t inlen, size_t *pos, int need)
{
    while (s->bitcnt < need) {
        if (*pos >= inlen) { s->err = AM_ERR_TRUNCATED; return 0; }
        s->bitbuf |= (unsigned)in[*pos] << s->bitcnt;
        (*pos)++;
        s->bitcnt += 8;
    }
    const int v = (int)(s->bitbuf & ((1u << need) - 1u));
    s->bitbuf >>= need;
    s->bitcnt -= need;
    return v;
}

/* lengths[] 是"每符号的码长"，取值 0..15。
 * 用 unsigned char 而非 short：码长表本身是字节序列，早期版本把 unsigned char[19] 强转成
 * short* 传进来（`(const short *)lens`），在小端机上会把相邻两个字节拼成一个 short，
 * 于是 hlit=283 的表里只有一个非零项、am_build 直接判为过完备而失败。 */
static int am_build(am_huff *h, const unsigned char *lengths, int n)
{
    int i;
    for (i = 0; i <= AM_MAXBITS; i++) h->count[i] = 0;
    /* 必须先校验取值范围：lengths[] 来自位流，一旦有值 > AM_MAXBITS，
     * h->count[lengths[i]] 就会越过 count[15] 写进 sym[]（栈上，静默破坏后续数据）。 */
    for (i = 0; i < n; i++) {
        if (lengths[i] > AM_MAXBITS) return AM_ERR_DEFLATE;
        h->count[lengths[i]]++;
    }
    if (h->count[0] == n) return 0;              /* 没有码（合法，全 0 长度） */
    int left = 1;
    for (i = 1; i <= AM_MAXBITS; i++) {
        left <<= 1;
        left -= h->count[i];
        if (left < 0) return AM_ERR_DEFLATE;     /* 码长集合过完备 */
    }
    short offs[AM_MAXBITS + 2];
    offs[1] = 0;
    for (i = 1; i <= AM_MAXBITS; i++) offs[i + 1] = (short)(offs[i] + h->count[i]);
    for (i = 0; i < n; i++)
        if (lengths[i]) h->sym[offs[lengths[i]]++] = (short)i;
    return left;                                  /* >0 = 允许的不完整码 */
}

/* 为 LSB-first 的位流构造查表（码字需按位反转） */
static void am_build_lookup(am_lookup *t, const am_huff *h)
{
    int i, len, sym, k, rev;
    int symidx = 0;
    unsigned nextcode[AM_MAXBITS + 1];
    unsigned code = 0;

    memset(t->lens, 0, sizeof(t->lens));
    for (i = 0; i < (1 << AM_FASTBITS); i++) t->symbols[i] = -1;
    for (len = 1; len <= AM_MAXBITS; len++) {
        code = (code + (unsigned)h->count[len - 1]) << 1;
        nextcode[len] = code;
    }
    for (len = 1; len <= AM_MAXBITS; len++) {
        for (k = 0; k < h->count[len]; k++) {
            sym = h->sym[symidx++];
            const unsigned c = nextcode[len]++;
            rev = 0;
            for (i = 0; i < len; i++) rev |= (int)((c >> i) & 1u) << (len - 1 - i);
            if (len <= AM_FASTBITS) {
                const int step = 1 << len;
                for (i = rev; i < (1 << AM_FASTBITS); i += step) {
                    t->symbols[i] = (short)sym;
                    t->lens[i] = (unsigned char)len;
                }
            }
            /* 长码（len > FASTBITS）不进快表，由慢路径处理 */
        }
    }
}

/* 从位流解出一个符号；返回 -1 表示损坏。快表覆盖 len<=FASTBITS，其余走逐位canonical 解码。 */
static int am_decode(am_bitstream *s, const unsigned char *in, size_t inlen, size_t *pos,
                     const am_huff *h, const am_lookup *t)
{
    /* 补齐到 FASTBITS（deflate 保证剩余字节总是够的；不够则报截断） */
    while (s->bitcnt < AM_FASTBITS) {
        if (*pos >= inlen) { s->err = AM_ERR_TRUNCATED; return -1; }
        s->bitbuf |= (unsigned)in[*pos] << s->bitcnt;
        (*pos)++;
        s->bitcnt += 8;
    }

    const int idx = (int)(s->bitbuf & ((1u << AM_FASTBITS) - 1u));
    const unsigned char flen = t->lens[idx];
    if (flen
#ifdef AM_DISABLE_FASTTABLE
        && 0
#endif
        ) {
        const int sym = t->symbols[idx];
        s->bitbuf >>= flen;
        s->bitcnt -= flen;
        return sym;
    }

    /* 慢路径：canonical Huffman，逐位推进 */
    {
        int len, code = 0, first = 0, index = 0;
        for (len = 1; len <= AM_MAXBITS; len++) {
            if (s->bitcnt <= 0) {
                if (*pos >= inlen) { s->err = AM_ERR_TRUNCATED; return -1; }
                s->bitbuf |= (unsigned)in[*pos] << s->bitcnt;
                (*pos)++;
                s->bitcnt += 8;
            }
            code |= (int)(s->bitbuf & 1u);
            s->bitbuf >>= 1;
            s->bitcnt--;
            const int count = h->count[len];
            if (code - first < count) return h->sym[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
    }
    return -1;
}

int am_inflate_raw(const unsigned char *in, size_t inlen, unsigned char *out, size_t outcap,
                   size_t *outlen);

int am_inflate_raw(const unsigned char *in, size_t inlen, unsigned char *out, size_t outcap,
                   size_t *outlen)
{
    am_bitstream s;
    am_huff lencode, distcode;
    am_lookup llookup, dlookup;
    unsigned char lengths[320];
    size_t pos = 0;
    int last, type, i, err;
    unsigned char lens[19];

    memset(&s, 0, sizeof(s));
    s.out = out; s.cap = outcap; s.len = 0; s.bitbuf = 0; s.bitcnt = 0; s.err = 0;
    memset(&llookup, 0, sizeof(llookup));
    memset(&dlookup, 0, sizeof(dlookup));

    do {
        last = am_bits(&s, in, inlen, &pos, 1);
        type = am_bits(&s, in, inlen, &pos, 2);
        if (s.err) return s.err;

        if (type == 0) {                                   /* stored */
            s.bitbuf = 0; s.bitcnt = 0;
            if (pos + 4 > inlen) return AM_ERR_TRUNCATED;
            const size_t len = rd16(in + pos);
            const size_t nlen = rd16(in + pos + 2);
            pos += 4;
            if ((len ^ 0xFFFFu) != nlen) return AM_ERR_DEFLATE;
            if (pos + len > inlen) return AM_ERR_TRUNCATED;
            if (!am_ensure(&s, len)) return s.err;
            memcpy(s.out + s.len, in + pos, len);
            s.len += len;
            pos += len;
        } else if (type == 1 || type == 2) {
            if (type == 1) {                               /* 固定 Huffman */
                for (i = 0; i < 144; i++) lengths[i] = 8;
                for (; i < 256; i++) lengths[i] = 9;
                for (; i < 280; i++) lengths[i] = 7;
                for (; i < 288; i++) lengths[i] = 8;
                err = am_build(&lencode, lengths, 288);
                if (err < 0) return AM_ERR_DEFLATE;
                for (i = 0; i < 30; i++) lengths[i] = 5;
                err = am_build(&distcode, lengths, 30);
                if (err < 0) return AM_ERR_DEFLATE;
            } else {                                       /* 动态 Huffman */
                static const short ord[19] = { 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15 };
                const int hlit = am_bits(&s, in, inlen, &pos, 5) + 257;
                const int hdist = am_bits(&s, in, inlen, &pos, 5) + 1;
                const int hclen = am_bits(&s, in, inlen, &pos, 4) + 4;
                if (s.err) return s.err;
                if (hlit > 286 || hdist > 30) return AM_ERR_DEFLATE;
                for (i = 0; i < 19; i++) lens[i] = 0;
                for (i = 0; i < hclen; i++) {
                    const int v = am_bits(&s, in, inlen, &pos, 3);
                    if (s.err) return s.err;
                    lens[ord[i]] = (unsigned char)v;
                }
                am_huff lc;
                am_lookup lclookup;     /* ← 码长树自己的查表；早期版本这里误用了 dlookup（全零表），
                                         *   会让 am_decode 走进慢路径并用错误的符号表，最终越界读。 */
                err = am_build(&lc, lens, 19);
                if (err < 0) return AM_ERR_DEFLATE;
                am_build_lookup(&lclookup, &lc);
                int n = 0;
                while (n < hlit + hdist) {
                    const int sym = am_decode(&s, in, inlen, &pos, &lc, &lclookup);
                    if (sym < 0) return AM_ERR_DEFLATE;
                    if (sym < 16) {
                        lengths[n++] = (unsigned char)sym;
                    } else {
                        int rep, val = 0;
                        if (sym == 16) {
                            if (n == 0) return AM_ERR_DEFLATE;
                            val = lengths[n - 1];
                            rep = 3 + am_bits(&s, in, inlen, &pos, 2);
                        } else if (sym == 17) {
                            rep = 3 + am_bits(&s, in, inlen, &pos, 3);
                        } else {
                            rep = 11 + am_bits(&s, in, inlen, &pos, 7);
                        }
                        if (s.err) return s.err;
                        if (n + rep > hlit + hdist) return AM_ERR_DEFLATE;
                        while (rep--) lengths[n++] = (unsigned char)val;
                    }
                }
                if (lengths[256] == 0) return AM_ERR_DEFLATE;  /* 缺 EOB 码 */
                err = am_build(&lencode, lengths, hlit);
                if (err < 0) return AM_ERR_DEFLATE;
                err = am_build(&distcode, lengths + hlit, hdist);
                if (err < 0) return AM_ERR_DEFLATE;
            }
            am_build_lookup(&llookup, &lencode);
            am_build_lookup(&dlookup, &distcode);

            static const short lenbase[29] = { 3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,
                                               59,67,83,99,115,131,163,195,227,258 };
            static const short lenext[29]  = { 0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0 };
            static const short distbase[30] = { 1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,
                                                513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577 };
            static const short distext[30]  = { 0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13 };

            for (;;) {
                const int sym = am_decode(&s, in, inlen, &pos, &lencode, &llookup);
                if (sym < 0) return AM_ERR_DEFLATE;
                if (sym < 256) {
                    if (!am_ensure(&s, 1)) return s.err;
                    s.out[s.len++] = (unsigned char)sym;
                } else if (sym == 256) {
                    break;
                } else {
                    const int li = sym - 257;
                    if (li >= 29) return AM_ERR_DEFLATE;
                    int l = lenbase[li];
                    if (lenext[li]) {
                        const int e = am_bits(&s, in, inlen, &pos, lenext[li]);
                        if (s.err) return s.err;
                        l += e;
                    }
                    const int dsym = am_decode(&s, in, inlen, &pos, &distcode, &dlookup);
                    if (dsym < 0 || dsym >= 30) return AM_ERR_DEFLATE;
                    int d = distbase[dsym];
                    if (distext[dsym]) {
                        const int e = am_bits(&s, in, inlen, &pos, distext[dsym]);
                        if (s.err) return s.err;
                        d += e;
                    }
                    if ((size_t)d > s.len) return AM_ERR_DEFLATE;
                    if (!am_ensure(&s, (size_t)l)) return s.err;
                    {
                        unsigned char *dst = s.out + s.len;
                        const unsigned char *src = dst - d;
                        size_t nn = (size_t)l;
                        while (nn--) *dst++ = *src++;
                        s.len += (size_t)l;
                    }
                }
            }
        } else {
            return AM_ERR_FORMAT;
        }
    } while (!last);

    *outlen = s.len;
    return AM_OK;
}

/* zlib 包装（PNG 用）：2 字节头 + deflate + 4 字节 Adler-32。
 * 注意：am_inflate_raw 必须先声明 —— 否则 MSVC 会按隐式声明（参数为 int）编译调用点，
 * 在 Win64 上把 size_t/指针的高 32 位截掉，表现为访问违例（本文件踩过这个坑）。 */
int am_inflate_raw(const unsigned char *in, size_t inlen, unsigned char *out, size_t outcap,
                   size_t *outlen);

int am_inflate_zlib(const unsigned char *in, size_t inlen, unsigned char *out,
                           size_t outcap, size_t *outlen)
{
    if (inlen < 6) return AM_ERR_TRUNCATED;
    if ((in[0] & 0x0F) != 8) return AM_ERR_UNSUPPORTED;
    if ((((unsigned)in[0] << 8) | in[1]) % 31 != 0) return AM_ERR_FORMAT;
    if (in[1] & 0x20) return AM_ERR_UNSUPPORTED;   /* preset dictionary */
    return am_inflate_raw(in + 2, inlen - 2, out, outcap, outlen);
}

/* ── ZIP ────────────────────────────────────────────────────────────────── */
typedef struct {
    char *name;
    size_t name_len;
    size_t comp_size, uncomp_size, local_off;
    int method;
} am_zip_entry;

struct am_auto {
    unsigned char *data;
    size_t size;
    int owns_data;
    am_zip_entry *entries;
    int count;
};

static int am_zip_parse(am_auto *z)
{
    if (z->size < 22) return AM_ERR_FORMAT;
    size_t tail = z->size < 65557 ? z->size : 65557;
    size_t eocd = 0;
    int found = 0;
    for (size_t i = z->size - 22 + 1; i-- > z->size - tail;) {
        if (z->data[i] == 0x50 && z->data[i + 1] == 0x4b &&
            z->data[i + 2] == 0x05 && z->data[i + 3] == 0x06) { eocd = i; found = 1; break; }
    }
    if (!found) return AM_ERR_FORMAT;
    if (eocd + 22 > z->size) return AM_ERR_TRUNCATED;

    size_t n = rd16(z->data + eocd + 10);
    size_t cd_size = rd32(z->data + eocd + 12);
    size_t cd_off = rd32(z->data + eocd + 16);
    /* zip64 的"哨兵值"直接拒绝：.auto 不会那么大 */
    if (n == 0xFFFF || cd_off == 0xFFFFFFFFu || cd_size == 0xFFFFFFFFu) return AM_ERR_UNSUPPORTED;
    if (cd_off > z->size || cd_off + cd_size > z->size) {
        cd_off = rd32(z->data + eocd + 16);
        if (cd_off > z->size) return AM_ERR_FORMAT;
    }

    z->entries = (am_zip_entry *)calloc(n ? n : 1, sizeof(am_zip_entry));
    if (!z->entries) return AM_ERR_NOMEM;
    z->count = 0;

    size_t p = cd_off;
    const size_t cd_end = (cd_size && cd_off + cd_size <= z->size) ? cd_off + cd_size : z->size;
    for (size_t k = 0; k < n; k++) {
        if (p + 46 > z->size || p + 46 > cd_end + 46) return AM_ERR_TRUNCATED;
        if (!(z->data[p] == 0x50 && z->data[p + 1] == 0x4b &&
              z->data[p + 2] == 0x01 && z->data[p + 3] == 0x02)) return AM_ERR_FORMAT;
        am_zip_entry *e = &z->entries[z->count];
        e->method = (int)rd16(z->data + p + 10);
        e->comp_size = rd32(z->data + p + 20);
        e->uncomp_size = rd32(z->data + p + 24);
        const size_t nlen = rd16(z->data + p + 28);
        const size_t elen = rd16(z->data + p + 30);
        const size_t clen = rd16(z->data + p + 32);
        e->local_off = rd32(z->data + p + 42);
        if (p + 46 + nlen > z->size) return AM_ERR_TRUNCATED;
        e->name = (char *)malloc(nlen + 1);
        if (!e->name) return AM_ERR_NOMEM;
        memcpy(e->name, z->data + p + 46, nlen);
        e->name[nlen] = '\0';
        e->name_len = nlen;
        z->count++;
        p += 46 + nlen + elen + clen;
    }
    return AM_OK;
}

int am_auto_open_memory(const void *data, size_t size, am_auto **out)
{
    if (!data || !out) return AM_ERR_ARG;
    am_auto *z = (am_auto *)calloc(1, sizeof(am_auto));
    if (!z) return AM_ERR_NOMEM;
    z->data = (unsigned char *)data;
    z->size = size;
    z->owns_data = 0;
    const int rc = am_zip_parse(z);
    if (rc != AM_OK) { am_auto_close(z); return rc; }
    *out = z;
    return AM_OK;
}

int am_auto_open(const char *path, am_auto **out)
{
    if (!path || !out) return AM_ERR_ARG;
    FILE *f = fopen(path, "rb");
    if (!f) return AM_ERR_IO;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return AM_ERR_IO; }
    const long sz = ftell(f);
    if (sz < 0) { fclose(f); return AM_ERR_IO; }
    rewind(f);
    unsigned char *buf = (unsigned char *)malloc((size_t)sz ? (size_t)sz : 1);
    if (!buf) { fclose(f); return AM_ERR_NOMEM; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return AM_ERR_IO; }
    fclose(f);

    am_auto *z = (am_auto *)calloc(1, sizeof(am_auto));
    if (!z) { free(buf); return AM_ERR_NOMEM; }
    z->data = buf;
    z->size = (size_t)sz;
    z->owns_data = 1;
    const int rc = am_zip_parse(z);
    if (rc != AM_OK) { am_auto_close(z); return rc; }
    *out = z;
    return AM_OK;
}

void am_auto_close(am_auto *z)
{
    if (!z) return;
    for (int i = 0; i < z->count; i++) free(z->entries[i].name);
    free(z->entries);
    if (z->owns_data) free(z->data);
    free(z);
}

int am_auto_count(const am_auto *z) { return z ? z->count : 0; }

const char *am_auto_name(const am_auto *z, int i)
{
    if (!z || i < 0 || i >= z->count) return NULL;
    return z->entries[i].name;
}

static const am_zip_entry *am_find(const am_auto *z, const char *name)
{
    if (!z || !name) return NULL;
    for (int i = 0; i < z->count; i++)
        if (strcmp(z->entries[i].name, name) == 0) return &z->entries[i];
    return NULL;
}

int am_auto_has(const am_auto *z, const char *name) { return am_find(z, name) != NULL; }

int am_auto_read(const am_auto *z, const char *name, void *buf, size_t *out_size)
{
    if (!z || !name || !out_size) return AM_ERR_ARG;
    const am_zip_entry *e = am_find(z, name);
    if (!e) return AM_ERR_IO;
    if (!buf) { *out_size = e->uncomp_size; return AM_OK; }
    if (*out_size < e->uncomp_size) { *out_size = e->uncomp_size; return AM_ERR_TRUNCATED; }
    if (e->local_off + 30 > z->size) return AM_ERR_TRUNCATED;
    const unsigned char *lh = z->data + e->local_off;
    if (!(lh[0] == 0x50 && lh[1] == 0x4b && lh[2] == 0x03 && lh[3] == 0x04)) return AM_ERR_FORMAT;
    const size_t nlen = rd16(lh + 26), elen = rd16(lh + 28);
    const size_t data_off = e->local_off + 30 + nlen + elen;
    if (data_off + e->comp_size > z->size) return AM_ERR_TRUNCATED;

    if (e->method == 0) {                                  /* stored */
        if (e->comp_size != e->uncomp_size) return AM_ERR_FORMAT;
        memcpy(buf, z->data + data_off, e->uncomp_size);
        *out_size = e->uncomp_size;
        return AM_OK;
    }
    if (e->method != 8) return AM_ERR_UNSUPPORTED;
    size_t got = 0;
    const int rc = am_inflate_raw(z->data + data_off, e->comp_size, (unsigned char *)buf,
                                  e->uncomp_size, &got);
    if (rc != AM_OK) return rc;
    if (got != e->uncomp_size) return AM_ERR_FORMAT;
    *out_size = got;
    return AM_OK;
}

int am_auto_read_alloc(const am_auto *z, const char *name, unsigned char **out, size_t *out_size)
{
    if (!out || !out_size) return AM_ERR_ARG;
    size_t need = 0;
    int rc = am_auto_read(z, name, NULL, &need);
    if (rc != AM_OK) return rc;
    unsigned char *buf = (unsigned char *)malloc(need ? need : 1);
    if (!buf) return AM_ERR_NOMEM;
    size_t cap = need;
    rc = am_auto_read(z, name, buf, &cap);
    if (rc != AM_OK) { free(buf); return rc; }
    *out = buf;
    *out_size = cap;
    return AM_OK;
}

/* ── PNG ────────────────────────────────────────────────────────────────── */
void am_gray_from_rgb(const unsigned char *src, int w, int h, int channels, unsigned char *out)
{
    const size_t n = (size_t)w * (size_t)h;
    for (size_t i = 0; i < n; i++) {
        const unsigned char *p = src + i * (size_t)channels;
        /* 与 OpenCV BGR2GRAY/BGRA2GRAY 相同的定点系数（R*77 + G*150 + B*29）>> 8 */
        out[i] = (unsigned char)(((unsigned)p[0] * 77 + (unsigned)p[1] * 150 +
                                  (unsigned)p[2] * 29) >> 8);
    }
}

int am_png_decode(const void *png, size_t size, int channels,
                  int *out_w, int *out_h, unsigned char *buf, size_t buf_size)
{
    static const unsigned char sig[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
    if (!png || size < 8 || (channels != 3 && channels != 4)) return AM_ERR_ARG;
    if (memcmp(png, sig, 8) != 0) return AM_ERR_FORMAT;

    const unsigned char *d = (const unsigned char *)png;
    size_t p = 8;
    int w = 0, h = 0, bitdepth = 0, colortype = -1, interlace = 0;
    int seen_ihdr = 0;
    unsigned char *idat = NULL;
    size_t idat_len = 0, idat_cap = 0;
    int rc = AM_OK;

    while (p + 8 <= size) {
        const size_t clen = rd32be(d + p);
        const char *ctype = (const char *)(d + p + 4);
        if (p + 12 + clen > size) { rc = AM_ERR_TRUNCATED; break; }
        const unsigned char *cdata = d + p + 8;

        if (memcmp(ctype, "IHDR", 4) == 0) {
            if (clen < 13) { rc = AM_ERR_FORMAT; break; }
            w = (int)rd32be(cdata);
            h = (int)rd32be(cdata + 4);
            bitdepth = cdata[8];
            colortype = cdata[9];
            interlace = cdata[12];
            seen_ihdr = 1;
        } else if (memcmp(ctype, "IDAT", 4) == 0) {
            if (idat_len + clen > idat_cap) {
                size_t ncap = idat_cap ? idat_cap * 2 : 65536;
                while (ncap < idat_len + clen) ncap *= 2;
                unsigned char *nb = (unsigned char *)realloc(idat, ncap);
                if (!nb) { rc = AM_ERR_NOMEM; break; }
                idat = nb; idat_cap = ncap;
            }
            memcpy(idat + idat_len, cdata, clen);
            idat_len += clen;
        } else if (memcmp(ctype, "IEND", 4) == 0) {
            break;
        }
        p += 12 + clen;
    }

    if (out_w) *out_w = w;
    if (out_h) *out_h = h;

    if (rc == AM_OK) {
        if (!seen_ihdr || w <= 0 || h <= 0) rc = AM_ERR_FORMAT;
        else if (bitdepth != 8) rc = AM_ERR_UNSUPPORTED;
        else if (colortype != 2 && colortype != 6) rc = AM_ERR_UNSUPPORTED;
        else if (interlace != 0) rc = AM_ERR_UNSUPPORTED;
        else if (buf && buf_size < (size_t)w * (size_t)h * (size_t)channels) rc = AM_ERR_TRUNCATED;
    }

    /* buf == NULL 时只需 IHDR 里的宽高：调用方常先问尺寸再分配像素缓冲。
     * （IDAT 只有在真要解码时才需要，所以这个分支必须在检查 idat 之前返回。） */
    if (buf == NULL) {
        free(idat);
        return rc;
    }
    if (rc == AM_OK && (!idat || idat_len == 0)) rc = AM_ERR_FORMAT;

    if (rc == AM_OK && buf) {
        const int src_ch = (colortype == 6) ? 4 : 3;
        const size_t stride = (size_t)w * (size_t)src_ch;
        const size_t raw_size = (stride + 1) * (size_t)h;
        unsigned char *raw = (unsigned char *)malloc(raw_size);
        if (!raw) rc = AM_ERR_NOMEM;
        else {
            size_t got = 0;
            rc = am_inflate_zlib(idat, idat_len, raw, raw_size, &got);
            if (rc == AM_OK && got < raw_size) rc = AM_ERR_TRUNCATED;
            if (rc == AM_OK) {
                unsigned char *prev = NULL;
                for (int y = 0; y < h; y++) {
                    unsigned char *row = raw + y * (stride + 1);
                    const int filter = row[0];
                    unsigned char *cur = row + 1;
                    switch (filter) {
                    case 0:
                        break;
                    case 1:
                        for (size_t i = (size_t)src_ch; i < stride; i++)
                            cur[i] = (unsigned char)(cur[i] + cur[i - src_ch]);
                        break;
                    case 2:
                        if (prev)
                            for (size_t i = 0; i < stride; i++)
                                cur[i] = (unsigned char)(cur[i] + prev[i]);
                        break;
                    case 3:
                        for (size_t i = 0; i < stride; i++) {
                            const int a = (i >= (size_t)src_ch) ? cur[i - src_ch] : 0;
                            const int b = prev ? prev[i] : 0;
                            cur[i] = (unsigned char)(cur[i] + ((a + b) >> 1));
                        }
                        break;
                    case 4:
                        for (size_t i = 0; i < stride; i++) {
                            const int a = (i >= (size_t)src_ch) ? cur[i - src_ch] : 0;
                            const int b = prev ? prev[i] : 0;
                            const int c = (prev && i >= (size_t)src_ch) ? prev[i - src_ch] : 0;
                            int pa = b - c, pb = a - c, pc = a + b - 2 * c;
                            if (pa < 0) pa = -pa;
                            if (pb < 0) pb = -pb;
                            if (pc < 0) pc = -pc;
                            const int pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                            cur[i] = (unsigned char)(cur[i] + pr);
                        }
                        break;
                    default:
                        rc = AM_ERR_FORMAT;
                        break;
                    }
                    if (rc != AM_OK) break;
                    prev = cur;
                }
                if (rc == AM_OK) {
                    /* 必须逐行拷：raw 每行开头有 1 字节 PNG filter 前缀，
                     * 线性 memcpy(raw+1, w*h*ch) 会把每行的 filter 字节挤进像素数据，
                     * 导致第 1 行之后整体错位 1 字节（本文件踩过这个坑）。 */
                    unsigned char *dst = buf;
                    for (int y = 0; y < h; y++) {
                        const unsigned char *s = raw + (size_t)y * (stride + 1) + 1;
                        if (src_ch == channels) {
                            memcpy(dst, s, (size_t)w * (size_t)channels);
                            dst += (size_t)w * (size_t)channels;
                        } else {
                            /* 需要去 alpha 或补 alpha：逐像素搬运前 channels 个通道 */
                            for (int x = 0; x < w; x++) {
                                for (int c = 0; c < channels; c++) *dst++ = s[c];
                                s += src_ch;
                            }
                        }
                    }
                }
            }
            free(raw);
        }
    }

    free(idat);
    return rc;
}

/* 只探测 PNG 尺寸（从 IHDR，不解压）。成功返回 0。
 * 有了它，调用方就不必为了问尺寸而伪造一个解码目标。 */
int am_png_size(const void *png, size_t size, int *out_w, int *out_h)
{
    if (!png || !out_w || !out_h) return AM_ERR_ARG;
    return am_png_decode(png, size, 3, out_w, out_h, NULL, 0);
}

int am_png_decode_gray(const void *png, size_t size, unsigned char *out, size_t out_size,
                       int *out_w, int *out_h)
{
    if (!png || !out || !out_w || !out_h) return AM_ERR_ARG;
    int w = 0, h = 0;
    int rc = am_png_decode(png, size, 3, &w, &h, NULL, 0);
    if (rc != AM_OK) return rc;
    if (out_size < (size_t)w * (size_t)h) return AM_ERR_TRUNCATED;

    const size_t rgb_size = (size_t)w * (size_t)h * 3;
    unsigned char *rgb = (unsigned char *)malloc(rgb_size);
    if (!rgb) return AM_ERR_NOMEM;
    rc = am_png_decode(png, size, 3, &w, &h, rgb, rgb_size);
    if (rc == AM_OK) am_gray_from_rgb(rgb, w, h, 3, out);
    free(rgb);
    if (rc == AM_OK) { *out_w = w; *out_h = h; }
    return rc;
}
