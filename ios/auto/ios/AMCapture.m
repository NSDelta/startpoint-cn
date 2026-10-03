//
//  AMCapture.m —— 取帧实现
//
//  设计约束（来自 .research/ios-design.md §5 与 .research/ios-touch-synthesis.md）：
//
//  1. worldflipper 是 AIR + OpenGL ES2 + Stage3D。UIView 层里没有画面，
//     drawViewHierarchyInRect: 对 GL 内容会给出黑帧。所以主路是 hook
//     -[EAGLContext presentRenderbuffer:] 之后在**默认 framebuffer** 上 glReadPixels。
//  2. glReadPixels 是同步的、会把 GPU 管线排空，所以必须在**渲染线程**上读、
//     而且只读我们要的那么大（目标灰度尺寸），不要先读全分辨率再降采样 ——
//     全分辨率 1080x1920 RGBA 是 8.3 MB/帧，30ms 一帧就是 277 MB/s 的 PCIe 流量。
//     这里先读全帧是因为 glReadPixels 不能跨行抽取（pack 参数只能是 1..8 且
//     要求 PACK 对齐），所以折中是：**只读一次全帧，在 CPU 上做最近邻降采样**，
//     然后把全帧缓冲留着复用（同一块内存，不每帧 malloc）。
//  3. 交付格式是 8 位灰度、行距 = 宽。灰度公式必须与 OpenCV/Android 完全一致：
//         (R*77 + G*150 + B*29) >> 8
//     这是定点、向下取整、**不四舍五入**。core/am_container.c 的 am_png_decode_gray
//     用同一个公式，所以模板与帧必然同源。
//  4. GL 的原点在**左下**，帧的原点在**左上** —— 读回来要垂直翻转，
//     否则匹配会在垂直方向镜像，症状是「分数不高但位置看起来差不多」。
//     翻转在降采样循环里顺手做（row = (srcH - 1 - y*step)），不额外拷一趟。
//
//  线程模型：presentRenderbuffer 在渲染线程/主线程被调用；引擎在别的线程跑。
//  gLock 保护「最新一帧」的那块缓冲；统计字段用原子自增，避免为了几个计数上锁。
//

#import "AMCapture.h"

/* 本文件是整个平台层里**唯一**直接使用 OpenGL ES 的地方（游戏是 AIR + Stage3D，
   上屏路径就是 EAGL），而 OpenGL ES 从 iOS 12 起被整体标记为 deprecated。
   Theos 在 Debug 构建下带 -Werror，于是每一条 GL 调用都会把构建打红：
       error: 'glBindRenderbuffer' is deprecated: first deprecated in iOS 12.0 -
              OpenGLES API deprecated. [-Werror,-Wdeprecated-declarations]
   这里按文件关掉这一类警告 —— 只在**本文件**范围内生效（push/pop 覆盖到文件末尾，
   因为下面所有 @implementation 都在 push 之后），比在 Makefile 里全局
   -DGLES_SILENCE_DEPRECATION 更精确：别的文件将来用到废弃 API 仍然会被拦下。 */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

/* UIKit 要在 OpenGLES 之前 —— 否则依赖 GL 头里的类型也没问题，但保持与
   AMCapture.h 的 @class UIImage 前向声明相对：**那个前向声明盖不过类方法调用**
   （[UIImage imageWithCGImage:] 在 -previewImage 里），必须真的 import
   UIKit。这一条也是第一次真实 iOS 编译才暴露的。 */
#import <UIKit/UIKit.h>

#import <objc/runtime.h>
#import <objc/message.h>
#import <OpenGLES/ES2/gl.h>
#import <OpenGLES/ES2/glext.h>
#import <OpenGLES/EAGL.h>
#import <OpenGLES/EAGLDrawable.h>
#import <QuartzCore/QuartzCore.h>
#import <os/lock.h>
#import <os/atomic.h>
#import <mach/mach_time.h>


#pragma mark - EAGLContext 私有能力

// -[EAGLContext presentRenderbuffer:] 是**公开**方法（EAGL.h 里有声明），
// 所以不需要运行时消息转发，直接 hook 即可。
//
// 但「当前 renderbuffer 的宽高」早期有人想通过 -[EAGLContext renderbufferStorage:fromDrawable:]
// 的入参、或 -[EAGLContext drawableProperties] 间接去猜 —— 那需要私有 selector，**不可靠**。
// 本实现改成直接问 GL：视口 + 当前绑定的 renderbuffer 尺寸（见下面两个函数）。

/// 当前绑定的 renderbuffer 的像素尺寸。
/// 为什么除了视口还要问它：hook 挂在 `presentRenderbuffer:` 上，而**present 之前**
/// 当前绑定的 framebuffer 未必等于「即将上屏的那个」。AIR/Stage3D 完全可能把整屏渲到
/// 一个离屏 renderbuffer 再缩放上屏；此时视口是离屏的尺寸，而窗口的点宽对应的是别的
/// 尺寸 ⇒ 触摸坐标的换算系数就会整体偏掉（15% 级别的偏差正是「点偏了但方向对」的典型症状）。
/// 同时记下两者，取帧尺寸才能与换算系数同源。
static BOOL AMGLRenderbufferSize(GLint *outW, GLint *outH)
{
    if (!outW || !outH) return NO;
    *outW = 0; *outH = 0;

    GLint prev = 0;
    glGetIntegerv(GL_RENDERBUFFER_BINDING, &prev);
    while (glGetError() != GL_NO_ERROR) { }      // glGetIntegerv 会清错，先清干净再问

    GLint w = 0, h = 0;
    glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH,  &w);
    glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_HEIGHT, &h);
    while (glGetError() != GL_NO_ERROR) { }

    if (prev != 0) glBindRenderbuffer(GL_RENDERBUFFER, (GLuint)prev);   // 别把别人的绑定改掉

    if (prev == 0 || w <= 0 || h <= 0) return NO;   // 0 号 renderbuffer 不是合法对象
    *outW = w; *outH = h;
    return YES;
}

// 视口 = 本次绘制的可绘制区域。如果视口比实际 framebuffer 小（有黑边），读到的是
// 子矩形，此时**以视口为准**是对的：黑边不该参与匹配。
static BOOL AMGLViewport(GLint *outX, GLint *outY, GLint *outW, GLint *outH)
{
    GLint vp[4] = { 0, 0, 0, 0 };
    glGetIntegerv(GL_VIEWPORT, vp);
    if (vp[2] <= 0 || vp[3] <= 0) return NO;

    // glGetIntegerv 会把当前的 GL 错误清掉，所以这里要先把之前的错误读干净，
    // 免得把别人的错误吞了。
    while (glGetError() != GL_NO_ERROR) { }

    // 视口比 renderbuffer 大是不可能的（GL 会报错），所以只要 renderbuffer 尺寸
    // 与视口不一致，就一定是在渲一个子矩形或另一个 framebuffer。
    // 判定：renderbuffer 已知且**不大于**视口 ⇒ 以 renderbuffer 为准（它才是会上屏的东西）；
    // 否则退回视口（宁可相信黑边不应参与匹配）。
    GLint rw = 0, rh = 0;
    if (AMGLRenderbufferSize(&rw, &rh) && rw <= vp[2] && rh <= vp[3] &&
        (rw != vp[2] || rh != vp[3])) {
        vp[2] = rw;
        vp[3] = rh;
        if (vp[0] + vp[2] > rw) vp[0] = 0;
        if (vp[1] + vp[3] > rh) vp[1] = 0;
    }

    if (outX) *outX = vp[0];
    if (outY) *outY = vp[1];
    if (outW) *outW = vp[2];
    if (outH) *outH = vp[3];
    return YES;
}

#pragma mark - 内部状态

static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

/// 最新一帧（8 位灰度紧缩）。gLock 保护。
static unsigned char *gFrame;
static size_t         gFrameCap;      ///< 已分配字节数
static int            gFrameW, gFrameH;

/// 是否已经被取走（用来统计 dropped：渲染比消费快时不断覆盖同一块内存，
/// 引擎可能永远看不到中间那些帧 —— 这个计数让「实际帧率远低于渲染帧率」变得可见）。
static BOOL           gFrameFresh;

/// glReadPixels 的暂存缓冲。只有渲染线程碰它，所以不需要锁。
static unsigned char *gReadBuf;
static size_t         gReadCap;

static AMCaptureBackend gBackend;
static unsigned long long gPresentCalls;
static unsigned long long gFrames;
static unsigned long long gDropped;
static double             gLastReadMs, gMaxReadMs;
static double             gLastGLReadMs, gLastDownsampleMs;
static unsigned long long gReadSkips;
static double             gMinReadIntervalMs = 30.0;   // 见 AMCaptureReadFromGL 里的说明
static double             gLastReadAt;                  // 上次真正读取的时刻（单调毫秒）

static double AMNowMs(void)
{
    static mach_timebase_info_data_t tb;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ mach_timebase_info(&tb); });
    const uint64_t t = mach_absolute_time();
    // numer/denom 在 Apple Silicon 上是 125/3，在 Intel 上是 1/1 —— 不能假设 1/1。
    return (double)t * (double)tb.numer / (double)tb.denom / 1e6;
}

#pragma mark - 降采样

/// 把 RGBA 源图（左上原点）最近邻降采样成灰度。
/// 源图是**右上原点**（GL），所以 srcRow = srcH - 1 - y*step 完成翻转。
static void AMDownsampleRGBAtoGray(const unsigned char *src, int srcW, int srcH,
                                   int comps, BOOL flipY,
                                   unsigned char *dst, int dstW, int dstH)
{
    for (int y = 0; y < dstH; y++) {
        int sy = (int)(((long long)y * srcH) / dstH);
        if (sy >= srcH) sy = srcH - 1;
        if (flipY) sy = srcH - 1 - sy;
        const unsigned char *srow = src + (size_t)sy * (size_t)srcW * (size_t)comps;
        unsigned char *drow = dst + (size_t)y * (size_t)dstW;
        for (int x = 0; x < dstW; x++) {
            int sx = (int)(((long long)x * srcW) / dstW);
            if (sx >= srcW) sx = srcW - 1;
            const unsigned char *p = srow + (size_t)sx * (size_t)comps;
            unsigned int r, g, b;
            if (comps == 4) {          // GL_RGBA / kCVPixelFormatType_32RGBA
                r = p[0]; g = p[1]; b = p[2];
            } else {                   // kCVPixelFormatType_32BGRA
                b = p[0]; g = p[1]; r = p[2];
            }
            // OpenCV 的定点灰度：向下取整，不四舍五入。
            // 与 core/am_container.c 的 am_png_decode_gray 必须逐位一致。
            drow[x] = (unsigned char)((r * 77u + g * 150u + b * 29u) >> 8);
        }
    }
}

#pragma mark - hook 实现

static void AMCaptureStoreGray(const unsigned char *gray, int w, int h);

/* presentRenderbuffer 的调用计数。在这里（文件的中前部）定义，而不是像原来那样放在
   文件末尾 —— 末尾定义会在调用点之前形成隐式声明，C99 起不再允许：
       error: call to undeclared function 'AMCaptureNotePresent'
       error: conflicting types for 'AMCaptureNotePresent'   （定义处）
   放在调用点之前就一次都不用写原型（写了反而可能与定义重复）。
   加 static：它只被本文件的 hook 用，头文件里也不导出，没有理由给外部链接名。 */
static void AMCaptureNotePresent(void)
{
    __atomic_fetch_add(&gPresentCalls, 1ull, __ATOMIC_RELAXED);
}

/// 从当前绑定的 GL 状态读一帧。**必须在渲染线程调用**（或至少是持有当前 EAGLContext 的线程）。
static void AMCaptureReadFromGL(void)
{
    GLint vx = 0, vy = 0, vw = 0, vh = 0;
    if (!AMGLViewport(&vx, &vy, &vw, &vh)) return;

    //
    // 时间节流：游戏可能以 60/120 Hz 调 presentRenderbuffer:，而引擎一轮只推进
    // loop_interval（样例脚本是 30 ms）那么久。**glReadPixels 是管线同步点**
    // —— 它会把 GPU 已经排队的工作等干净，是这里唯一真正花钱的操作，而
    // 「引擎还没走到下一步」的那些帧读出来也没人会看。
    // 所以：距上次成功读取不足 gMinReadIntervalMs 就什么都不做，保留上一帧
    // （gFrameFresh 不置位、gDropped 不自增）—— 引擎照旧每步看到一帧，行为不变。
    //
    // 0 表示不节流（诊断用：想看真实渲染帧率就设 0）。
    //
    if (gMinReadIntervalMs > 0.0) {
        const double now = AMNowMs();
        if (gLastReadAt != 0.0 && (now - gLastReadAt) < gMinReadIntervalMs) {
            gReadSkips++;
            return;
        }
        gLastReadAt = now;
    }

    const size_t need = (size_t)vw * (size_t)vh * 4u;
    if (gReadCap < need) {
        unsigned char *p = (unsigned char *)realloc(gReadBuf, need);
        if (!p) return;                 // 读不到就算了，绝不因此拖垮游戏
        gReadBuf = p;
        gReadCap = need;
    }

    const double t0 = AMNowMs();

    // GL_PACK_ALIGNMENT 对 RGBA8 天然是 4 字节对齐，但默认值是 4；
    // 显式设一遍，免得别的代码把它改成 1 或 8。
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glReadPixels(vx, vy, vw, vh, GL_RGBA, GL_UNSIGNED_BYTE, gReadBuf);
    const double t1 = AMNowMs();       // glReadPixels 是管线同步点，这一段会阻塞渲染线程

    // 灰度降采样。目标尺寸 = 视口尺寸（1:1）。引擎会再做一次到脚本分辨率的缩放，
    // 但这一层保持原生像素，因为匹配的搜索矩形是按原生像素算的。
    const size_t grayNeed = (size_t)vw * (size_t)vh;
    os_unfair_lock_lock(&gLock);
    if (gFrameCap < grayNeed) {
        unsigned char *p = (unsigned char *)realloc(gFrame, grayNeed);
        if (!p) { os_unfair_lock_unlock(&gLock); return; }
        gFrame = p;
        gFrameCap = grayNeed;
    }
    AMDownsampleRGBAtoGray(gReadBuf, vw, vh, 4, YES /* GL 原点在左下 */,
                           gFrame, vw, vh);
    gFrameW = vw;
    gFrameH = vh;
    if (gFrameFresh) gDropped++;
    gFrameFresh = YES;
    // 计时也写在锁里：-stats 是在别的线程上读这些 double 的，
    // 64 位写入在 arm64 上虽然不会撕裂，但没有理由留一个数据竞争。
    const double t2 = AMNowMs();
    const double dt = t2 - t0;
    gLastReadMs = dt;
    gLastGLReadMs = t1 - t0;
    gLastDownsampleMs = t2 - t1;
    if (dt > gMaxReadMs) gMaxReadMs = dt;
    gFrames++;
    os_unfair_lock_unlock(&gLock);
    gBackend = AMCaptureBackendGL;
}

#pragma mark - 被 hook 的方法

@implementation EAGLContext (AMCapture)

- (BOOL)am_presentRenderbuffer:(NSUInteger)target
{
    // presentCalls 与 frames 的差值 = 「present 了但没抓到帧」的次数
    // （不是当前 context、glReadPixels 失败、被 @catch 兜住……）。
    // 这个差值大就说明取帧不稳，必须能在面板上看出来。
    AMCaptureNotePresent();

    // 先把真帧读走，再让原来的实现去 swap。
    // 放在 present 之前是**必须的**：present 之后 back buffer 的内容就未定义了。
    @try {
        if ([EAGLContext currentContext] == self) {
            AMCaptureReadFromGL();
        } else {
            // 不是当前 context 就没法安全地 glReadPixels（会读到别的 context 的 framebuffer）。
            // 不记日志（每帧都会刷屏），靠 presentCalls vs frames 的差值暴露出来。
        }
    } @catch (NSException *e) {
        // 取帧失败绝不能影响游戏渲染。
        NSLog(@"[AMCapture] read failed: %@", e.reason);
    }
    return [self am_presentRenderbuffer:target];   // 交换后指向原实现
}

@end

#pragma mark - AMCapture

@interface AMCapture ()
/* hasFrame / backend 在公开头里是 readonly，这里升级成 readwrite（**修饰符必须与头里
 * 逐字一致**，多写一个 copy 之类会被 clang 拒绝）。
 * ★ 它们的存储**不是 ivar**：hasFrame 的 getter 读文件级 gFrame，backend 的
 *   getter/setter 读写 gBackend ⇒ 既不要写 @synthesize，也不要给它们声明 ivar。
 *   踩过的坑见下面 @implementation 顶上的注释。 */
@property (nonatomic, readwrite) BOOL hasFrame;
@property (nonatomic, readwrite) AMCaptureBackend backend;
// presentCalls 是只读的派生量（背后是文件级 static gPresentCalls），
// 在公开头文件里已经声明过，这里**不要**再声明一次 —— 重复声明会
// 阻止属性自动合成，而 gPresentCalls 并不是一个 ivar。
@end

@implementation AMCapture

/* ★ 这里**不要**写 `@synthesize hasFrame = _hasFrame;` / `@synthesize backend = _backend;`。
   第一次真实 iOS 编译的教训（第一次尝试加了这两行，换来一条新错误）：
       error: ivar '_backend' which backs the property is not referenced in this
              property's accessor [-Werror,-Wunused-property-ivar]
   原因是这两个属性的存储根本**不是 ivar**：hasFrame 的 getter 读文件级的 gFrame、
   backend 的 getter/setter 读写 gBackend。显式 @synthesize 会强行造出一个没人引用的
   ivar，正好踩中 -Wunused-property-ivar（而且 Theos 带 -Werror ⇒ 直接失败）。
   什么都不写最正确：属性由 @interface 里的声明提供接口，实现由下面那对访问器提供。 */

+ (instancetype)shared
{
    static AMCapture *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[AMCapture alloc] init]; [s install]; });
    return s;
}

+ (void)load
{
    // 尽早装 hook：游戏的第一个画面可能在 UI 起来之前就 present 了。
    [[self shared] install];
}

- (void)install
{
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class cls = objc_getClass("EAGLContext");
        if (!cls) {
            NSLog(@"[AMCapture] no EAGLContext — 目标不是 GL 应用，只有 drawViewHierarchy 兜底可用");
            return;
        }
        SEL orig = @selector(presentRenderbuffer:);
        SEL repl = @selector(am_presentRenderbuffer:);
        Method m = class_getInstanceMethod(cls, orig);
        Method r = class_getInstanceMethod(cls, repl);
        if (!m || !r) {
            NSLog(@"[AMCapture] EAGLContext hook 失败：selector 缺失");
            return;
        }
        // 用 class_addMethod + exchangeImplementations 的标准写法：
        // 先把替换实现加到类上（EAGLContext 是系统类，方法可能在父类里），
        // 再交换，这样 addMethod 失败（已存在）也不会破坏原方法。
        if (class_addMethod(cls, repl, method_getImplementation(r), method_getTypeEncoding(r))) {
            Method now = class_getInstanceMethod(cls, repl);
            method_exchangeImplementations(m, now);
        } else {
            method_exchangeImplementations(m, r);
        }
        NSLog(@"[AMCapture] hook -[EAGLContext presentRenderbuffer:] 已装");
    });
}

- (BOOL)hasFrame
{
    os_unfair_lock_lock(&gLock);
    const BOOL b = (gFrame != NULL && gFrameW > 0 && gFrameH > 0);
    os_unfair_lock_unlock(&gLock);
    return b;
}

- (AMCaptureBackend)backend
{
    os_unfair_lock_lock(&gLock);
    const AMCaptureBackend b = gBackend;
    os_unfair_lock_unlock(&gLock);
    return b;
}

- (void)setBackend:(AMCaptureBackend)b
{
    os_unfair_lock_lock(&gLock);
    gBackend = b;
    os_unfair_lock_unlock(&gLock);
}

- (NSString *)backendName
{
    switch (self.backend) {
        case AMCaptureBackendGL:        return @"OpenGL (presentRenderbuffer + glReadPixels)";
        case AMCaptureBackendHierarchy: return @"drawViewHierarchyInRect (fallback)";
        default:                        return @"none (还没有抓到帧)";
    }
}

- (CGSize)frameSize
{
    os_unfair_lock_lock(&gLock);
    const CGSize s = CGSizeMake(gFrameW, gFrameH);
    os_unfair_lock_unlock(&gLock);
    return s;
}

- (BOOL)latestSize:(out CGSize *)outSize
{
    os_unfair_lock_lock(&gLock);
    const BOOL ok = (gFrame != NULL && gFrameW > 0 && gFrameH > 0);
    const CGSize s = CGSizeMake(gFrameW, gFrameH);
    os_unfair_lock_unlock(&gLock);
    if (ok && outSize) *outSize = s;
    return ok;
}

- (BOOL)latestGrayInto:(unsigned char *)out width:(int)outW height:(int)outH
{
    if (!out || outW <= 0 || outH <= 0) return NO;

    os_unfair_lock_lock(&gLock);
    if (!gFrame || gFrameW <= 0 || gFrameH <= 0) {
        os_unfair_lock_unlock(&gLock);
        return NO;
    }
    // 已经是目标尺寸 —— 直接拷，别做无意义的重采样（像素精确的快路径）。
    if (gFrameW == outW && gFrameH == outH) {
        memcpy(out, gFrame, (size_t)outW * (size_t)outH);
    } else {
        const unsigned char *src = gFrame;
        const int sw = gFrameW, sh = gFrameH;
        for (int y = 0; y < outH; y++) {
            int sy = (int)(((long long)y * sh) / outH);
            if (sy >= sh) sy = sh - 1;
            const unsigned char *srow = src + (size_t)sy * (size_t)sw;
            unsigned char *drow = out + (size_t)y * (size_t)outW;
            for (int x = 0; x < outW; x++) {
                int sx = (int)(((long long)x * sw) / outW);
                if (sx >= sw) sx = sw - 1;
                drow[x] = srow[sx];
            }
        }
    }
    gFrameFresh = NO;      // 这一帧已经被取走了
    os_unfair_lock_unlock(&gLock);
    return YES;
}

- (nullable UIImage *)previewImage
{
    // 把最新一帧降采样到最长边 <= 240 再转 UIImage。面板是给人看的，不需要原分辨率。
    CGSize sz = self.frameSize;
    if (sz.width <= 0 || sz.height <= 0) return nil;
    const CGFloat k = 240.0 / MAX(sz.width, sz.height);
    const int w = (int)MAX(1.0, floor(sz.width * MIN(1.0, k)));
    const int h = (int)MAX(1.0, floor(sz.height * MIN(1.0, k)));

    unsigned char *buf = (unsigned char *)malloc((size_t)w * (size_t)h);
    if (!buf) return nil;
    if (![self latestGrayInto:buf width:w height:h]) { free(buf); return nil; }

    // 灰度 -> BGRA
    const size_t n = (size_t)w * (size_t)h;
    unsigned char *rgba = (unsigned char *)malloc(n * 4u);
    if (!rgba) { free(buf); return nil; }
    for (size_t i = 0; i < n; i++) {
        const unsigned char v = buf[i];
        rgba[i * 4 + 0] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
    }
    free(buf);

    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(rgba, (size_t)w, (size_t)h, 8,
                                             (size_t)w * 4u, cs,
                                             kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (!ctx) { free(rgba); return nil; }
    CGImageRef img = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    free(rgba);
    if (!img) return nil;
    UIImage *ui = [UIImage imageWithCGImage:img];
    CGImageRelease(img);
    return ui;
}

- (AMCaptureStats)stats
{
    AMCaptureStats s;
    os_unfair_lock_lock(&gLock);
    s.frames = gFrames;
    s.dropped = gDropped;
    s.readSkips = gReadSkips;
    s.lastReadMs = gLastReadMs;
    s.maxReadMs = gMaxReadMs;
    s.lastGLReadMs = gLastGLReadMs;
    s.lastDownsampleMs = gLastDownsampleMs;
    s.width = gFrameW;
    s.height = gFrameH;
    os_unfair_lock_unlock(&gLock);
    return s;
}

- (unsigned long long)presentCalls
{
    return gPresentCalls;
}

- (double)minReadIntervalMs
{
    return gMinReadIntervalMs;
}

- (void)setMinReadIntervalMs:(double)ms
{
    if (ms < 0.0) ms = 0.0;                 // 负数当 0（=不节流），别让它变成"永远不读"
    if (ms > 1000.0) ms = 1000.0;           // 1 秒以上没有意义，只会让人以为坏了
    gMinReadIntervalMs = ms;
}

- (void)acceptForeignFrame:(const unsigned char *)gray width:(int)w height:(int)h
{
    if (!gray || w <= 0 || h <= 0) return;
    AMCaptureStoreGray(gray, w, h);
    self.backend = AMCaptureBackendHierarchy;   // 标记成非 GL，诊断里能看出来
}

@end

#pragma mark - 存取

static void AMCaptureStoreGray(const unsigned char *gray, int w, int h)
{
    const size_t need = (size_t)w * (size_t)h;
    os_unfair_lock_lock(&gLock);
    if (gFrameCap < need) {
        unsigned char *p = (unsigned char *)realloc(gFrame, need);
        if (!p) { os_unfair_lock_unlock(&gLock); return; }
        gFrame = p;
        gFrameCap = need;
    }
    memcpy(gFrame, gray, need);
    gFrameW = w;
    gFrameH = h;
    if (gFrameFresh) gDropped++;
    gFrameFresh = YES;
    os_unfair_lock_unlock(&gLock);
    gFrames++;
}

#pragma mark - 被 hook 方法的计数

/* AMCaptureNotePresent() 的定义在文件前部的「hook 实现」一节里（必须在调用点之前，
   否则 C99 下是隐式声明）。原来放在这里，是第一次真实 iOS 编译报出来的两个错误之一。 */

/* 关掉本文件的 -Wdeprecated-declarations（见文件顶部 push 处的说明）。文件末尾 pop 一次，
   保证诊断状态不会泄漏给同一 TU 里可能追加的任何内容。 */
#pragma clang diagnostic pop

