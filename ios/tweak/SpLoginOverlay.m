// SpLoginOverlay.m —— 独立覆盖窗口实现（修复真机「没有 dylib 的窗口」）
//
// 机制（照抄社区里已在真机跑通的 wfcore `dylib/src/ui.m`，见 ios/tweak/README.md 第 5 节）：
//   · 覆盖窗口：独立 UIWindow，windowLevel = UIWindowLevelStatusBar + 100，背景透明，
//     rootViewController 的 view 是 SpLoginPassView（hitTest 命中自身背景时返回 nil ⇒ 事件穿透给游戏）。
//   · 显示手段：**只有 `hidden = NO`**，绝不 makeKeyAndVisible —— AIR 对 keyWindow 变化敏感。
//   · 键盘例外：面板里的输入框开始编辑时才 `makeKeyWindow`，编辑结束立刻把 key 还给宿主窗口；
//     宿主窗口在挂载时记录（weak），因为编辑期间 overlay 自己是 key，现查会查到自己
//     （wfcore ui.m:352-357 的教训）。
//   · 保活：1.5s 首挂 + UIWindowDidBecomeKeyNotification + 5s 看门狗，三条都调同一个幂等挂载例程；
//     scene 变化就迁移 windowScene，被隐藏就 unhide。
//   · 取证：**每次挂载尝试都写一行日志**（扫到的窗口列表 / 选中的宿主 / overlay 状态 / 失败原因），
//     服主只给我们日志，日志必须能自证「窗口到底建没建、挂没挂上」。

#import "SpLoginOverlay.h"
#import "SpLoginConfig.h"
#import "SpLoginTheme.h"
#import "SpLoginViewController.h"

#import <QuartzCore/QuartzCore.h>

#pragma mark - 常量

static const CGFloat kSpLoginBallSize = 52.0;          // 悬浮球边长（与 wfcore 的 52 一致）
static const CGFloat kSpLoginBallMargin = 12.0;        // 距屏幕边缘
static const CGFloat kSpLoginBallTop = 140.0;          // 初始 y（避开状态栏与官方顶部 UI）
static const CGFloat kSpLoginOverlayLevelOffset = 100.0;
static const NSTimeInterval kSpLoginFirstAttachDelay = 1.5;   // 1.5s 首挂（wfcore ui.m:528）
static const NSTimeInterval kSpLoginWatchdogInterval = 5.0;   // 5s 看门狗（wfcore ui.m:540）
static const NSUInteger kSpLoginWindowListLimit = 8;          // 日志里最多列几个窗口

/// 前置声明：定义在文件尾部，但看门狗用的 sp_restoreHostKeyIfIdle 先用到它。
/// C 函数不前置声明 = 隐式函数声明 = clang 16+ 的**硬错误**，别删。
static BOOL SpLoginViewHasFirstResponder(UIView *view);

#pragma mark - 空白穿透视图

/// hitTest 命中自身（= 空白背景）时返回 nil：事件落到下层窗口（游戏），
/// 因此覆盖窗口铺满全屏也不会挡住游戏操作，只有悬浮球/面板真实可交互。
@interface SpLoginPassView : UIView @end

@implementation SpLoginPassView

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event
{
    UIView *hit = [super hitTest:point withEvent:event];
    return (hit == self) ? nil : hit;
}

@end

#pragma mark - 覆盖窗口的根 VC

@interface SpLoginOverlayRootViewController : UIViewController @end

@implementation SpLoginOverlayRootViewController

- (void)loadView
{
    SpLoginPassView *view = [[SpLoginPassView alloc] initWithFrame:[UIScreen mainScreen].bounds];
    view.backgroundColor = [UIColor clearColor];
    view.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.view = view;
}

@end

#pragma mark - 覆盖窗口管理器

@interface SpLoginOverlay () <UIGestureRecognizerDelegate>

// 私有方法前置声明：下面用 @selector(...) 引用它们的行号都排在定义之前，
// 显式声明一次可以免疫 -Wundeclared-selector 一类的告警（CI 上是 -Werror）。

- (void)sp_handleBallPan:(UIPanGestureRecognizer *)gesture;
- (void)sp_scrimTapped:(UITapGestureRecognizer *)gesture;
/// 宿主窗口全找不到时的兜底来源：优先前台激活的 UIWindowScene，其次任意一个。
- (UIWindowScene *)sp_preferredWindowScene;
/// 覆盖窗口创建：scene 为空才退回 UIScreen bounds（host 可以为 nil，此时只靠 scene）。
- (void)sp_createOverlayWindowWithHost:(UIWindow *)host
                                 scene:(UIWindowScene *)scene;
/// 把一次挂载尝试的结果整理成写进 Documents 的取证文本。
- (NSString *)sp_attachReportWithResult:(NSString *)result
                                 reason:(NSString *)reason
                                attempt:(NSUInteger)attempt
                                 hostBy:(NSString *)hostBy
                                windows:(NSString *)windows;

@property (nonatomic, strong, nullable) UIWindow *overlayWindow;
/// 宿主（游戏）窗口。weak + 挂载时记录：编辑期间 overlay 自己是 key，现查会查到 overlay
/// 自己（wfcore ui.m:353-354 的注释就是这件事）。
@property (nonatomic, weak, nullable) UIWindow *hostWindow;
@property (nonatomic, strong, nullable) UIButton *floatingButton;
@property (nonatomic, strong, nullable) SpLoginViewController *panelController;

@property (nonatomic, assign) BOOL installed;
@property (nonatomic, assign) BOOL pendingShow;      // 触发早于宿主窗口就绪：挂上后自动打开
@property (nonatomic, assign) BOOL keyboardObserversInstalled;
@property (nonatomic, assign) NSUInteger attachAttempts;
/// 呼吸动画只在挂载点开启一次（幂等：重复挂载不会叠出第二条动画）。
/// 纯视觉，与「球是否可点/可拖/是否常驻」没有任何关系。
@property (nonatomic, assign) BOOL ballPulsing;

- (void)sp_animateBallPulseIfNeeded;
- (void)sp_pressDown:(UIControl *)control;
- (void)sp_pressUp:(UIControl *)control;

@end

@implementation SpLoginOverlay

+ (instancetype)sharedOverlay
{
    static SpLoginOverlay *shared = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        shared = [[SpLoginOverlay alloc] init];
    });
    return shared;
}

#pragma mark - 对外状态

- (BOOL)isPanelVisible
{
    if (self.panelController == nil || !self.panelController.isViewLoaded) {
        return NO;
    }
    return !self.panelController.view.hidden;
}

- (BOOL)isFloatingButtonVisible
{
    return self.floatingButton != nil && self.floatingButton.superview != nil;
}

#pragma mark - 安装 / 保活

- (void)install
{
    if (self.installed) {
        SPLoginLog(@"[SpLogin] overlay install 已装过，忽略重复调用");
        return;
    }
    self.installed = YES;

    SPLoginLog(@"[SpLogin] overlay install: 1.5s 首挂 + 4 个唤醒通知 + 5s 看门狗；"
               @"显示只用 hidden=NO（绝不 makeKeyAndVisible），悬浮球=%@",
               [SpLoginConfig sharedConfig].floatingButton ? @"开" : @"关");
    // 取证第一落点：这个文件存在 = 构造函数走到了 overlay install。
    // 它不存在 = dylib 根本没进进程（或构造炸在更前面）——两种结论完全不同，
    // 所以必须先把它写下来再谈别的。
    SPLoginMarker(@"SpLogin-1-install", [NSString stringWithFormat:
                                         @"overlay install 进入\nfloatingButton=%@\nuiTakeover=%@\nhost=%@\n"
                                         @"plist=%@",
                                         [SpLoginConfig sharedConfig].floatingButton ? @"YES" : @"NO",
                                         [SpLoginConfig sharedConfig].uiTakeover ? @"YES" : @"NO",
                                         [SpLoginConfig sharedConfig].hostPort,
                                         [SpLoginConfig sharedConfig].preferenceSourcePath ?: @"(无，用编译期常量)"], YES);

    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSpLoginFirstAttachDelay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [weakSelf sp_attachWithReason:@"timer1.5s"];
    });

    // 唤醒时机从一个 keyWindow 通知扩到四个（四者都调同一个**幂等**挂载例程，多报无副作用）：
    //   · UIWindowDidBecomeKeyNotification        宿主建窗/抢焦点（wfcore ui.m:532-538 用的就是它）
    //   · UIApplicationDidFinishLaunchingNotification  启动完成 —— 构造函数跑在它**之前**，
    //     所以这条是「冷启动时第一个真正可靠的时机」
    //   · UIApplicationDidBecomeActiveNotification 回前台（AIR 挂起恢复后重建窗口）
    //   · UISceneDidActivateNotification           scene 激活（多 scene 机型上只有这条会来）
    // 只靠 keyWindow 通知的话，只要宿主窗口从没「变成 key」，覆盖窗口就永远不会被创建 ——
    // 症状恰好就是「悬浮球和悬浮窗都不出现」。
    for (NSNotificationName name in @[ UIWindowDidBecomeKeyNotification,
                                       UIApplicationDidFinishLaunchingNotification,
                                       UIApplicationDidBecomeActiveNotification,
                                       UISceneDidActivateNotification ]) {
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(sp_windowDidBecomeKey:)
                                                     name:name
                                                   object:nil];
    }

    [NSTimer scheduledTimerWithTimeInterval:kSpLoginWatchdogInterval
                                    repeats:YES
                                      block:^(NSTimer *timer) {
        __strong typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            return;
        }
        [strongSelf sp_restoreHostKeyIfIdle];
        [strongSelf sp_attachWithReason:@"watchdog5s"];
    }];

    [self sp_installKeyboardObservers];
}

- (void)sp_windowDidBecomeKey:(NSNotification *)note
{
    (void)note;   // 只借时机，不看 payload
    // 四条通知共用这一个入口（keyWindow 变化 / 启动完成 / 回前台 / scene 激活）：
    // 宿主换了 key window（AIR 重建窗口、系统弹窗收回焦点…）→ 重新评估挂载并更新 hostWindow。
    [self sp_attachWithReason:@"wakeup"];
}

#pragma mark - 挂载（幂等：通知 / 定时器 / 看门狗都可以随便反复调）

- (BOOL)sp_attachWithReason:(NSString *)reason
{
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self sp_attachWithReason:reason];
        });
        return NO;   // 结果只体现在日志里；showPanel 等调用点都在主线程
    }

    self.attachAttempts += 1;
    NSUInteger attempt = self.attachAttempts;
    NSString *windows = [self sp_describeWindows];

    UIWindow *host = [self sp_keyWindowExcludingOverlay];
    NSString *hostBy = @"key";
    if (host == nil) {
        // 兜底一：没有 key 窗口时（加载中/被系统弹窗接管）退到「可见的普通层窗口」。
        host = [self sp_visibleNormalWindowExcludingOverlay];
        hostBy = @"visible(normal)";
    }

    // 兜底二（本轮新增，直接对应「悬浮球和悬浮窗都不出现」）：
    // 宿主窗口一个都找不到时，**只要有一个可用 scene 就把覆盖窗口建出来**，宿主退化为「仅记录」。
    //
    // 为什么要放宽：wfcore ui.m:496-516 的纪律是「先找到宿主 key window 才建窗」，
    // 那在它自己的宿主上够用；但在 AIR 宿主上，只要主窗口因任何原因从没被标记成
    // isKeyWindow（自绘窗口 / windowLevel 非 Normal / scene 激活晚于我们的看门狗…），
    // 我们就**永远不建窗** —— 表现不是「球位置不对」而是「什么都没有」，正是服主看到的现象。
    // 窗口属于 scene 而不是属于宿主窗口，所以提前建窗是安全的：宿主之后重建自己的窗口
    // 也不会把覆盖窗口带走（wfcore ui.m:79-116 注释讲的就是这件事）。
    UIWindowScene *scene = nil;
    if (@available(iOS 13.0, *)) {
        scene = host.windowScene;
        if (scene == nil) {
            scene = [self sp_preferredWindowScene];
        }
    }
    if (host == nil && scene == nil) {
        // 非 scene 宿主（App 没声明 UIApplicationSceneManifest 时，iOS 13+ 下
        // connectedScenes 是**空的**，窗口仍由 UIApplication 直接管）。AIR 打包的 App
        // 就可能是这一类：此时上面那条 scene 兜底也用不上，只能看「有没有窗口」。
        // 只要已经有窗口，就照样建窗 —— 走 initWithFrame: 这条老路径（窗口照样显示）。
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        NSUInteger appWindowCount = [UIApplication sharedApplication].windows.count;
#pragma clang diagnostic pop
        if (appWindowCount == 0) {
            NSString *result = @"FAIL 既没有宿主窗口也没有可用 scene（app 还没有任何窗口）";
            SPLoginLog(@"[SpLogin] overlay attach#%lu (reason=%@) %@ windows=[%@] %@",
                       (unsigned long)attempt, reason, result, windows, [self sp_overlayState]);
            SPLoginMarker(@"SpLogin-2-attach-latest",
                          [self sp_attachReportWithResult:result reason:reason attempt:attempt
                                                   hostBy:@"(无)" windows:windows], NO);
            return NO;
        }
        hostBy = @"frameless(non-scene)";
    }

    if (host == nil) {
        // 走到这里 = 宿主窗口没找到但窗照样要建。日志里必须一眼看出是哪条兜底生效的。
        hostBy = (scene != nil) ? @"scene-only(没有宿主窗口，仅记录)"
                                : @"frameless(non-scene：只按 UIScreen bounds 建窗)";
    }

    if (self.overlayWindow == nil) {
        [self sp_createOverlayWindowWithHost:host scene:scene];
        if (self.overlayWindow == nil) {
            NSString *result = [NSString stringWithFormat:@"FAIL 覆盖窗口创建失败 host=%@",
                                host != nil ? NSStringFromClass([host class]) : @"(nil)"];
            SPLoginLog(@"[SpLogin] overlay attach#%lu (reason=%@) %@ windows=[%@]",
                       (unsigned long)attempt, reason, result, windows);
            SPLoginMarker(@"SpLogin-2-attach-latest",
                          [self sp_attachReportWithResult:result reason:reason attempt:attempt
                                                   hostBy:hostBy windows:windows], NO);
            return NO;
        }
    } else if (@available(iOS 13.0, *)) {
        if (scene != nil && self.overlayWindow.windowScene != scene) {
            self.overlayWindow.windowScene = scene;   // 场景切换：把覆盖窗口迁过去
            SPLoginLog(@"[SpLogin] overlay windowScene 迁移（宿主 scene 变了）");
        }
    }

    self.hostWindow = host;

    if (self.overlayWindow.hidden) {
        self.overlayWindow.hidden = NO;   // 被系统/AIR 任何原因隐藏 -> 恢复（唯一显示手段）
        SPLoginLog(@"[SpLogin] overlay 之前被隐藏 -> hidden=NO 恢复");
    }

    UIView *root = self.overlayWindow.rootViewController.view;
    if (root == nil) {
        NSString *result = @"FAIL 覆盖窗口 root view 不存在";
        SPLoginLog(@"[SpLogin] overlay attach#%lu (reason=%@) %@ host=%@",
                   (unsigned long)attempt, reason, result,
                   host != nil ? NSStringFromClass([host class]) : @"(nil)");
        SPLoginMarker(@"SpLogin-2-attach-latest",
                      [self sp_attachReportWithResult:result reason:reason attempt:attempt
                                               hostBy:hostBy windows:windows], NO);
        return NO;
    }

    [self sp_ensureFloatingButtonInRoot:root];
    [self sp_reattachPanelViewInRoot:root];

    NSString *success = [NSString stringWithFormat:@"OK host=%@ hostBy=%@ 球=%@",
                         host != nil ? NSStringFromClass([host class]) : @"(nil)", hostBy,
                         self.floatingButton.superview != nil ? @"已挂上" : @"未挂上"];
    SPLoginLog(@"[SpLogin] overlay attach#%lu (reason=%@) %@ %@ windows=[%@]",
               (unsigned long)attempt, reason, success, [self sp_overlayState], windows);
    SPLoginMarker(@"SpLogin-2-attach-latest",
                  [self sp_attachReportWithResult:success reason:reason attempt:attempt
                                           hostBy:hostBy windows:windows], NO);

    if (self.pendingShow) {
        self.pendingShow = NO;
        SPLoginLog(@"[SpLogin] overlay 挂载完成，补开之前挂起的面板");
        [self sp_presentPanelWithReason:@"pendingShow"];
    }
    return YES;
}

#pragma mark - 宿主窗口选择

/// 宿主窗口全找不到时的兜底：优先「前台激活」的 UIWindowScene，其次任意一个 UIWindowScene。
/// 覆盖窗口挂到 scene 上，不依赖任何宿主窗口 —— 这是「宿主迟迟不成 key 也要有球」的关键。
- (UIWindowScene *)sp_preferredWindowScene
{
    if (@available(iOS 13.0, *)) {
        UIWindowScene *fallback = nil;
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            UIWindowScene *windowScene = (UIWindowScene *)scene;
            if (windowScene.activationState == UISceneActivationStateForegroundActive) {
                return windowScene;       // 前台激活：首选
            }
            if (fallback == nil) {
                fallback = windowScene;   // 其余（含 background）：只当备胎
            }
        }
        return fallback;
    }
    return nil;
}

- (NSString *)sp_attachReportWithResult:(NSString *)result
                                 reason:(NSString *)reason
                                attempt:(NSUInteger)attempt
                                 hostBy:(NSString *)hostBy
                                windows:(NSString *)windows
{
    return [NSString stringWithFormat:
            @"attach#%lu reason=%@\n结果=%@\n宿主取得方式=%@\n覆盖窗口=%@\n窗口列表=[%@]",
            (unsigned long)attempt, reason, result, hostBy, [self sp_overlayState], windows];
}

/// 扫 connectedScenes 里 UIWindowScene 的 windows，找 isKeyWindow **且不是 overlay 自己** 的那个；
/// 找不到再退回 [UIApplication sharedApplication].keyWindow（同样排除 overlay）。
- (nullable UIWindow *)sp_keyWindowExcludingOverlay
{
    UIWindow *overlay = self.overlayWindow;
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            for (UIWindow *window in ((UIWindowScene *)scene).windows) {
                if (window.isKeyWindow && window != overlay) {
                    return window;
                }
            }
        }
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    UIWindow *legacy = [UIApplication sharedApplication].keyWindow;
#pragma clang diagnostic pop
    return (legacy != nil && legacy != overlay) ? legacy : nil;
}

/// 没有 key 窗口时的兜底：可见、普通层级、非空 bounds 的第一个窗口（排除 overlay）。
- (nullable UIWindow *)sp_visibleNormalWindowExcludingOverlay
{
    UIWindow *overlay = self.overlayWindow;
    NSMutableArray<UIWindow *> *candidates = [NSMutableArray array];
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            [candidates addObjectsFromArray:((UIWindowScene *)scene).windows];
        }
    }
    [candidates addObjectsFromArray:[UIApplication sharedApplication].windows];
    for (UIWindow *window in candidates) {
        if (window == overlay || window.hidden || window.windowLevel != UIWindowLevelNormal) {
            continue;
        }
        if (CGRectIsEmpty(window.bounds)) {
            continue;
        }
        return window;
    }
    return nil;
}

#pragma mark - 覆盖窗口创建

- (void)sp_createOverlayWindowWithHost:(UIWindow *)host
                                 scene:(UIWindowScene *)scene
{
    UIWindow *window = nil;
    if (scene != nil) {
        window = [[UIWindow alloc] initWithWindowScene:scene];   // iOS 13+：必须带 scene，否则不显示
    } else {
        window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    }
    if (window == nil) {
        return;
    }
    window.windowLevel = UIWindowLevelStatusBar + kSpLoginOverlayLevelOffset;
    window.backgroundColor = [UIColor clearColor];
    window.rootViewController = [[SpLoginOverlayRootViewController alloc] init];
    window.hidden = NO;   // ★ 唯一显示手段：绝不 makeKeyAndVisible（AIR 对 key 变化敏感）
    self.overlayWindow = window;

    SPLoginLog(@"[SpLogin] overlay window 创建 lvl=%.0f scene=%@ host=%@ frame=(%.0f,%.0f,%.0fx%.0f) hidden=NO",
               window.windowLevel,
               scene != nil ? @"有" : @"无(退回 UIScreen bounds)",
               host != nil ? NSStringFromClass([host class]) : @"(nil)",
               window.frame.origin.x, window.frame.origin.y,
               window.frame.size.width, window.frame.size.height);
    SPLoginMarker(@"SpLogin-3-window", [NSString stringWithFormat:
                                        @"覆盖窗口已创建\nlevel=%.0f\nscene=%@\nhost=%@\nframe=%@",
                                        window.windowLevel,
                                        scene != nil ? @"有" : @"无",
                                        host != nil ? NSStringFromClass([host class]) : @"(nil)",
                                        NSStringFromCGRect(window.frame)], YES);
}

#pragma mark - 悬浮球

- (UIButton *)sp_makeFloatingButton
{
    UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
    CGRect screen = [UIScreen mainScreen].bounds;
    button.frame = CGRectMake(screen.size.width - kSpLoginBallSize - kSpLoginBallMargin,
                              kSpLoginBallTop, kSpLoginBallSize, kSpLoginBallSize);
    [button setTitle:@"登" forState:UIControlStateNormal];
    button.accessibilityLabel = @"SpLogin 服务器绑定";
    // 外观（圆形渐变 + 描边 + 光晕 + 内高光）整体交给皮肤层。
    // 行为一字未改：同样的 frame、同样的 target/pan、同样的常驻与拖动限制。
    [SpLoginTheme applyFloatingBallStyle:button diameter:kSpLoginBallSize];
    [button addTarget:self action:@selector(sp_pressDown:) forControlEvents:UIControlEventTouchDown];
    [button addTarget:self action:@selector(sp_pressUp:)
     forControlEvents:(UIControlEventTouchUpInside | UIControlEventTouchUpOutside |
                       UIControlEventTouchCancel)];
    [button addTarget:self action:@selector(togglePanel) forControlEvents:UIControlEventTouchUpInside];
    [button addGestureRecognizer:[[UIPanGestureRecognizer alloc] initWithTarget:self
                                                                       action:@selector(sp_handleBallPan:)]];
    return button;
}

- (void)sp_ensureFloatingButtonInRoot:(UIView *)root
{
    if (![SpLoginConfig sharedConfig].floatingButton) {
        if (self.floatingButton.superview != nil) {
            [self.floatingButton removeFromSuperview];
            SPLoginLog(@"[SpLogin] 悬浮球按 plist(SPLoginFloatingButton=false) 撤下");
        }
        // 覆盖写（append:NO）：这个分支每次挂载都会走到，用覆盖才不会把文件写爆。
        SPLoginMarker(@"SpLogin-3-ball",
                      @"悬浮球当前是关的：plist 里 SPLoginFloatingButton=false。\n"
                      @"（如果这不是你想要的，删掉那个键或改成 true 再重启 App）", NO);
        return;
    }
    if (self.floatingButton == nil) {
        self.floatingButton = [self sp_makeFloatingButton];
        SPLoginLog(@"[SpLogin] 悬浮球创建（%.0fx%.0f，可拖动，点击开/关面板）", kSpLoginBallSize, kSpLoginBallSize);
    }
    if (self.floatingButton.superview != root) {   // 幂等：只在没挂上时挂
        [self.floatingButton removeFromSuperview];
        [root addSubview:self.floatingButton];
        SPLoginLog(@"[SpLogin] 悬浮球挂到覆盖窗口 root=(%.0fx%.0f)",
                   root.bounds.size.width, root.bounds.size.height);
        SPLoginMarker(@"SpLogin-3-ball", [NSString stringWithFormat:
                                          @"悬浮球已挂上覆盖窗口\nroot=(%.0fx%.0f)\nframe=%@\n"
                                          @"windowLevel=%.0f  hidden=%@",
                                          root.bounds.size.width, root.bounds.size.height,
                                          NSStringFromCGRect(self.floatingButton.frame),
                                          self.overlayWindow.windowLevel,
                                          self.overlayWindow.hidden ? @"YES" : @"NO"], YES);
    }
    [self sp_clampBallInsideRoot:root];   // 旋转/换 scene 后把球拉回屏内
    [self sp_animateBallPulseIfNeeded];   // 纯视觉呼吸（幂等；关掉皮肤则不动）
}

- (void)sp_clampBallInsideRoot:(UIView *)root
{
    UIButton *ball = self.floatingButton;
    if (ball == nil || CGRectIsEmpty(root.bounds)) {
        return;
    }
    CGFloat half = kSpLoginBallSize / 2.0 + 4.0;
    CGPoint center = ball.center;
    center.x = MAX(half, MIN(CGRectGetWidth(root.bounds) - half, center.x));
    center.y = MAX(half, MIN(CGRectGetHeight(root.bounds) - half, center.y));
    ball.center = center;
}

- (void)sp_handleBallPan:(UIPanGestureRecognizer *)gesture
{
    UIView *ball = gesture.view;
    UIView *root = ball.superview;
    if (ball == nil || root == nil) {
        return;
    }
    CGPoint translation = [gesture translationInView:root];
    ball.center = CGPointMake(ball.center.x + translation.x, ball.center.y + translation.y);
    [gesture setTranslation:CGPointZero inView:root];
    [self sp_clampBallInsideRoot:root];
}

#pragma mark - 悬浮球：纯视觉反馈（呼吸 + 按压）

/// 呼吸：官方圆形按钮（circle-assets/color2ec4b6_radius64_glow6_shadow8）自带发光，
/// 静态图在真机上像「贴纸」，给它一层 1.7s 的极轻微缩放，观感上更像游戏里会呼吸的按钮。
/// 只动 transform（不改 frame/center/hitTest 结果），且尊重「减弱动态效果」无障碍开关。
- (void)sp_animateBallPulseIfNeeded
{
    UIButton *ball = self.floatingButton;
    if (ball == nil || self.ballPulsing) {
        return;
    }
    if (![SpLoginConfig sharedConfig].skinEnabled) {
        return;   // 皮肤关掉：球保持静态（旧观感）
    }
    if (UIAccessibilityIsReduceMotionEnabled()) {
        return;   // 无障碍：不做动画
    }
    self.ballPulsing = YES;
    CABasicAnimation *pulse = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
    pulse.fromValue = @1.0;
    pulse.toValue = @1.045;
    pulse.duration = 1.7;
    pulse.autoreverses = YES;              // 来回缩放 = 呼吸
    pulse.repeatCount = HUGE_VALF;
    pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    pulse.removedOnCompletion = NO;
    pulse.fillMode = kCAFillModeForwards;  // 与「点一下球」时的 0.94 按压动画共用 transform，避免闪回
    [ball.layer addAnimation:pulse forKey:@"SpLoginBallPulse"];
    SPLoginLog(@"[SpLogin] skin: 悬浮球呼吸动画已开（1.7s 循环，仅 transform）");
}

- (void)sp_pressDown:(UIControl *)control
{
    if (UIAccessibilityIsReduceMotionEnabled()) {
        return;
    }
    // 呼吸动画会盖住按压的缩放（presentation layer 优先），按下时先摘掉它。
    if (control == self.floatingButton) {
        [control.layer removeAnimationForKey:@"SpLoginBallPulse"];
        self.ballPulsing = NO;
    }
    [UIView animateWithDuration:0.09
                          delay:0.0
                        options:(UIViewAnimationOptionBeginFromCurrentState |
                                 UIViewAnimationOptionAllowUserInteraction)
                     animations:^{
        control.transform = CGAffineTransformMakeScale(0.94, 0.94);
    } completion:nil];
    CABasicAnimation *glow = [CABasicAnimation animationWithKeyPath:@"opacity"];
    glow.fromValue = @1.0;
    glow.toValue = @0.55;
    glow.duration = 0.09;
    glow.removedOnCompletion = NO;
    glow.fillMode = kCAFillModeForwards;
    [control.layer addAnimation:glow forKey:@"SpLoginPressGlow"];
}

- (void)sp_pressUp:(UIControl *)control
{
    // 无条件复位：即便「减弱动态效果」中途被打开，也不能把控件留在按下去的缩放态。
    control.transform = CGAffineTransformIdentity;
    [control.layer removeAnimationForKey:@"SpLoginPressGlow"];
    if (control == self.floatingButton) {
        [self sp_animateBallPulseIfNeeded];   // 松手后接回呼吸（幂等）
    }
}

#pragma mark - 面板（复用 SpLoginViewController，不动业务逻辑）

- (void)sp_reattachPanelViewInRoot:(UIView *)root
{
    // 幂等：面板 view 只会因为覆盖窗口被重建才丢，重挂一次即可（不重建 VC，状态不丢）。
    if (self.panelController != nil && self.panelController.isViewLoaded &&
        self.panelController.view.superview != root) {
        [root addSubview:self.panelController.view];
        SPLoginLog(@"[SpLogin] 面板 view 重新挂回覆盖窗口 root（状态保留）");
    }
}

- (void)sp_ensurePanelControllerInRoot:(UIView *)root
{
    UIViewController *host = self.overlayWindow.rootViewController;
    if (self.panelController == nil) {
        self.panelController = [[SpLoginViewController alloc] init];
        SPLoginLog(@"[SpLogin] 登录面板 VC 创建（复用 SpLoginViewController，业务逻辑未改）");
    }
    if (self.panelController.parentViewController != host) {
        [host addChildViewController:self.panelController];
        self.panelController.view.frame = host.view.bounds;
        self.panelController.view.autoresizingMask = UIViewAutoresizingFlexibleWidth |
                                                     UIViewAutoresizingFlexibleHeight;
        self.panelController.view.hidden = YES;   // 没打开时藏起来：hidden 的 view 不参与 hitTest
        [host.view addSubview:self.panelController.view];
        [self.panelController didMoveToParentViewController:host];

        // 点面板外的遮罩关闭面板（面板内控件不受影响：cancelsTouchesInView=NO + 只有点在遮罩本身才触发）
        UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                                             action:@selector(sp_scrimTapped:)];
        tap.delegate = self;
        tap.cancelsTouchesInView = NO;
        [self.panelController.view addGestureRecognizer:tap];

        SPLoginLog(@"[SpLogin] 登录面板 view 已挂到覆盖窗口（hidden=YES，点面板外空白可关闭）");
    } else if (self.panelController.view.superview != root) {
        [root addSubview:self.panelController.view];
    }

    // 续轮询的显式触发点（本类**刻意不做** appearance 过渡，见文件头注释与 README 第 5 节）：
    //   `addChildViewController:` + 直接 hidden=NO 不会让子 VC 收到 viewDidAppear:，
    //   而「本地已有令牌 ⇒ 继续轮询 /sp-auth/bind-status」原本只写在 viewDidAppear: 里，
    //   所以覆盖窗口这条路径冷启动时**不会**自己续上（用户得手点一次主按钮）。
    //   改成让本 VC 提供幂等方法在这里显式调一次：没令牌 ⇒ 什么都不做（不发请求、不弹面板）；
    //   已经有 pollTimer ⇒ 直接跳过。挂载路径（timer1.5s / keyWindowChanged / watchdog5s /
    //   showPanel / pendingShow 补开）全部汇到这里，任意重复调用都不会叠加定时器。
    [self.panelController sp_resumeFromStoredTokenIfNeeded];
}

- (void)sp_scrimTapped:(UITapGestureRecognizer *)gesture
{
    SPLoginLog(@"[SpLogin] overlay 点到面板外的遮罩 -> 关闭面板");
    [self hidePanel];
}

- (void)sp_presentPanelWithReason:(NSString *)reason
{
    if (self.overlayWindow == nil) {
        return;
    }
    UIView *root = self.overlayWindow.rootViewController.view;
    if (root == nil) {
        return;
    }
    [self sp_ensurePanelControllerInRoot:root];
    if (self.panelController == nil) {
        return;
    }
    BOOL wasHidden = self.panelController.view.hidden;
    self.panelController.view.hidden = NO;
    // 悬浮球要浮在面板之上，否则面板打开后就没法点它关掉了
    if (self.floatingButton.superview == root) {
        [root bringSubviewToFront:self.floatingButton];
    }
    if (wasHidden) {
        // 入场动画（纯视觉）。放在 hidden=NO 之后、日志之前：
        // 动画只动 transform/opacity，不改 hidden，所以 `-isPanelVisible` 与 `pendingShow` 语义不变；
        // 关键是它不引入任何延迟——面板立刻可点，动画只是叠在已就位的视图上。
        [self sp_animatePanelIn];
        SPLoginLog(@"[SpLogin] overlay panel shown (reason=%@) %@", reason, [self sp_overlayState]);
        SPLoginMarker(@"SpLogin-4-panel", [NSString stringWithFormat:
                                           @"登录面板已打开（reason=%@）\n%@",
                                           reason, [self sp_overlayState]], YES);
    }
}

/// 面板入场：从 0.94 缩放 + 略偏下 + 透明，弹回原位（仿游戏内弹窗的「弹出」）。
/// 只动 transform/alpha；键盘避让用的 transform 在动画开始前取当前值、结束后原样放回。
- (void)sp_animatePanelIn
{
    UIView *view = self.panelController.view;
    if (view == nil) {
        return;
    }
    if (![SpLoginConfig sharedConfig].skinEnabled || UIAccessibilityIsReduceMotionEnabled()) {
        return;   // 皮肤关掉 / 无障碍减弱动态效果：直接出现（旧行为）
    }
    CGAffineTransform resting = view.transform;   // 可能已经有键盘避让的位移，别丢掉
    view.transform = CGAffineTransformConcat(CGAffineTransformMakeScale(0.94, 0.94),
                                             CGAffineTransformTranslate(resting, 0.0, 18.0));
    view.alpha = 0.0;
    [UIView animateWithDuration:0.26
                          delay:0.0
         usingSpringWithDamping:0.72
          initialSpringVelocity:0.4
                        options:UIViewAnimationOptionAllowUserInteraction |
                                UIViewAnimationOptionBeginFromCurrentState
                     animations:^{
        view.transform = resting;
        view.alpha = 1.0;
    } completion:^(BOOL finished) {
        view.transform = resting;
        view.alpha = 1.0;
    }];
    SPLoginLog(@"[SpLogin] skin: 面板入场动画（0.26s 弹簧，仅 transform/alpha）");
}

- (BOOL)showPanel
{
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self showPanel];
        });
        return NO;
    }
    self.pendingShow = YES;   // 宿主窗口还没就绪时先挂起，挂上后由 sp_attachWithReason: 补开
    if (![self sp_attachWithReason:@"showPanel"]) {
        SPLoginLog(@"[SpLogin] overlay showPanel 挂起：宿主窗口还没就绪，挂上后自动打开");
        return NO;
    }
    self.pendingShow = NO;
    [self sp_presentPanelWithReason:@"showPanel"];
    return self.isPanelVisible;
}

- (void)hidePanel
{
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self hidePanel];
        });
        return;
    }
    self.pendingShow = NO;
    if (self.panelController == nil || !self.panelController.isViewLoaded || self.panelController.view.hidden) {
        return;
    }
    [self.panelController.view endEditing:YES];   // 收键盘 -> 触发 key 归还宿主
    // 出场：先看一眼本代面板的 transform（可能带着键盘避让的位移），缩放淡出后**原样放回**。
    // 键盘避让与 `hidden=YES` 都写在下面，顺序不变 —— 只是藏起来之前多看了一眼。
    CGAffineTransform resting = self.panelController.view.transform;
    if ([SpLoginConfig sharedConfig].skinEnabled && !UIAccessibilityIsReduceMotionEnabled()) {
        self.panelController.view.transform = resting;
        self.panelController.view.alpha = 1.0;
        __weak typeof(self) weakSelf = self;
        [UIView animateWithDuration:0.16
                              delay:0.0
                            options:UIViewAnimationOptionAllowUserInteraction |
                                    UIViewAnimationOptionBeginFromCurrentState
                         animations:^{
            __strong typeof(self) strongSelf = weakSelf;
            UIView *panel = strongSelf.panelController.view;
            panel.alpha = 0.0;
            panel.transform = CGAffineTransformConcat(CGAffineTransformMakeScale(0.96, 0.96), resting);
        } completion:^(BOOL finished) {
            __strong typeof(self) strongSelf = weakSelf;
            UIView *panel = strongSelf.panelController.view;
            panel.transform = resting;
            panel.alpha = 1.0;
        }];
    }
    self.panelController.view.hidden = YES;       // 连同 hitTest 一起让开：触摸立刻回到游戏
    [self.panelController adjustForKeyboardTop:0];
    SPLoginLog(@"[SpLogin] overlay panel hidden（触摸已交还游戏）%@", [self sp_overlayState]);
}

- (void)togglePanel
{
    if (self.isPanelVisible) {
        [self hidePanel];
    } else {
        [self showPanel];
    }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
    // 只有点在面板外的遮罩本身才关闭面板；点在面板卡片的按钮/输入框上不关。
    return touch.view == self.panelController.view;
}

#pragma mark - 键盘：仅编辑期间抢 key，结束立刻归还

- (void)sp_installKeyboardObservers
{
    if (self.keyboardObserversInstalled) {
        return;
    }
    self.keyboardObserversInstalled = YES;
    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    [center addObserver:self selector:@selector(sp_textDidBeginEditing:)
                   name:UITextFieldTextDidBeginEditingNotification object:nil];
    [center addObserver:self selector:@selector(sp_textDidEndEditing:)
                   name:UITextFieldTextDidEndEditingNotification object:nil];
    [center addObserver:self selector:@selector(sp_keyboardFrameChanged:)
                   name:UIKeyboardWillChangeFrameNotification object:nil];
    [center addObserver:self selector:@selector(sp_keyboardWillHide:)
                   name:UIKeyboardWillHideNotification object:nil];
}

/// 只认我们自己面板里的输入框（游戏自己的键盘/输入框一概不管）。
- (BOOL)sp_isOverlayField:(nullable id)object
{
    if (![object isKindOfClass:[UIView class]] || self.overlayWindow == nil) {
        return NO;
    }
    return [(UIView *)object isDescendantOfView:self.overlayWindow];
}

- (void)sp_textDidBeginEditing:(NSNotification *)note
{
    if (![self sp_isOverlayField:note.object] || self.overlayWindow == nil) {
        return;
    }
    if (self.overlayWindow.isKeyWindow) {
        return;
    }
    [self.overlayWindow makeKeyWindow];   // 键盘只认 key window；仅编辑期间抢一次
    SPLoginLog(@"[SpLogin] overlay key<-overlay（文本输入需要键盘）");
}

- (void)sp_textDidEndEditing:(NSNotification *)note
{
    if (![self sp_isOverlayField:note.object]) {
        return;
    }
    [self sp_restoreHostKeyWithReason:@"编辑结束"];
    [self.panelController adjustForKeyboardTop:0];
}

/// 把 key 还给宿主窗口。此刻 overlay 自己往往就是 key，**不能**现查「谁是 key」——
/// 必须用挂载时记录的 hostWindow（wfcore ui.m:352-357 的教训）。
- (void)sp_restoreHostKeyWithReason:(NSString *)reason
{
    UIWindow *host = self.hostWindow;
    if (host == nil) {
        host = [self sp_keyWindowExcludingOverlay];
    }
    if (host == nil) {
        host = [self sp_visibleNormalWindowExcludingOverlay];   // 宿主被重建过时的兜底
    }
    if (host == nil || host.isKeyWindow) {
        return;
    }
    [host makeKeyWindow];
    SPLoginLog(@"[SpLogin] overlay key->host（%@，key 归还游戏窗口 %@）", reason, NSStringFromClass([host class]));
}

/// 看门狗兜底：overlay 还是 key，但面板里没有任何输入框在编辑 -> 主动归还（防止某次通知丢失后
/// 游戏一直拿不到 key 而卡输入）。
- (void)sp_restoreHostKeyIfIdle
{
    if (self.overlayWindow == nil || !self.overlayWindow.isKeyWindow) {
        return;
    }
    if (self.panelController == nil || !self.panelController.isViewLoaded) {
        return;
    }
    if (SpLoginViewHasFirstResponder(self.panelController.view)) {
        return;
    }
    [self sp_restoreHostKeyWithReason:@"看门狗：没有输入框在编辑"];
}

- (void)sp_keyboardFrameChanged:(NSNotification *)note
{
    if (self.panelController == nil || !self.panelController.isViewLoaded || self.panelController.view.hidden) {
        return;
    }
    NSValue *value = note.userInfo[UIKeyboardFrameEndUserInfoKey];
    if (![value isKindOfClass:[NSValue class]] || self.overlayWindow == nil) {
        return;
    }
    // 键盘 frame 是屏幕坐标；overlay 窗口是全屏窗口，先换算到窗口坐标再交给面板做避让。
    CGRect keyboard = [self.overlayWindow convertRect:value.CGRectValue fromWindow:nil];
    [self.panelController adjustForKeyboardTop:CGRectGetMinY(keyboard)];
}

- (void)sp_keyboardWillHide:(NSNotification *)note
{
    (void)note;   // 键盘收起：无条件复位面板位移
    [self.panelController adjustForKeyboardTop:0];
}

#pragma mark - 取证（日志）

/// 把「扫到的窗口」压成一行：类名 / level / 是否 key / 是否 hidden / scene / 尺寸。
- (NSString *)sp_describeWindows
{
    NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            [windows addObjectsFromArray:((UIWindowScene *)scene).windows];
        }
    }
    if (windows.count == 0) {
        [windows addObjectsFromArray:[UIApplication sharedApplication].windows];
    }

    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    NSUInteger index = 0;
    for (UIWindow *window in windows) {
        if (index >= kSpLoginWindowListLimit) {
            [parts addObject:[NSString stringWithFormat:@"…(共%lu个)", (unsigned long)windows.count]];
            break;
        }
        BOOL sceneReady = NO;
        if (@available(iOS 13.0, *)) {
            sceneReady = (window.windowScene != nil);
        }
        [parts addObject:[NSString stringWithFormat:@"#%lu %@(lvl=%.0f,key=%d,hid=%d,scene=%d,%.0fx%.0f%@)",
                          (unsigned long)index,
                          NSStringFromClass([window class]),
                          window.windowLevel,
                          window.isKeyWindow ? 1 : 0,
                          window.hidden ? 1 : 0,
                          sceneReady ? 1 : 0,
                          window.bounds.size.width,
                          window.bounds.size.height,
                          (window == self.overlayWindow) ? @",OVERLAY" : @""]];
        index += 1;
    }
    if (parts.count == 0) {
        [parts addObject:@"(一个窗口都没有)"];
    }
    return [parts componentsJoinedByString:@" "];
}

/// overlay 自己的状态：建没建、hidden、windowLevel、windowScene 就绪、root/球/面板在不在。
- (NSString *)sp_overlayState
{
    if (self.overlayWindow == nil) {
        return @"overlay=未创建";
    }
    BOOL sceneReady = NO;
    if (@available(iOS 13.0, *)) {
        sceneReady = (self.overlayWindow.windowScene != nil);
    }
    BOOL rootReady = (self.overlayWindow.rootViewController.view != nil);
    NSString *panel = @"未创建";
    if (self.panelController != nil && self.panelController.isViewLoaded) {
        panel = self.panelController.view.hidden ? @"hidden" : @"shown";
    }
    return [NSString stringWithFormat:@"overlay=已创建(lvl=%.0f,hid=%d,scene=%d,root=%@,ball=%@,panel=%@)",
            self.overlayWindow.windowLevel,
            self.overlayWindow.hidden ? 1 : 0,
            sceneReady ? 1 : 0,
            rootReady ? @"y" : @"n",
            self.isFloatingButtonVisible ? @"y" : @"n",
            panel];
}

@end

#pragma mark - 小工具

/// 面板里有没有输入框正在编辑（键盘需要 key 的判据）。
static BOOL SpLoginViewHasFirstResponder(UIView *view)
{
    if (view.isFirstResponder) {
        return YES;
    }
    for (UIView *subview in view.subviews) {
        if (SpLoginViewHasFirstResponder(subview)) {
            return YES;
        }
    }
    return NO;
}
