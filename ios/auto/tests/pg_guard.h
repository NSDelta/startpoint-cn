/* pg_guard.h -- page-guard allocator, for CATCHING out-of-bounds heap writes.
 *
 * Why this exists: MSVC's AddressSanitizer is unusable on this machine (the
 * x64 clang_rt.asan* libraries are missing from the MSVC toolset), and there
 * is no gflags / pageheap / cdb. A heap overflow therefore shows up only as a
 * random access violation or heap-corruption abort, far from the offending line.
 *
 * This allocator gives every block its own VirtualAlloc region with an
 * inaccessible page immediately after the payload, so an out-of-bounds write
 * faults at the exact instruction that performs it.
 *
 * ---------------------------------------------------------------------------
 * HOW TO USE -- the naive way silently produces wrong results, so read this:
 *
 *   cl /Dmalloc=guard_malloc /Dfree=guard_free ^
 *      ... tests/pg_guard.c
 *
 * and in the source being debugged, at the VERY TOP (before <stdlib.h>):
 *
 *   #include "pg_guard.h"
 *
 * ---------------------------------------------------------------------------
 * Two traps, both of which cost real debugging time:
 *
 *  1. `-Dmalloc=guard_malloc` rewrites EVERY occurrence of the identifier
 *     `malloc`, including the declaration inside <stdlib.h>. Hence the
 *     include order above, and hence this header declares guard_malloc
 *     itself. If you include <stdlib.h> first, the declaration of malloc is
 *     rewritten to `int guard_malloc(size_t)`, the compiler assumes a 32-bit
 *     return, and THE 64-BIT POINTER IS TRUNCATED. That looks exactly like a
 *     memory-corruption bug and will send you hunting in the wrong place.
 *
 *  2. calloc() is NOT covered by the macros. If a translation unit allocates
 *     with calloc and frees through the intercepted free(), guard_free reports
 *     "was never returned by guard_malloc" -- which reads as corruption but is
 *     only a bookkeeping mismatch. Route calloc through a wrapper as well, or
 *     simply avoid calloc in code you are debugging.
 * ---------------------------------------------------------------------------
 *
 * Note: guard_malloc(0) is a no-op returning NULL, used as the init hook.
 */
#ifndef PG_GUARD_H
#define PG_GUARD_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void *guard_malloc(size_t n);
void  guard_free(void *p);

/* Emit "[guard] alloc/free" lines to stderr. Off by default: the trace is very
 * noisy and only useful when you specifically need the alloc/free pairing. */
void guard_set_verbose(int on);

#ifdef __cplusplus
}
#endif

/* Call once, as the first statement in main(). */
#define PG_GUARD_ENABLE() guard_malloc(0)

#endif /* PG_GUARD_H */
