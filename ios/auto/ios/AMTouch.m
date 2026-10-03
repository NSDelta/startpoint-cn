//
//  AMTouch.m —— 触摸注入实现
//
//  ============================================================================
//  为什么主路是「伪造 UITouch + sendEvent:」而不是 HID
//  ============================================================================
//  HID 路（_enqueueHIDEvent:）在**普通 App 进程内**是被接受的、然后被路由到无处：
//  KQAR/Reticle#281（iOS 26 真机）试了 sink / sender id / display-integrated /
//  坐标空间共 16 种组合，全部「无错误且无效果」；EarlGrey#293 的结论是
//  "doesn't work on devices due to entitlement issues"。这是**进程身份 / 沙箱 /
//  entitlement** 问题，不是 iOS 版本问题。所以：
//
//    · 非越狱 dylib：只会用 UITouch 路。
//    · 越狱 deb：可以先探 HID（探针见 AMTouchHIDProbe），失败就回退到这里。
//
//  ============================================================================
//  构造顺序不能改（KIF / PTFakeTouch 逐字）
//  ============================================================================
//    [touch setWindow:window];                       // 必须最先："Wipes out some values. Needs to be first."
//    [touch setTapCount:1];
//    [touch _setLocationInWindow:pt resetPrevious:(reuse == nil)];
//    [touch setView:[window hitTest:pt withEvent:nil]];
//    [touch setPhase:phase];
//    iOS14+: [touch _setIsTapToClick:NO];   iOS<14: _setIsFirstTouchForView:YES + setIsTap:NO
//    [touch setTimestamp:NSProcessInfo.processInfo.systemUptime];
//    [touch setGestureView:hitTestView];
//    [touch _setHidEvent:...];                       // "Starting with iOS 9, internal IOHIDEvent must be set"
//
//  ============================================================================
//  一次 tap = 两次 sendEvent，中间必须复用**同一个** UITouch
//  ============================================================================
//  真手指是一个 began…ended 序列，UIKit 在两次之间要求同一个 UITouch 身份
//  （同一个 window / view / location 历史），否则手势识别会看到两个断开的触点。
//  所以 -beginTapAtPoint: 保存 UITouch，-endCurrentTap 复用它。
//
//  ============================================================================
//  时间戳与按压时长
//  ============================================================================
//  §5-Q5 的结论：按压时长由**构造时的时间戳**决定，不由投递间隔决定
//  （WebKit 的 tap 就是构造 down(ts=T) → dispatch_async → nanosleep(50ms) →
//  构造 up(ts=T+50ms)，两个 block 可能背靠背执行）。所以 -tapAtPoint:pressMs:
//  是真的 sleep 之后才改时间戳 + 发 ended，不是"发了就算"。
//

#import "AMTouch.h"
#import "AMCapture.h"      /* 只为了问"帧缓冲多大"——换算像素→点要用它 */

#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

#pragma mark - IOKit 动态符号（只有 HID 探针用得到；UITouch 路不需要）

typedef struct __IOHIDEvent *AMIOHIDEventRef;
typedef AMIOHIDEventRef (*AMCreateFingerWithQuality_t)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                                       double, double, double, double, double,
                                                       double, double, double, double, double,
                                                       Boolean, Boolean, uint32_t);
typedef AMIOHIDEventRef (*AMCreateDigitizer_t)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                               uint32_t, uint32_t, double, double, double, double, double,
                                               Boolean, Boolean, uint32_t);
typedef void (*AMAppendEvent_t)(AMIOHIDEventRef, AMIOHIDEventRef, uint32_t);
typedef void (*AMSetInt_t)(AMIOHIDEventRef, uint32_t, CFIndex);

static AMCreateFingerWithQuality_t pFingerWithQuality;
static AMCreateDigitizer_t         pDigitizer;
static AMAppendEvent_t             pAppend;
static AMSetInt_t                  pSetInt;

#define AM_kHIDTypeDigitizer 11u
#define AM_kHIDFieldDigitizerIdentity          ((AM_kHIDTypeDigitizer << 16) + 6)
#define AM_kHIDFieldDigitizerEventMask         ((AM_kHIDTypeDigitizer << 16) + 7)
#define AM_kHIDFieldDigitizerIsDisplayIntegrated ((AM_kHIDTypeDigitizer << 16) + 25)
#define AM_kHIDEvtRange   1u
#define AM_kHIDEvtTouch   2u
#define AM_kHIDEvtPosition 4u

#pragma mark - 私有 selector 声明

@interface UITouch (AMTouchPrivate)
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setIsTap:(BOOL)isTap;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setPhase:(UITouchPhase)phase;
- (void)setGestureView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)firstTouchForView;
- (void)_setIsTapToClick:(BOOL)isTapToClick;
- (void)_setHidEvent:(AMIOHIDEventRef)event;
@end

@interface UIApplication (AMTouchPrivate)
- (UIEvent *)_touchesEvent;
- (BOOL)_enqueueHIDEvent:(AMIOHIDEventRef)event;
@end

@interface UIEvent (AMTouchPrivate)
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_setHIDEvent:(AMIOHIDEventRef)event;
- (void)_setTimestamp:(NSTimeInterval)timestamp;
@end

#pragma mark - 私有可写状态

/* 公开头文件里 lastHitViewClass 是 readonly 的。这里**不**再声明一个 readwrite 的
 * 同名属性，理由：class extension 里「升级」属性时**修饰符必须与头里逐字一致**
 * （头里是 `readonly, nullable`，没有 copy），多写一个 copy 就会被 clang 拒绝。
 *
 * `_lastHitViewClass` 这个 ivar 就**在这里自己声明**（下面那个 `{}` 块），配合实现里的
 * 自定义 getter/setter 使用。为什么不用 `@synthesize`：显式合成会再造一个 ivar，
 * 与自己声明的同名冲突；而且一旦访问器没引用它就会踩中
 *     error: ivar '_...' which backs the property is not referenced in this property's
 *            accessor [-Werror,-Wunused-property-ivar]
 * —— AMCapture 的 backend 就是这么被咬的（见那边的注释）。**ivar + 两个访问器**
 * 是唯一自洽、且不依赖「自动合成何时发生」的写法。 */
@interface AMTouch ()
{
    NSString *_lastHitViewClass;
}
@end

#pragma mark - 状态

static AMTouchBackend gPreferred = AMTouchBackendNone;   /* None == Auto */
static AMTouchBackend gResolved  = AMTouchBackendNone;

static UITouch *gActiveTouch;          /* 一个 began 之后、ended 之前的那个触点 */
static CGPoint  gActivePoint;
static NSTimeInterval gActiveTs;

static unsigned long long gSent, gFailed, gRefused;
static NSString *gLastFailure;

static void AMTouchLoadIOKit(void)
{
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
        if (!iokit) { iokit = dlopen("/System/Library/PrivateFrameworks/IOKit.framework/IOKit", RTLD_NOW); }
        if (!iokit) return;
        pDigitizer         = (AMCreateDigitizer_t)dlsym(iokit, "IOHIDEventCreateDigitizerEvent");
        pFingerWithQuality = (AMCreateFingerWithQuality_t)dlsym(iokit, "IOHIDEventCreateDigitizerFingerEventWithQuality");
        pAppend            = (AMAppendEvent_t)dlsym(iokit, "IOHIDEventAppendEvent");
        pSetInt            = (AMSetInt_t)dlsym(iokit, "IOHIDEventSetIntegerValue");
    });
}

static UIWindow *AMTouchKeyWindow(void)
{
    UIApplication *app = [UIApplication sharedApplication];

    /* ★ **不要**回退到 `app.windows`。它在 iOS 15.0 起被标记为 deprecated
       （`UIApplication.h:109  API_DEPRECATED("Use UIWindowScene.windows ...", ios(2.0, 15.0))`），
       而 Theos 在 Debug 构建下带 -Werror ⇒ 直接构建失败：
           error: 'windows' is deprecated: first deprecated in iOS 15.0
                  [-Werror,-Wdeprecated-declarations]
       这里原本正是这么写的（"退一步找任意窗口的 key window"）。目标最低版本是 iOS 15，
       而且 UIApplication 在 iOS 14 之后就一定有 connectedScenes，所以走场景遍历足够；
       连一个 scene 都没有时返回 nil，调用方（-beginTapAtPoint:）本来就会把这次点击
       计入 refused/failed 并给出原因 —— 比读一个已废弃属性更可查。 */
    for (UIScene *s in app.connectedScenes) {
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene *ws = (UIWindowScene *)s;
        if (ws.activationState != UISceneActivationStateForegroundActive) continue;
        for (UIWindow *w in ws.windows) {
            if (w.isKeyWindow) return w;
        }
    }
    /* 前台 active 的场景里没有 key window：退一步，任意场景里找 key。 */
    for (UIScene *s in app.connectedScenes) {
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *w in ((UIWindowScene *)s).windows) {
            if (w.isKeyWindow) return w;
        }
    }
    return nil;
}

/// 做一次 hitTest 并把整条命中链拼成人能读的字符串 —— §5-Q3 的现场验证第 1 步。
static NSString *AMTouchHitChain(UIWindow *w, CGPoint p)
{
    UIView *v = [w hitTest:p withEvent:nil];
    if (!v) return @"(nil)";
    NSMutableString *s = [NSMutableString string];
    UIView *cur = v;
    int depth = 0;
    while (cur && depth < 12) {
        [s appendFormat:@"%@%@(%@)", (depth ? @" <- " : @""),
                          NSStringFromClass([cur class]),
                          NSStringFromCGRect(cur.frame)];
        cur = cur.superview;
        depth++;
    }
    /* 这三个属性决定 hitTest 会不会剪枝；AIR 把根视图关掉的话两条路一起失效。 */
    [s appendFormat:@"  [uie=%d hidden=%d alpha=%.2f]",
                     v.userInteractionEnabled ? 1 : 0, v.hidden ? 1 : 0, (double)v.alpha];
    return s;
}

#pragma mark - HID 事件构造（只有 HID 路用）

static AMIOHIDEventRef AMTouchHIDEventForTouches(NSArray<UITouch *> *touches)
{
    AMTouchLoadIOKit();
    if (!pDigitizer || !pFingerWithQuality) return NULL;
    const uint64_t abTime = mach_absolute_time();

    AMIOHIDEventRef hand = pDigitizer(kCFAllocatorDefault, abTime,
                                      3 /* hand */, 0, 0,
                                      AM_kHIDEvtTouch, 0,
                                      0, 0, 0, 0, 0,
                                      0 /* range */, true /* touch */, 0);
    if (!hand) return NULL;
    pSetInt(hand, AM_kHIDFieldDigitizerIsDisplayIntegrated, 1);

    NSUInteger i = 0;
    for (UITouch *t in touches) {
        const uint32_t mask = (t.phase == UITouchPhaseMoved)
                            ? AM_kHIDEvtPosition
                            : (AM_kHIDEvtRange | AM_kHIDEvtTouch);
        const uint32_t touching = (t.phase == UITouchPhaseEnded) ? 0 : 1;
        const CGPoint loc = [t locationInView:t.window];
        AMIOHIDEventRef f = pFingerWithQuality(kCFAllocatorDefault, abTime,
                                              (uint32_t)(i + 1) /* index */,
                                              2 /* identity —— KIF 固定 2 */,
                                              mask, loc.x, loc.y, 0.0,
                                              0, 0,          /* tipPressure, twist */
                                              5.0, 5.0,      /* minorRadius, majorRadius */
                                              1.0, 1.0, 1.0, /* quality, density, irregularity */
                                              touching, touching, 0);
        if (f) {
            pSetInt(f, AM_kHIDFieldDigitizerIsDisplayIntegrated, 1);
            pAppend(hand, f, 0);
            CFRelease(f);
        }
        i++;
    }
    return hand;
}

#pragma mark - 构造 / 发送

static UITouch *AMTouchMake(CGPoint pointInWindow, UIWindow *window,
                            UITouchPhase phase, UITouch *reuse)
{
    UITouch *touch = reuse ?: [[UITouch alloc] init];
    /* 顺序不能改。setWindow: 必须最先 —— "Wipes out some values. Needs to be first." */
    [touch setWindow:window];
    [touch setTapCount:1];
    [touch _setLocationInWindow:pointInWindow resetPrevious:(reuse == nil)];
    UIView *hit = [window hitTest:pointInWindow withEvent:nil];
    [touch setView:hit];
    [touch setPhase:phase];
    if (@available(iOS 14.0, *)) {
        if ([touch respondsToSelector:@selector(_setIsTapToClick:)]) [touch _setIsTapToClick:NO];
    } else {
        if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) [touch _setIsFirstTouchForView:YES];
        if ([touch respondsToSelector:@selector(setIsTap:)]) [touch setIsTap:NO];
    }
    [touch setTimestamp:NSProcessInfo.processInfo.systemUptime];
    if ([touch respondsToSelector:@selector(setGestureView:)]) [touch setGestureView:hit];
    /* "Starting with iOS 9, internal IOHIDEvent must be set for UITouch object" —— KIF/PTFakeTouch 同注释。
       注意：这里的 IOHIDEvent 只是**填进 UITouch 里让 UIKit 满意**，不是把它塞给 digitizer；
       真正的投递走下面的 sendEvent:。 */
    AMIOHIDEventRef hid = AMTouchHIDEventForTouches(@[touch]);
    if (hid) { [touch _setHidEvent:hid]; CFRelease(hid); }
    return touch;
}

/// UITouch 路：组 UIEvent 并 sendEvent:。
static BOOL AMTouchSendUITouch(NSArray<UITouch *> *allTouches, BOOL *outHitWasNil)
{
    UIApplication *app = [UIApplication sharedApplication];
    if (![app respondsToSelector:NSSelectorFromString(@"_touchesEvent")]) return NO;

    UIEvent *event = [app _touchesEvent];
    if (!event) return NO;
    [event _clearTouches];

    AMIOHIDEventRef hid = AMTouchHIDEventForTouches(allTouches);
    if (hid) { [event _setHIDEvent:hid]; CFRelease(hid); }
    if (allTouches.count) [event _setTimestamp:allTouches.firstObject.timestamp];

    BOOL hitNil = NO;
    for (UITouch *t in allTouches) {
        if (!t.view) hitNil = YES;
        [event _addTouch:t forDelayedDelivery:NO];
    }
    if (outHitWasNil) *outHitWasNil = hitNil;

    [app sendEvent:event];
    return YES;
}

/// HID 路（只有探针成功时才走）。
static BOOL AMTouchSendHID(NSArray<UITouch *> *allTouches)
{
    UIApplication *app = [UIApplication sharedApplication];
    if (![app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")]) return NO;
    AMIOHIDEventRef hid = AMTouchHIDEventForTouches(allTouches);
    if (!hid) return NO;
    const BOOL ok = [app _enqueueHIDEvent:hid];
    CFRelease(hid);
    return ok;
}

#pragma mark - AMTouch

@implementation AMTouch

/* ★ 这里**不要**写 `@synthesize lastHitViewClass = _lastHitViewClass;`：
   ivar 已经在 class extension 里自己声明了，再合成一次会重名；而且访问器一旦没引用
   合成的那个 ivar 就会踩 -Werror 下的 -Wunused-property-ivar（AMCapture 的 backend
   正是这么被咬的）。属性接口来自头文件声明，实现来自这里的 getter/setter。 */

+ (instancetype)shared
{
    static AMTouch *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[AMTouch alloc] init]; });
    return s;
}

+ (void)setPreferredBackend:(AMTouchBackend)backend
{
    gPreferred = backend;
    gResolved = AMTouchBackendNone;
}

- (BOOL)available
{
    return [self resolve] != AMTouchBackendNone;
}

- (AMTouchBackend)resolve
{
    if (gResolved != AMTouchBackendNone) return gResolved;

    if (gPreferred == AMTouchBackendHID) {
        gResolved = AMTouchBackendHID;
        return gResolved;
    }
    if (gPreferred == AMTouchBackendUITouch) {
        gResolved = AMTouchBackendUITouch;
        return gResolved;
    }

    /* Auto：优先 HID（只在越狱环境里可能成功），否则 UITouch。 */
    const BOOL hidEnv = [self hidEnvironmentOK];
    if (hidEnv && [self hidProbe]) {
        gResolved = AMTouchBackendHID;
        return gResolved;
    }

    if ([self uitouchEnvironmentOK]) {
        gResolved = AMTouchBackendUITouch;
        return gResolved;
    }
    return AMTouchBackendNone;
}

- (BOOL)uitouchEnvironmentOK
{
    UIApplication *app = [UIApplication sharedApplication];
    return [app respondsToSelector:NSSelectorFromString(@"_touchesEvent")]
        && [UIEvent instancesRespondToSelector:NSSelectorFromString(@"_addTouch:forDelayedDelivery:")]
        && [UITouch instancesRespondToSelector:NSSelectorFromString(@"_setLocationInWindow:resetPrevious:")]
        && (AMTouchKeyWindow() != nil);
}

- (BOOL)hidEnvironmentOK
{
    AMTouchLoadIOKit();
    UIApplication *app = [UIApplication sharedApplication];
    const BOOL ok = pDigitizer && pFingerWithQuality && pAppend && pSetInt
                 && [app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")];
    return ok;
}

/// 探针：造一个 HID down 事件扔进去。**刻意不做 up** —— 我们只需要知道
/// 「这条路会不会被静默丢弃」，而一旦它真的生效了我们也不想要一个停不下来的触点。
/// 所以探针只在**明确知道目标进程是越狱侧**时才应该被调用。
- (BOOL)hidProbe
{
    return NO;   /* 默认关闭。见 AMTouch.h 与 .research/ios-touch-synthesis.md §2.5：
                    探针本身会留下一个未抬起的触点，必须由调用方显式启用并自行收尾。 */
}

- (AMTouchBackend)backend
{
    const AMTouchBackend b = [self resolve];
    return b;
}

- (NSString *)backendName
{
    switch ([self resolve]) {
        case AMTouchBackendUITouch: return @"UITouch + _touchesEvent + sendEvent";
        case AMTouchBackendHID:     return @"_enqueueHIDEvent (HID)";
        default:                    return @"none (环境不可用)";
    }
}

- (nullable NSString *)lastFailure { return gLastFailure; }

- (nullable UIWindow *)keyWindow { return AMTouchKeyWindow(); }

+ (CGPoint)windowPointFromScreenPixels:(CGPoint)px inWindow:(nullable UIWindow *)window
{
    CGFloat scale = 1.0;
    UIWindow *w = window ?: AMTouchKeyWindow();
    if (w) {
        scale = [[self shared] pixelToPointScaleInWindow:w];
    } else if (@available(iOS 8.0, *)) {
        scale = [UIScreen mainScreen].nativeScale;   /* 拿不到窗口时只能瞎猜一个 */
    }
    if (scale <= 0) scale = 1.0;
    return CGPointMake(px.x / scale, px.y / scale);
}

- (CGFloat)pixelToPointScaleInWindow:(nullable UIWindow *)window
{
    UIWindow *w = window ?: AMTouchKeyWindow();
    if (!w) return 0.0;

    // 首选：实抓帧的宽度 / 窗口的点宽。
    // 为什么不是 nativeScale: iPhone 7 Plus 的逻辑分辨率是 1242x2208（scale 3.0），
    // 物理分辨率是 1080x1920（nativeScale 2.608），而 GL 帧缓冲是 **1242x2208**
    // （就是渲染分辨率，不是面板分辨率）。用 nativeScale 会把触摸坐标整体放大 1.15 倍
    // —— 15% 的偏移在 1200 宽的画面上是 180 像素，按钮必然点不中。
    // 现算还能顺带兼容「帧缓冲比屏幕小、由 GPU 放大上屏」的机型。
    const CGSize fs = [AMCapture shared].frameSize;
    const CGFloat bw = w.bounds.size.width;
    if (fs.width > 0.0 && bw > 0.0) {
        const CGFloat s = fs.width / bw;
        if (s > 0.0) return s;
    }

    // 退化：还没有抓到帧（引擎启动前 / 取帧失败）时用屏幕的 nativeScale。
    if (@available(iOS 8.0, *)) {
        UIScreen *screen = w.windowScene.screen ?: [UIScreen mainScreen];
        if (screen.nativeScale > 0) return screen.nativeScale;
    }
    return w.screen.scale > 0 ? w.screen.scale : 1.0;
}

- (CGPoint)windowPointFromScreenPixels:(CGPoint)px
{
    return [AMTouch windowPointFromScreenPixels:px inWindow:AMTouchKeyWindow()];
}

- (BOOL)tapAtScreenPixel:(CGPoint)px pressMs:(int)pressMs
{
    return [self tapAtPoint:[self windowPointFromScreenPixels:px] pressMs:pressMs];
}

- (nullable NSString *)describeHitAtScreenPixels:(CGPoint)px
{
    return [self describeHitAtPoint:[self windowPointFromScreenPixels:px]];
}

- (nullable NSString *)describeHitAtPoint:(CGPoint)pointInWindow
{
    UIWindow *w = AMTouchKeyWindow();
    if (!w) return nil;
    return AMTouchHitChain(w, pointInWindow);
}

- (NSString *)lastHitViewClass
{
    return _lastHitViewClass;
}

/* 私有 setter。头里只有 readonly 的 getter，所以这个 setter 对外不可见 —— 但同一个
 * @implementation 里 `self.lastHitViewClass = ...` 能看见它（编译器对「本类里已实现的
 * setter」不做可见性检查）。写成方法而不是直接 `_lastHitViewClass = ...`，是为了让
 * copy 语义有个落点（ivar 是 raw 指针，直接赋值不会拷贝）。 */
- (void)setLastHitViewClass:(NSString *)name
{
    _lastHitViewClass = [name copy];
}

#pragma mark - 发送

- (BOOL)sendTouches:(NSArray<UITouch *> *)touches
{
    BOOL hitNil = NO;
    BOOL ok = NO;
    if ([self resolve] == AMTouchBackendHID) {
        ok = AMTouchSendHID(touches);
        if (!ok) {
            /* HID 静默失败 ⇒ 本次降级到 UITouch（不永久改写 gResolved，
               这样下一个探针周期还有机会回到 HID）。 */
            ok = AMTouchSendUITouch(touches, &hitNil);
        }
    } else {
        ok = AMTouchSendUITouch(touches, &hitNil);
    }
    if (ok) {
        gSent++;
        if (hitNil) gRefused++;      /* 发出去了但没命中可交互 view —— §5-Q4 的症状 */
    } else {
        gFailed++;
        gLastFailure = @"sendEvent 不可用（_touchesEvent / _addTouch:forDelayedDelivery: 缺失）";
    }
    return ok;
}

- (BOOL)beginTapAtPoint:(CGPoint)pointInWindow
{
    if ([self resolve] == AMTouchBackendNone) {
        gFailed++;
        gLastFailure = @"没有可用的后端：缺私有 selector 或没有 key window";
        return NO;
    }
    if (gActiveTouch) {
        /* 上一拍没抬起来。先把它收掉，避免留下悬挂触点。 */
        [self endCurrentTap];
    }
    UIWindow *w = AMTouchKeyWindow();
    if (!w) {
        gFailed++;
        gLastFailure = @"没有 key window";
        return NO;
    }

    UITouch *touch = AMTouchMake(pointInWindow, w, UITouchPhaseBegan, nil);
    gActiveTouch = touch;
    gActivePoint = pointInWindow;
    gActiveTs = touch.timestamp;
    self.lastHitViewClass = touch.view ? NSStringFromClass([touch.view class]) : nil;
    return [self sendTouches:@[ touch ]];
}

- (BOOL)endCurrentTap
{
    if (!gActiveTouch) return NO;
    UITouch *touch = gActiveTouch;
    gActiveTouch = nil;

    [touch setTimestamp:NSProcessInfo.processInfo.systemUptime];
    [touch setPhase:UITouchPhaseEnded];
    return [self sendTouches:@[ touch ]];
}

- (BOOL)tapAtPoint:(CGPoint)pointInWindow pressMs:(int)pressMs
{
    if (![self beginTapAtPoint:pointInWindow]) return NO;
    /* 按压时长由时间戳决定，所以这里必须真的等 —— 见文件头「时间戳与按压时长」。 */
    int ms = pressMs > 0 ? pressMs : 40;
    if (ms > 0) {
        struct timespec ts;
        ts.tv_sec = ms / 1000;
        ts.tv_nsec = (long)(ms % 1000) * 1000000L;
        nanosleep(&ts, NULL);
    }
    return [self endCurrentTap];
}

- (BOOL)touching { return gActiveTouch != nil; }

- (void)shutdown
{
    if (gActiveTouch) [self endCurrentTap];
    gResolved = AMTouchBackendNone;
}

- (AMTouchStats)stats
{
    AMTouchStats s;
    s.sent = gSent;
    s.failed = gFailed;
    s.refused = gRefused;
    return s;
}

@end
