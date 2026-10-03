/* pg_guard.c —— 「页护栏分配器」：把 am_fft 的堆缓冲全部换成
 * 各自独占「整页对齐 + 页数取整」的 VirtualAlloc 块。
 *
 * 动机：本机没有 ASan 运行时（x64 的 clang_rt.asan* 不存在），
 * 也没有 gflags/pageheap 调试器，堆损坏只表现为随机位置的
 * STATUS_HEAP_CORRUPTION，无法定位。把每个缓冲单独放进按页取整的块里，
 * 越界读写就会**在发生的那一行**直接 AV 掉，而不是等到下次 malloc。
 *
 * 做法：编译 am_fft.c 时用 -Dmalloc=guard_malloc -Dfree=guard_free。
 *
 * ★ 元数据放在**独立数组**里，不放在数据块内部：
 *   第一版把 guard_hdr 塞在数据区前一页的尾部，结果自己的 free 就报了
 *   "bad header" —— 说明元数据也落在了会被越界写波及的范围里。
 *   元数据一旦和数据共享可写内存，它就不再是可信的裁判。
 */
#include <windows.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>

#define GUARD_MAGIC 0xC0FFEE01u
#define GUARD_TAIL  0xDEADBEEFu
#define GUARD_MAX   4096

typedef struct {
    unsigned magic;
    void    *base;
    unsigned char *user;
    size_t   user_size;
    size_t   data_bytes;
} gslot;

static gslot g_slots[GUARD_MAX];
static int   g_verbose = 0;

void guard_set_verbose(int on) { g_verbose = on; }

static gslot *slot_find(const void *user)
{
    for (int i = 0; i < GUARD_MAX; i++) {
        if (g_slots[i].magic == GUARD_MAGIC && g_slots[i].user == user) return &g_slots[i];
    }
    return NULL;
}

static gslot *slot_alloc(void)
{
    for (int i = 0; i < GUARD_MAX; i++) {
        if (g_slots[i].magic != GUARD_MAGIC) return &g_slots[i];
    }
    return NULL;
}

void *guard_malloc(size_t n)
{
    /* n == 0 is the init hook: commit nothing, and keep Low Fragmentation
     * Heap from being engaged by a zero-size request. */
    if (n == 0) return NULL;

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    const size_t page = si.dwPageSize;

    const size_t data_bytes = ((n + page - 1) / page) * page;
    const size_t total = page + data_bytes + page;   /* 前后各留一个不可访问页 */

    unsigned char *base = (unsigned char *)VirtualAlloc(NULL, total, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!base) return NULL;

    /* 把尾部那一页改成不可访问：越界写立刻 AV */
    DWORD old = 0;
    VirtualProtect(base + page + data_bytes, page, PAGE_NOACCESS, &old);

    gslot *s = slot_alloc();
    if (!s) { VirtualFree(base, 0, MEM_RELEASE); return NULL; }
    s->magic = GUARD_MAGIC;
    s->base = base;
    s->user = base + page;
    s->user_size = n;
    s->data_bytes = data_bytes;
    if (g_verbose) fprintf(stderr, "[guard] alloc %p size=%zu\n", (void *)s->user, n);

    /* 用户区填可识别图案 + 页内 canary */
    memset(s->user, 0xA5, n);
    if (data_bytes - n >= sizeof(unsigned)) {
        unsigned tail = GUARD_TAIL;
        memcpy(s->user + n, &tail, sizeof(tail));
    }

    /* NOTE: do NOT try to make the slack after the payload read-only.
     * VirtualProtect granularity is a whole PAGE, so protecting [user+n, page end)
     * also makes bytes [0, n) of this page read-only -- every legitimate in-bounds
     * write then faults. That experiment produced a very convincing false
     * diagnosis ("am_fft writes past the end of a 2-complex buffer") before being
     * noticed. The NOACCESS page after the region is the real boundary check;
     * this canary only reports, at free time, that some write went past. */
    return s->user;
}

void guard_free(void *p)
{
    if (!p) return;
    if (g_verbose) fprintf(stderr, "[guard] free  %p\n", p);

    gslot *s = slot_find(p);
    if (!s) {
        fprintf(stderr, "guard_free: %p was never returned by guard_malloc "
                        "(double free, or a pointer that is not a heap allocation)\n", p);
        fflush(stderr);
        abort();
    }

    /* 检查页内 canary（若数据大小正好是页的整数倍则没有 canary 位置，靠 NOACCESS 页兜底） */
    if (s->data_bytes - s->user_size >= sizeof(unsigned)) {
        unsigned tail = 0;
        memcpy(&tail, s->user + s->user_size, sizeof(tail));
        if (tail != GUARD_TAIL) {
            fprintf(stderr, "guard_free: TAIL CANARY CLOBBERED for %p (user_size=%zu) -- "
                            "someone wrote past the end\n", p, s->user_size);
            fflush(stderr);
            abort();
        }
    }

    void *base = s->base;
    s->magic = 0;
    s->user = NULL;
    VirtualFree(base, 0, MEM_RELEASE);
}
