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
// 但「当前 renderbuffer 的宽高」只能通过 -[EAGLContext renderbufferStorage:fromDrawable:]
// 的入参、或 -[EAGLContext drawableProperties] 间接知道。ES2 的 EAGLContext 会把
// 最近一次 renderbufferStorage 的尺寸记在内部 —— 读取它需要一个私有 selector。
// **不可靠**，所以本实现改成：从 glGetIntegerv(GL_VIEWPORT) 问默认 framebuffer 的视口。
// 视口 = 本次绘制的可绘制区域，对 Stage3D 的全屏绘制就等于屏幕像素尺寸。
// 如果视口比实际 framebuffer 小（有黑边），读到的是子矩形，此时**以视口为准**是对的：
// 黑边不该参与匹配。
static BOOL AMGLViewport(GLint *outX, GLint *outY, GLint *outW, GLint *outH)
{
    GLint vp[4] = { 0, 0, 0, 0 };
    glGetIntegerv(GL_VIEWPORT, vp);
    if (vp[2] <= 0 || vp[3] <= 0) return NO;

    // glGetIntegerv 会把当前的 GL 错误清掉，所以这里要先把之前的错误读干净，
    // 免得把别人的错误吞了。
    while (glGetError() != GL_NO_ERROR) { }

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

/// 从当前绑定的 GL 状态读一帧。**必须在渲染线程调用**（或至少是持有当前 EAGLContext 的线程）。
static void AMCaptureReadFromGL(void)
{
    GLint vx = 0, vy = 0, vw = 0, vh = 0;
    if (!AMGLViewport(&vx, &vy, &vw, &vh)) return;

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
    os_unfair_lock_unlock(&gLock);

    const double dt = AMNowMs() - t0;
    gLastReadMs = dt;
    if (dt > gMaxReadMs) gMaxReadMs = dt;
    gFrames++;
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
@property (nonatomic, readwrite) BOOL hasFrame;
@property (nonatomic, readwrite) AMCaptureBackend backend;
// presentCalls 是只读的派生量（背后是文件级 static gPresentCalls），
// 在公开头文件里已经声明过，这里**不要**再声明一次 —— 重复声明会
// 阻止属性自动合成，而 gPresentCalls 并不是一个 ivar。
@end

@implementation AMCapture

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
    s.lastReadMs = gLastReadMs;
    s.maxReadMs = gMaxReadMs;
    s.width = gFrameW;
    s.height = gFrameH;
    os_unfair_lock_unlock(&gLock);
    return s;
}

- (unsigned long long)presentCalls
{
    return gPresentCalls;
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

// presentRenderbuffer 的调用计数：在交换后的实现里自增会递归，所以在 hook 里直接加。
// 这里用一个 C 函数暴露给 hook 用（放在最后，避免上面的 @implementation 里出现未声明符号）。
void AMCaptureNotePresent(void)
{
    __atomic_fetch_add(&gPresentCalls, 1ull, __ATOMIC_RELAXED);
}
