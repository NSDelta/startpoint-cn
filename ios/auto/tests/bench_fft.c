/* bench_fft.c -- time an isolated 2-D forward transform at the sizes the matcher
 * actually pads to, so the matcher's cost can be attributed to the transform
 * rather than guessed at. */
#include "am_fft.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_ms(void)
{
    return (double)clock() * 1000.0 / (double)CLOCKS_PER_SEC;
}

static void run(int n1, int n2, int reps)
{
    const size_t total = (size_t)n1 * (size_t)n2;

    int shape[2];
    shape[0] = n1;
    shape[1] = n2;

    am_fft_plan *p = am_fft_plan_create(shape, 2);
    if (!p) {
        printf("  %4dx%-5d  plan REJECTED\n", n1, n2);
        return;
    }

    am_cplx *buf = (am_cplx *)malloc(AM_CPLX_BYTES(total));
    if (!buf) { printf("  alloc failed\n"); am_fft_plan_destroy(p); return; }

    /* deterministic content; value distribution does not affect timing */
    for (size_t i = 0; i < total; i++) {
        buf[2 * i]     = (double)((i * 37u) % 251u) - 125.0;
        buf[2 * i + 1] = 0.0;
    }

    /* one warm-up, then timed reps */
    am_fft_execute(p, buf, 0);

    const double t0 = now_ms();
    for (int r = 0; r < reps; r++) {
        am_fft_execute(p, buf, 0);
    }
    const double ms = (now_ms() - t0) / (double)reps;

    printf("  %4dx%-5d  %8.2f ms\n", n1, n2, ms);

    free(buf);
    am_fft_plan_destroy(p);
}

int main(void)
{
    printf("isolated 2-D forward FFT (desktop scalar C, /O2)\n\n");

    printf("power-of-two padding (what the matcher used to do):\n");
    run(1024, 1024, 3);
    run(1024, 512, 3);

    printf("\n5-smooth padding (what am_fft_next_fast_size picks now):\n");
    run(576, 648, 3);       /* 476x505 + 167x49 - 1 */
    run(384, 1024, 3);      /* 703x497 + 214x48 - 1 padding region */
    run(512, 576, 3);

    printf("\nreference points:\n");
    run(1080, 1920, 2);
    printf("\n  ^ 1080x1920 is itself 5-smooth. The power-of-two alternative\n");
    printf("    would be 2048x2048, i.e. 4x the elements -- run it to see which\n");
    printf("    wins, because mixed radix is slower PER ELEMENT:\n");
    run(2048, 2048, 1);

    return 0;
}
