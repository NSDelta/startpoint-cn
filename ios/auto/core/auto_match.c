/*
 * auto_match.c 鈥斺€?OpenCV TM_CCOEFF_NORMED 鐨勭瓑浠峰疄鐜帮紙绾?C99锛夈€? *
 * 鏁板锛堜笌 OpenCV modules/imgproc/src/templmatch.cpp 鐨?MatchTemplate_SIMD / CV_32F 璺緞涓€鑷达級锛? *   T' = T - mean(T),  I' = I - mean(I_window)
 *   R = 危(T'路I') / sqrt( 危T'虏 路 危I'虏 )
 *
 * 涓烘€ц兘鏀瑰啓鎴?鐢ㄥ師濮嬪拰琛ㄨ揪"锛岀粨鏋滃湪鏁板涓婃亽绛夛紙鎺ㄥ瑙佷笅锛夛細
 *   危T'虏      = 危T虏  - (危T)虏/N           锛堟ā鏉匡細鍙畻涓€娆★級
 *   危I'虏      = 危I虏  - (危I)虏/N           锛堟瘡涓獥鍙ｏ級
 *   危(T'路I') = 危T路I  - (危T)(危I)/N
 *
 * 鈽?鎬ц兘锛氫笁涓€愮獥鍙ｇ殑閲忓悇鏈?O(1) 涔冭嚦 O(N log N) 鐨勭畻娉曪紝缁濅笉鑳介€愪綅缃噸绠椼€? *   - 危I 涓?危I虏锛氭暣骞?ROI 鐨?*绉垎鍥?*锛堣涓诲簭鍚庣紑绱姞锛夛紝浠绘剰绐楀彛鍥涙鏌ヨ〃銆? *   - 危T路I锛?*FFT 浜掔浉鍏?*銆傛湸绱犳粦绐楁槸 O(鎼滅储鍖洪潰绉?脳 妯℃澘闈㈢Н)锛屽疄娴?1080x1920 甯т笂
 *           鍗曚釜 167x49 妯℃澘瑕?20.5 s銆? 涓ā鏉垮悎璁?142 s/甯э紝鑰?.auto 鐨?loop_interval
 *           鏄?30 ms 鈥斺€?宸?4748 鍊嶃€傜敤 FFT 鍗风Н鍚庢槸 O(pad 闈㈢Н 路 log(pad 闈㈢Н))銆? *   娉ㄦ剰 危I虏 鐢ㄧН鍒嗗浘鑰屼笉鏄?FFT锛氶浂濉厖鐨勫惊鐜嵎绉細姹℃煋杈圭紭绐楀彛锛岃€?危I虏 鐨勭Н鍒嗗浘褰㈠紡
 *   瀵?*浠绘剰**绐楀彛閮界簿纭紝杩樼渷鎺変竴娆?FFT銆? *
 * 鏁板€肩邯寰嬶細绱姞涓€寰嬬敤 double銆侳FT 鍓嶆妸 ROI 鍑忓幓鍏跺叏灞€鍧囧€硷紙鍙槸骞崇Щ锛? * 危(T'路I') 瀵?I 鐨勫叏灞€骞崇Щ涓嶆晱鎰燂級锛岃繖鏍烽浂濉厖鍚庣殑鏁板€煎箙搴︿繚鎸佸湪 卤255 閲忕骇锛? * double 鐨勭簿搴︿綑閲忔瀬澶с€傚鍚屾牱鐨勫儚绱犺緭鍏ワ紝鏈疄鐜颁笌 OpenCV 鐨?float 缁撴灉鍦?1e-9
 * 閲忕骇鍐呬竴鑷达紝瓒充互鍒ゅ畾 0.8 杩欑闃堝€笺€? */
#include "auto_match.h"
#include "am_fft.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* OpenCV 鍦ㄥ垎姣嶄笂鐨勪繚鎶わ細鍒嗘瘝寮€鏂瑰悗鑻?<= DBL_EPSILON 鍒欐寜 1 澶勭悊锛堢粨鏋滆 0锛?*/
#define AM_EPS 2.2204460492503131e-16

static int am_stride(const am_gray *g) { return g->stride > 0 ? g->stride : g->width; }

/*
 * OpenCV TM_CCOEFF_NORMED 鎵撳垎鍑芥暟锛屽彲瀵瑰凡鍦ㄥ埆澶勭畻濂界粺璁￠噺鐨勮皟鐢ㄦ柟澶嶇敤锛坕OS 渚?vDSP 璺緞锛夈€? *   n          = 妯℃澘鍍忕礌鏁? *   sumT, sumT2= 妯℃澘鐏板害鍜?/ 鐏板害鍜屽钩鏂? *   sumI, sumI2= 绐楀彛鐏板害鍜?/ 绐楀彛鐏板害鍜屽钩鏂? *   dot        = 危 T*I
 * 杩斿洖 [0,1]锛堣礋鐩稿叧涓庨櫎闆朵竴寰?0锛夈€? *
 * 鍐呴儴涓诲惊鐜笉璋冪敤瀹冿紙閭ｆ潯璺緞鐢ㄤ腑蹇冨寲浜掔浉鍏?+ 绉垎鍥撅紝褰㈠紡鏇寸渷锛夛紝浣嗕繚鎸佷袱鑰呮暟瀛︾瓑浠凤細
 *   dot_centered = 危(T'路I') = dot - sumT*sumI/n
 *   num          = n*dot - sumT*sumI = n * dot_centered
 * 鑰屼笅闈㈢敤鐨勬槸 num/(n*den) = dot_centered/den锛屽畬鍏ㄤ竴鑷淬€? */
double am_ncc_score(double n, double sumT, double sumT2,
                    double sumI, double sumI2, double dot)
{
    if (n <= 0.0) return 0.0;

    /* num = N路危(T路I) - 危T路危I = N虏路危(T'路I')  锛堟鐨勫叕鍏卞洜瀛?N虏 涓嶆敼鍙樻璐熷彿锛屾渶鍚庣粺涓€闄ゆ帀锛?*/
    const double num = n * dot - sumT * sumI;

    /* 妯℃澘鏂瑰樊椤癸紙甯搁噺锛岃皟鐢ㄦ柟鍙紦瀛橈紱姝ゅ浠嶉噸绠椾互淇濊瘉鍗曠偣鍙祴锛?*/
    double var_t = sumT2 - (sumT * sumT) / n;
    double var_i = sumI2 - (sumI * sumI) / n;
    if (var_t < 0.0) var_t = 0.0;   /* 娴偣娈嬪樊鍙兘鍘嬪嚭鏋佸皬璐熸暟 */
    if (var_i < 0.0) var_i = 0.0;

    const double den = sqrt(var_t) * sqrt(var_i);
    if (den <= AM_EPS) return 0.0;  /* 甯稿€肩獥鍙?甯搁噺妯℃澘锛歄penCV 缁撴灉闈炴锛岀粺涓€璁?0 */

    const double r = num / (n * den);
    if (!(r > 0.0)) return 0.0;     /* NaN / -inf / 璐熺浉鍏?涓€寰?0锛屽榻?Android 鐨?max(maxVal, 0.0) */
    return r > 1.0 ? 1.0 : r;       /* 娴偣娈嬪樊鍙兘鐣ヨ秴 1 */
}

/* ---------- FFT 宸ヤ綔鍖猴紙鎸?pad 灏哄涓庢ā鏉跨紦瀛橈級 ---------- */

typedef struct {
    int ready;
    int pw, ph;                 /* 闆跺～鍏呭悗鐨勫昂瀵?*/
    int rw, rh;                 /* ROI 灏哄 */
    int tw, th;                 /* 妯℃澘灏哄 */
    am_fft_plan *plan;          /* pw x ph */
    am_cplx *tpl_freq;          /* FFT(妯℃澘涓績鍖栧悗锛岄浂濉厖) */
    am_cplx *roi_freq;          /* FFT(ROI 涓績鍖栧悗锛岄浂濉厖) */
    am_cplx *prod;              /* roi_freq .* tpl_freq */
    double *ii, *ii2;           /* ROI 鐨勭Н鍒嗗浘锛堝昂瀵?(rw+1) x (rh+1)锛?*/
    double mean_t;              /* 妯℃澘鍧囧€?*/
    /* The cached spectra and scratch buffers are only valid for the EXACT
     * roi/tpl that produced them, so keep a copy of each and compare on every
     * call. Dimensions alone are NOT an identity: two templates of the same
     * size are the normal case in a .auto script (every button crop is a
     * different image), and reusing one template's spectrum for the other
     * silently returns a plausible-looking wrong score. */
    double tpl_mean;            /* sum(T)/n of the cached template, a cheap first check */
    unsigned char *roi_copy;    /* packed at rw stride */
    unsigned char *tpl_copy;    /* packed at tw stride */
} am_match_ctx;

static am_match_ctx g_ctx;

static void ctx_free(am_match_ctx *c)
{
    if (c->plan) am_fft_plan_destroy(c->plan);
    free(c->tpl_freq);
    free(c->roi_freq);
    free(c->prod);
    free(c->ii);
    free(c->ii2);
    free(c->roi_copy);
    free(c->tpl_copy);
    memset(c, 0, sizeof(*c));
}

/* Both sides are packed at the template's own stride, so a plain byte compare
 * is enough. */
static int tpl_same(const am_match_ctx *c, const am_gray *tpl)
{
    return c->tpl_copy
        && am_stride(tpl) == c->tw
        && memcmp(c->tpl_copy, tpl->data, (size_t)c->tw * (size_t)c->th) == 0;
}

static int roi_same(const am_match_ctx *c, const am_gray *roi)
{
    return c->roi_copy
        && am_stride(roi) == c->rw
        && memcmp(c->roi_copy, roi->data, (size_t)c->rw * (size_t)c->rh) == 0;
}

/* 璁?ctx 閫傞厤缁欏畾鐨?roi/tpl 灏哄锛涘昂瀵告垨妯℃澘鍐呭鍙樺寲鏃堕噸寤恒€?*/
static int ctx_prepare(am_match_ctx *c, const am_gray *roi, const am_gray *tpl,
                       int pw, int ph)
{
    const int tw = tpl->width, th = tpl->height;
    const int rw = roi->width, rh = roi->height;

    if (c->ready && c->pw == pw && c->ph == ph &&
        c->rw == rw && c->rh == rh && c->tw == tw && c->th == th &&
        tpl_same(c, tpl) && roi_same(c, roi)) {
        return 1;                       /* 鍚ā鏉块鍩熺紦瀛橈紝鐩存帴澶嶇敤 */
    }

    ctx_free(c);

    int shape[2];
    shape[0] = ph;                      /* 琛屼富搴忥細shape[0] 鏈€鎱?*/
    shape[1] = pw;
    c->plan = am_fft_plan_create(shape, 2);
    if (!c->plan) return 0;

    c->tpl_freq = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)pw * ph));
    c->roi_freq = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)pw * ph));
    c->prod     = (am_cplx *)malloc(AM_CPLX_BYTES((size_t)pw * ph));
    c->ii       = (double *)malloc(sizeof(double) * (size_t)(rw + 1) * (rh + 1));
    c->ii2      = (double *)malloc(sizeof(double) * (size_t)(rw + 1) * (rh + 1));
    c->roi_copy = (unsigned char *)malloc((size_t)rw * (size_t)rh);
    c->tpl_copy = (unsigned char *)malloc((size_t)tw * (size_t)th);
    if (!c->tpl_freq || !c->roi_freq || !c->prod || !c->ii || !c->ii2 ||
        !c->roi_copy || !c->tpl_copy) {
        ctx_free(c);
        return 0;
    }

    c->pw = pw; c->ph = ph;
    c->rw = rw; c->rh = rh;
    c->tw = tw; c->th = th;

    /* --- 妯℃澘锛氫腑蹇冨寲 + 闆跺～鍏?+ 鍓嶇疆 FFT --- */
    {
        double sumT = 0.0;
        for (int y = 0; y < th; y++) {
            const unsigned char *row = tpl->data + (size_t)y * am_stride(tpl);
            unsigned char *pack = c->tpl_copy + (size_t)y * (size_t)tw;
            for (int x = 0; x < tw; x++) { sumT += (double)row[x]; pack[x] = row[x]; }
        }
        c->mean_t = sumT / ((double)tw * (double)th);
        c->tpl_mean = c->mean_t;        /* so a cache hit keeps the key valid */
    }
    /* The ROI half of the key is packed the same way, so the cached roi_freq is
     * reused only when the next call really sees the same pixels. */
    for (int y = 0; y < rh; y++) {
        memcpy(c->roi_copy + (size_t)y * (size_t)rw,
               roi->data + (size_t)y * am_stride(roi), (size_t)rw);
    }
    memset(c->tpl_freq, 0, AM_CPLX_BYTES((size_t)pw * ph));
    for (int y = 0; y < th; y++) {
        const unsigned char *row = tpl->data + (size_t)y * am_stride(tpl);
        am_cplx *dst = c->tpl_freq + 2 * (size_t)y * (size_t)pw;
        for (int x = 0; x < tw; x++) {
            dst[2 * x] = (double)row[x] - c->mean_t;
        }
    }
    if (am_fft_execute(c->plan, c->tpl_freq, 0) != 0) { ctx_free(c); return 0; }

    c->ready = 1;
    return 1;
}

/* 绱姞鏁村箙 ROI 鐨?危I / 危I虏 绉垎鍥撅紙(rw+1) x (rh+1)锛岄琛岄鍒椾负 0锛夈€?*/
static void build_integral(am_match_ctx *c, const am_gray *roi)
{
    const int rw = c->rw, rh = c->rh;
    const int rs = am_stride(roi);

    for (int x = 0; x <= rw; x++) { c->ii[x] = 0.0; c->ii2[x] = 0.0; }

    for (int y = 0; y < rh; y++) {
        const unsigned char *row = roi->data + (size_t)y * rs;
        const double *prev = c->ii + (size_t)y * (rw + 1);
        const double *prev2 = c->ii2 + (size_t)y * (rw + 1);
        double *cur = c->ii + (size_t)(y + 1) * (rw + 1);
        double *cur2 = c->ii2 + (size_t)(y + 1) * (rw + 1);
        double acc = 0.0, acc2 = 0.0;
        cur[0] = 0.0; cur2[0] = 0.0;
        for (int x = 0; x < rw; x++) {
            const double v = (double)row[x];
            acc += v;  acc2 += v * v;
            cur[x + 1]  = prev[x + 1] + acc;
            cur2[x + 1] = prev2[x + 1] + acc2;
        }
    }
}

/*
 * 绛変环鐨?matchTemplate + minMaxLoc銆? * 杩斿洖 1 琛ㄧず绠楀嚭浜嗙粨鏋滐紙妯℃澘鑳芥斁杩涙悳绱㈠尯锛夛紝0 琛ㄧず鏀句笉涓嬶紙Android 渚ф鏃剁洿鎺ユ斁寮冭鎼滅储鍖猴級銆? * degenerate锛堟ā鏉挎柟宸负 0锛屼緥濡傜函鑹叉ā鏉匡級鏃舵寜 OpenCV 琛屼负锛氬垎姣?~0 鈫?peak 璁?0锛堣涓轰笉鍖归厤锛夈€? */
int am_match_template(const am_gray *roi, const am_gray *tpl, am_match_result *out)
{
    if (!roi || !tpl || !out) return 0;
    memset(out, 0, sizeof(*out));

    const int tw = tpl->width, th = tpl->height;
    const int rw = roi->width, rh = roi->height;
    if (tw <= 0 || th <= 0 || rw < tw || rh < th) return 0;  /* Android 渚э細妯℃澘姣旀悳绱㈠尯澶?鈫?鏀惧純 */

    const double n = (double)tw * (double)th;

    out->w = tw;
    out->h = th;

    /* --- 妯℃澘缁熻閲?--- */
    double sumT = 0.0, sumT2 = 0.0;
    for (int y = 0; y < th; y++) {
        const unsigned char *row = tpl->data + (size_t)y * am_stride(tpl);
        for (int x = 0; x < tw; x++) {
            const double v = (double)row[x];
            sumT += v;
            sumT2 += v * v;
        }
    }
    const double var_t = sumT2 - (sumT * sumT) / n;
    if (var_t <= AM_EPS) {
        /* 甯搁噺妯℃澘锛歄penCV 鐨?NCC 鎭掍负 0锛堝垎姣?0锛夈€備粛杩斿洖"绠楄繃"锛屽嘲鍊?0銆?*/
        out->found = 1;
        out->peak = 0.0;
        out->x = out->y = 0;
        return 1;
    }
    const double sqrt_var_t = sqrt(var_t);

    /* --- 鍗风Н鎵€闇€鐨勯浂濉厖灏哄锛氳嚦灏?rw+tw-1 / rh+th-1锛屼笖蹇呴』 5-smooth --- */
    int pw = am_fft_next_fast_size(rw + tw - 1);
    int ph = am_fft_next_fast_size(rh + th - 1);
    if (pw <= 0 || ph <= 0) return 0;

    /* --- 宸ヤ綔鍖?--- */
    if (!ctx_prepare(&g_ctx, roi, tpl, pw, ph)) {
        ctx_free(&g_ctx);
        return 0;                       /* 鍒嗛厤澶辫触锛氫氦鐢辫皟鐢ㄦ柟闄嶇骇 */
    }
    am_match_ctx *c = &g_ctx;
    c->tpl_mean = sumT / n;             /* the key that ctx_prepare compares next time */

    /* --- ROI锛氫腑蹇冨寲 + 闆跺～鍏?+ FFT ---
     * 鍑忓幓 ROI 鐨勫叏灞€鍧囧€煎彧鏄钩绉伙紝浜掔浉鍏冲 I 鐨勫叏灞€骞崇Щ涓嶅彉锛堟ā鏉垮凡涓績鍖栵級锛?     * 浣嗚兘璁╁～鍏呭尯鍩熺殑鏁板€煎箙搴︾淮鎸佸湪 卤255锛宒ouble 绮惧害浣欓噺鏋佸ぇ銆?*/
    {
        double sumI_all = 0.0;
        for (int y = 0; y < rh; y++) {
            const unsigned char *row = roi->data + (size_t)y * am_stride(roi);
            for (int x = 0; x < rw; x++) sumI_all += (double)row[x];
        }
        const double m = sumI_all / ((double)rw * (double)rh);

        memset(c->roi_freq, 0, AM_CPLX_BYTES((size_t)pw * ph));
        for (int y = 0; y < rh; y++) {
            const unsigned char *row = roi->data + (size_t)y * am_stride(roi);
            am_cplx *dst = c->roi_freq + 2 * (size_t)y * (size_t)pw;
            for (int x = 0; x < rw; x++) dst[2 * x] = (double)row[x] - m;
        }
    }
    if (am_fft_execute(c->plan, c->roi_freq, 0) != 0) return 0;

    /* --- frequency-domain product, then inverse transform -> circular cross-correlation ---
     *
     * The cross-correlation
     *     corr[o] = sum_m A[o+m] * B[m]
     * is the correlation theorem's
     *     corr = IFFT( FFT(A) .* conj(FFT(B)) )
     * -- note the CONJUGATE on B. Multiplying by FFT(B) directly gives the
     * circular convolution, sum_m A[o-m]*B[m], which is a different operation:
     * it reproduces the correct answer only at lag 0, and that is exactly why a
     * symmetric test template hid this for a while. The two agree only when B is
     * symmetric about its centre.
     *
     * Real inputs, so conjugating B's spectrum is just negating its imaginary
     * part. */
    {
        const size_t total = (size_t)pw * (size_t)ph;
        for (size_t i = 0; i < total; i++) {
            const double ar = c->roi_freq[2 * i], ai = c->roi_freq[2 * i + 1];
            const double br = c->tpl_freq[2 * i], bi = -c->tpl_freq[2 * i + 1];
            c->prod[2 * i]     = ar * br - ai * bi;
            c->prod[2 * i + 1] = ar * bi + ai * br;
        }
    }
    if (am_fft_execute(c->plan, c->prod, 1) != 0) return 0;

    /* --- 危I / 危I虏 绉垎鍥?--- */
    build_integral(c, roi);

    /* --- 閫愪綅缃墦鍒?--- */
    const int max_x = rw - tw, max_y = rh - th;
    const int w1 = rw + 1;
    double best = -1.0;
    int best_x = 0, best_y = 0;

    for (int oy = 0; oy <= max_y; oy++) {
        const double *top  = c->ii  + (size_t)oy * w1;
        const double *bot  = c->ii  + (size_t)(oy + th) * w1;
        const double *top2 = c->ii2 + (size_t)oy * w1;
        const double *bot2 = c->ii2 + (size_t)(oy + th) * w1;
        const am_cplx *corr = c->prod + 2 * (size_t)oy * (size_t)pw;

        for (int ox = 0; ox <= max_x; ox++) {
            const double sumI  = bot[ox + tw]  - bot[ox]  - top[ox + tw]  + top[ox];
            const double sumI2 = bot2[ox + tw] - bot2[ox] - top2[ox + tw] + top2[ox];

            /* corr[ox] 鏄?危(I - meanI)*(T - meanT) 鐨勫疄閮紱閫嗗彉鎹㈠凡闄よ繃 pw*ph */
            const double dot_centered = corr[2 * ox];

            double var_i = sumI2 - (sumI * sumI) / n;
            if (var_i < 0.0) var_i = 0.0;       /* 娴偣娈嬪樊鍙兘鍘嬪嚭鏋佸皬璐熸暟 */

            double r = 0.0;
            const double den = sqrt_var_t * sqrt(var_i);
            if (den > AM_EPS) {
                r = dot_centered / den;
                if (!(r > 0.0)) r = 0.0;        /* NaN / 璐熺浉鍏?鈫?0锛屽榻?max(maxVal,0) */
                else if (r > 1.0) r = 1.0;      /* 娴偣娈嬪樊鍙兘鐣ヨ秴 1 */
            }
            if (r > best) { best = r; best_x = ox; best_y = oy; }
        }
    }

    out->found = 1;
    out->peak = best > 0.0 ? best : 0.0;
    out->x = best_x;
    out->y = best_y;
    return 1;
}

int am_match_template_multi(const am_gray *roi, const am_gray *tpl, double threshold,
                            am_match_result *hits, int max_hits)
{
    if (!roi || !tpl || !hits || max_hits <= 0) return 0;
    if (roi->width < tpl->width || roi->height < tpl->height) return 0;

    /* 澶嶅埗涓€浠?search 鍖猴紝鍛戒腑鍚庢竻闆讹紱Android 渚ф槸瀵?result 鐭╅樀鍋氬悓鏍风殑浜嬨€?*/
    const int rw = roi->width, rh = roi->height;
    const int rs = am_stride(roi);
    unsigned char *buf = (unsigned char *)malloc((size_t)rw * (size_t)rh);
    if (!buf) return 0;
    for (int y = 0; y < rh; y++) {
        memcpy(buf + (size_t)y * rw, roi->data + (size_t)y * rs, (size_t)rw);
    }

    am_gray work = { buf, rw, rh, rw };
    int n = 0;
    while (n < max_hits) {
        am_match_result r;
        if (!am_match_template(&work, tpl, &r)) break;
        if (r.peak < threshold) break;
        hits[n++] = r;
        /* 鍛戒腑鍖哄煙鍥涘懆 卤妯℃澘瀹介珮娓呴浂锛堜笌 Android base/c.java:103-159 涓€鑷达級 */
        const int x0 = r.x - tpl->width, x1 = r.x + tpl->width * 2;
        const int y0 = r.y - tpl->height, y1 = r.y + tpl->height * 2;
        for (int y = y0 < 0 ? 0 : y0; y < y1 && y < rh; y++) {
            unsigned char *row = buf + (size_t)y * rw;
            for (int x = x0 < 0 ? 0 : x0; x < x1 && x < rw; x++) row[x] = 0;
        }
    }
    free(buf);
    return n;
}


/* ---------- am_mat helpers ---------- *
 * The template cache in auto_script owns its pixels, so it needs the owning form.
 * am_gray is a non-owning view; these two bridge the pair and are the only place
 * that knows an am_mat's stride convention. */

am_gray am_mat_view(const am_mat *m)
{
    am_gray g;
    g.data   = m ? m->pixels : NULL;
    g.width  = m ? m->width  : 0;
    g.height = m ? m->height : 0;
    g.stride = m ? m->stride : 0;
    return g;
}

void am_mat_free(am_mat *m)
{
    if (!m) return;
    free(m->pixels);
    m->pixels = NULL;
    m->width = m->height = m->stride = 0;
}
