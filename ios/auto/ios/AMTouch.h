//
//  AMTouch.h —— 触摸注入（iOS 平台层）
//
//  目标客户端 worldflipper 是 Adobe AIR + OpenGL ES2。同一进程内**合成**触摸有两条路：
//
//    A. HID 事件路径（BKSHIDEventSetDigitizerInfo / -[UIApplication _enqueueHIDEvent:]）
//       —— 判据最强、最接近真手指，但它是**进程身份 / 沙箱 / entitlement 问题，不是
//       iOS 版本问题**：非越狱的普通 app 进程里事件会被接受然后被路由到无处（KQAR/Reticle#281
//       在 iOS 26 上实测 16 种组合全部"无错误且无效果"；EarlGrey#293 的结论是
//       "doesn't work on devices due to entitlement issues"）。所以只有越狱侧值得试。
//
//    B. 伪造 UITouch → 塞进 -[UIApplication _touchesEvent] → -[UIApplication sendEvent:]
//       —— **这是两个交付物的主路**。它绕过 digitizer、直接从 UIKit 的手指事件入口进去，
//       hit-testing / 手势识别 / UIScrollView 都正常（KQAR/Reticle#281 换了这条路后
//       全部工作）。
//
//  本类把 B 做成生产可用的形态：线程安全、可诊断、失败不抛、坐标有明确的换算链。
//
//  ★ 坐标换算链（最容易错的一环）
//
//      引擎给的 (px, py)  →  「游戏画面像素」
//                          ↓  除以 nativeScale（不是 scale！display zoom 下两者不同）
//                         「屏幕点」
//                          ↓  UIWindow 在屏幕坐标系里的原点在 (0,0)（iOS 8 以后窗口铺满）
//                         「窗口点」= 真正喂给 _setLocationInWindow: 的东西
//
//  - `-[UITouch _setLocationInWindow:]` 要的是**窗口**坐标，不是屏幕坐标、更不是像素。
//  - 引擎的像素是「取帧缓冲的像素」，也就是 GL 视口的像素。视口可能不等于屏幕像素
//    （极端情况有黑边），所以调用方必须把 (px, py) 换算到**屏幕**像素之后才能除 scale。
//    AMRuntime 负责这一步；本类只接受「屏幕点」。
//  - 用 `nativeScale` 而不是 `scale`：**显示缩放（Display Zoom）开启时二者不同**
//    （iPhone 7 Plus: scale=3.0, nativeScale=2.608）。取帧缓冲是 native 分辨率的，
//    所以必须用 nativeScale。
//
//  ★ 为什么必须有「一个 tap 分两次调用」
//
//  真手指是一个 began…ended 序列，UIKit 的 `UITouch` 对象在两次之间**必须保持同一身份**
//  （同一个 window/view/location 历史），否则手势识别会把它当成两个断开的触点。
//  引擎只给出「点一下、按住 press_ms」，所以本类把它拆成 `-beginTapAtPoint:` 与
//  `-endTapAtPoint:`，中间由调用方 `usleep(press_ms)`。`-tapAtPoint:pressMs:` 是
//  这两步的合体（内部 sleep），给不需要精细控制的调用方用。
//

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// 注入后端。
typedef NS_ENUM(NSInteger, AMTouchBackend) {
    AMTouchBackendNone = 0,   ///< 还没解析出来（或环境不可用）
    AMTouchBackendUITouch,    ///< 伪造 UITouch + _touchesEvent + sendEvent（主路，两个交付物都用）
    AMTouchBackendHID,        ///< _enqueueHIDEvent（仅越狱侧探测成功时）
};

/// 触摸统计。
typedef struct {
    unsigned long long sent;        ///< 成功 sendEvent 的次数
    unsigned long long failed;      ///< 因为后端不可用 / 找不到窗口而失败的次数
    unsigned long long refused;     ///< 事件发出去了，但 hitTest 没命中任何可交互 view（症状级的计数）
} AMTouchStats;

@interface AMTouch : NSObject

+ (instancetype)shared;

/// 当前后端（首次调用会尝试解析，结果缓存）。
@property (nonatomic, readonly) AMTouchBackend backend;
- (NSString *)backendName;

/// 手工指定后端（As=Auto）。越狱侧的探针用它；非越狱侧不用碰。
+ (void)setPreferredBackend:(AMTouchBackend)backend;

/// 这个环境到底能不能合成触摸（三条私有 selector 都在 + 有 key window）。
- (BOOL)available;

/// 最近一次失败的原因（给人看的一句话；没有失败时是 nil）。
@property (nonatomic, readonly, nullable) NSString *lastFailure;

/// 点一下。pointInWindow 是**窗口坐标（点）**；pressMs <= 0 时用 40ms。
- (BOOL)tapAtPoint:(CGPoint)pointInWindow pressMs:(int)pressMs;

/// 分两次的版本：began 与 ended。两者之间调用方自己 sleep。
/// **两次必须用同一个坐标**（本类内部保存了那个 UITouch 的身份）。
- (BOOL)beginTapAtPoint:(CGPoint)pointInWindow;
- (BOOL)endCurrentTap;

/// 当前有没有一个「按下去还没抬起来」的触点。
@property (nonatomic, readonly) BOOL touching;

/// 把「帧缓冲像素」换算成「窗口点」。缩放系数的取法见 pixelToPointScaleInWindow:。
+ (CGPoint)windowPointFromScreenPixels:(CGPoint)px inWindow:(nullable UIWindow *)window;

/// 便利：用当前 key window 做换算。
- (CGPoint)windowPointFromScreenPixels:(CGPoint)px;

/// 便利 + 自动换算：px 是**帧缓冲像素**（引擎坐标），本方法内部换算成窗口点再点。
/// 引擎的 am_engine_host::touch 回调应当直接用这个，不要自己算换算 ——
/// 少一次"上游算了一遍、下游又算一遍"的机会。
- (BOOL)tapAtScreenPixel:(CGPoint)px pressMs:(int)pressMs;

/// 同上，屏幕像素版的 hitTest 诊断。
- (nullable NSString *)describeHitAtScreenPixels:(CGPoint)px;

/// 帧缓冲像素 → 点 的除数。**不要想当然用 nativeScale**：
/// iPhone 7 Plus 的逻辑分辨率是 1242x2208（scale 3.0）而物理分辨率是 1080x1920
/// （nativeScale 2.608），但 GL 帧缓冲是 **1242x2208**（就是渲染分辨率），
/// 所以正确的除数是 3.0。本方法按「实抓帧宽 / 窗口点宽」现算，取不到帧时才退回
/// screen.nativeScale。返回 <= 0 表示两个来源都拿不到。
- (CGFloat)pixelToPointScaleInWindow:(nullable UIWindow *)window;

/// 当前 key window（找不到返回 nil）。
- (nullable UIWindow *)keyWindow;

/// 测试与诊断：只做 hitTest，不真的发事件。用来回答
/// 「这个点上到底有没有可交互的 view」（§5 的三个验收问题之一）。
- (nullable NSString *)describeHitAtPoint:(CGPoint)pointInWindow;

/// 解除 hook / 清状态。幂等。
- (void)shutdown;

/// 统计快照。
- (AMTouchStats)stats;

/// 面板用：最近一次命中的 view 类名（可能为 nil）。
@property (nonatomic, readonly, nullable) NSString *lastHitViewClass;

@end

NS_ASSUME_NONNULL_END
