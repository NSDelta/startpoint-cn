//
//  AMRuntime.h —— 把 core/ 引擎接到 iOS 平台层
//
//  职责边界（有意分得很窄）：
//    · 脚本发现与加载（.auto 是 ZIP，core/am_container.c 会解开它）
//    · 屏幕参数适配（把 iOS 的帧尺寸合成成脚本要的 screen_info）
//    · 起一条跑 am_engine_step 的线程，把 am_engine_host 接到 AMCapture / AMTouch
//    · 暴露状态给面板 UI（当前场景、命中峰值、点击记录、错误）
//
//  不负责：UI（那是 AMPanel）、脚本编辑、跨进程的东西。
//
//  ── 关于"帧尺寸"这件事必须说清楚 ────────────────────────────────────────────
//  .auto 脚本里的坐标活在**录制机**的像素空间里，core/auto_script.c 会把它们
//  适配到"当前屏幕"。所以本类必须在脚本加载后立刻 am_script_set_screen()，
//  而且在**抓到第一帧之前**就要知道帧尺寸 —— 引擎的 width/height 和脚本的当前
//  屏幕必须完全一致，否则搜到的位置与点下去的位置会差一个缩放系数。
//  因此：start 之前会阻塞等第一帧（有超时），拿不到就拒绝启动。
//
//  ── 关于 densityDpi ─────────────────────────────────────────────────────────
//  Android 用 densityDpi 选模板变体（EditorImage.getAdapterInfo 只比这一个数）。
//  iOS 没有这个概念，必须**合成**一个，而且必须与录制机同一量纲：
//
//      density = 帧缓冲宽度 / 窗口点宽 * 160
//
//  ★ 这个"每点多少物理像素"的比值由 AMTouch -pixelToPointScaleInWindow: 现算，
//    它优先用 [AMCapture shared].frameSize.width / window.bounds.size.width。
//
//  ★★ 千万不要换成 UIScreen.nativeScale。iPhone 7 Plus 是
//     逻辑 1242x2208（scale 3.0）/ 物理 1080x1920（nativeScale 2.608），
//     而 GL 帧缓冲是 1242x2208 —— 用 nativeScale 会让 density 偏小 13%，
//     变体选择落到错误的一档；更重要的是 AMTouch 的坐标换算会整体偏 15%，
//     1200 宽画面上就是 180 像素的偏移，按钮必然点不中。
//
//  这是 §10 风险表第 11 条：值不对 ⇒ 选中错误的变体 ⇒ 阈值与坐标都偏。
//

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// 运行状态。
typedef NS_ENUM(NSInteger, AMRuntimeState) {
    AMRuntimeStateIdle = 0,     ///< 没有脚本 / 已停止
    AMRuntimeStateLoading,      ///< 正在读 .auto
    AMRuntimeStateWaitingFrame, ///< 脚本已加载，等第一帧来确定屏幕参数
    AMRuntimeStateRunning,      ///< 引擎在跑
    AMRuntimeStateStopped,      ///< 脚本跑到了停止动作 / 被 stop
    AMRuntimeStateFailed,       ///< 加载或启动失败，看 lastError
};

/// 面板要的一屏状态快照。
typedef struct {
    AMRuntimeState state;
    int    rounds;              ///< 已跑过的轮数
    int    currentScene;        ///< -1 = 没有
    int    sceneCount;
    int    tapCount;            ///< 本次运行累计点击数
    double lastPeak;            ///< 最近一次匹配的峰值（诊断"为什么没点"）
    int    unsupportedConditions; ///< 本端口不会求值的条件数（>0 要警告用户）
    int    frameWidth, frameHeight;
    double density;
} AMRuntimeStatus;

@class UIImage;

@interface AMRuntime : NSObject

+ (instancetype)shared;

#pragma mark - 脚本

/// 当前脚本的绝对路径（没有则 nil）。
@property (nonatomic, readonly, nullable) NSString *scriptPath;

/// 当前脚本名（header.name），没有则 nil。
@property (nonatomic, readonly, nullable) NSString *scriptName;

/// 找脚本。搜索顺序：
///   1. 沙盒 Documents/AutoClick/*.auto（用户自己放进去的，优先）
///   2. 沙盒 Library/Application Support/AutoClick/*.auto
///   3. main bundle 里的 *.auto（注入时一起塞进去的）
/// 返回全部候选的绝对路径（按上面的顺序，同目录内按文件名排序）。
+ (NSArray<NSString *> *)discoverScripts;

/// 载入脚本。会先把正在跑的停掉。返回是否成功；失败原因看 lastError。
- (BOOL)loadScriptAtPath:(NSString *)path;

#pragma mark - 运行

/// 开始跑。会阻塞最多 timeout 秒等第一帧（拿不到就失败）。
- (BOOL)startWithFrameTimeout:(NSTimeInterval)timeout;

/// 按部署期配置（main bundle 里的 AutoClick.plist）自动加载并启动。
///
/// 这是**非越狱侧唯一现实的自动化方式**：侧载的 dylib 没人给它点面板，
/// 所以 `{ "autoStart": true, "script": "幻想连战.auto" }` 就是全部控制手段。
/// 配置里没写 autoStart（或为 false）时什么都不做，返回 NO（不是错误）。
///
/// 会在后台等第一帧再启动 —— 调用点通常在 didFinishLaunching，那时游戏还没渲染，
/// 就地阻塞会卡住启动。
- (BOOL)autoStartIfConfigured;

/// 停止（幂等）。跑引擎的线程会被要求退出并 join。
- (void)stop;

/// 暂停/继续（不销毁引擎状态）。
@property (nonatomic, readwrite) BOOL paused;

@property (nonatomic, readonly) AMRuntimeState state;
@property (nonatomic, readonly, copy, nullable) NSString *lastError;
- (AMRuntimeStatus)status;

#pragma mark - 诊断（面板用）

/// 最近 N 次点击的文本化记录（越新越靠后），给面板列表用。
- (NSArray<NSString *> *)recentTapDescriptions;

/// 一行环境摘要：后端、帧尺寸、density、是否支持触摸。启动时打日志用。
- (NSString *)environmentSummary;

/// 取帧后端的名字 / 触摸后端的名字（转发给 AMCapture / AMTouch）。
- (NSString *)captureBackendName;
- (NSString *)touchBackendName;

/// 当前帧的低分辨率预览。
- (nullable UIImage *)previewImage;

/// 诊断：打印某个点在屏幕像素坐标下的 hitTest 命中链（§5-Q3 第一步）。
/// 返回 nil 表示没有窗口；返回空串表示那条链是空的。
- (nullable NSString *)describeHitAtScreenPixel:(CGPoint)px;

#pragma mark - 测试

/// 不经过 GL，直接喂一帧灰度（尺寸必须与 start 时确定的一致）。
/// 返回 NO 表示尺寸不匹配（这正是要保护的：尺寸变了坐标系就变了）。
- (BOOL)acceptTestFrame:(const unsigned char *)gray width:(int)w height:(int)h;

/// 手动指定当前屏幕参数（测试用；正常路径是从第一帧推出来）。
- (BOOL)overrideScreenWidth:(int)w height:(int)h density:(double)density;

@end

NS_ASSUME_NONNULL_END
