//
//  CdnImporterOverlay.m
//

#import "CdnImporterOverlay.h"

#import "CdnImporterConfig.h"
#import "CdnImporterPanelViewController.h"

static const CGFloat kCdnBallSize = 56.0;

#pragma mark - 穿透宿主 VC

/// 命中自身时返回 nil，让触摸继续传给下层（游戏）窗口；子视图（球 / 面板）正常命中。
@interface CdnImporterPassthroughView : UIView
@end

@implementation CdnImporterPassthroughView

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:point withEvent:event];
    return hit == self ? nil : hit;
}

@end

@interface CdnImporterPassthroughViewController : UIViewController
@end

@implementation CdnImporterPassthroughViewController

- (void)loadView {
    self.view = [[CdnImporterPassthroughView alloc] initWithFrame:CGRectZero];
    self.view.backgroundColor = [UIColor clearColor];
}

- (BOOL)prefersStatusBarHidden {
    return NO;
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
    return UIInterfaceOrientationMaskAll;
}

@end

#pragma mark - 悬浮球

@interface CdnImporterBallView : UIView
@end

@implementation CdnImporterBallView

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self != nil) {
        self.backgroundColor = [UIColor colorWithRed:0.09 green:0.36 blue:0.66 alpha:0.92];
        self.layer.cornerRadius = frame.size.width / 2.0;
        self.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.65].CGColor;
        self.layer.borderWidth = 1.5;
        self.layer.shadowColor = [UIColor blackColor].CGColor;
        self.layer.shadowOpacity = 0.35;
        self.layer.shadowRadius = 4;
        self.layer.shadowOffset = CGSizeMake(0, 2);

        UILabel *label = [[UILabel alloc] initWithFrame:self.bounds];
        label.text = @"CDN";
        label.textColor = [UIColor whiteColor];
        label.textAlignment = NSTextAlignmentCenter;
        label.font = [UIFont boldSystemFontOfSize:15];
        label.userInteractionEnabled = NO;
        [self addSubview:label];
    }
    return self;
}

@end

#pragma mark - 覆盖层

@interface CdnImporterOverlay ()
@property (nonatomic, strong, nullable) UIWindow *window;
@property (nonatomic, strong, nullable) CdnImporterBallView *ball;
@property (nonatomic, strong, nullable) CdnImporterPanelViewController *panel;
@property (nonatomic, strong, nullable) NSTimer *watchdog;
@property (nonatomic, strong) NSMutableArray<NSLayoutConstraint *> *ballConstraints;
@end

@implementation CdnImporterOverlay

+ (instancetype)sharedOverlay {
    static CdnImporterOverlay *overlay = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        overlay = [[CdnImporterOverlay alloc] init];
    });
    return overlay;
}

- (instancetype)init {
    self = [super init];
    if (self != nil) {
        _ballConstraints = [NSMutableArray array];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleWindowBecameKey:)
                                                     name:UIWindowDidBecomeKeyNotification
                                                   object:nil];
    }
    return self;
}

- (void)dealloc {
    [_watchdog invalidate];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - 安装

- (void)install {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self install];
        });
        return;
    }

    UIWindowScene *scene = [self activeWindowScene];
    if (scene == nil) {
        // 场景还没就绪：稍后重试（App 启动早期会走到这里）
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self install];
        });
        return;
    }

    if (self.window == nil || self.window.windowScene != scene) {
        [self buildWindowWithScene:scene];
    }

    // 只 hidden = NO，不 makeKeyAndVisible：绝不抢游戏窗口的 key 身份
    self.window.hidden = NO;
    [self.window setWindowLevel:UIWindowLevelStatusBar + 120.0];

    if (self.ball.superview == nil) {
        [self.window addSubview:self.ball];
        [self layoutBall];
    }

    [self startWatchdog];
    CdnImporterLog(@"[overlay] 悬浮球已就位（window=%@ scene=%@）", self.window, NSStringFromClass(scene.class));
}

- (nullable UIWindowScene *)activeWindowScene {
    for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        if (scene.activationState == UISceneActivationStateForegroundActive) return (UIWindowScene *)scene;
    }
    for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
        if ([scene isKindOfClass:[UIWindowScene class]]) return (UIWindowScene *)scene;
    }
    return nil;
}

- (void)buildWindowWithScene:(UIWindowScene *)scene {
    [self.watchdog invalidate];
    self.watchdog = nil;

    UIWindow *window = [[UIWindow alloc] initWithWindowScene:scene];
    window.windowLevel = UIWindowLevelStatusBar + 120.0;
    window.backgroundColor = [UIColor clearColor];
    window.rootViewController = [[CdnImporterPassthroughViewController alloc] init];
    window.hidden = NO;

    self.window = window;

    if (self.ball == nil) {
        CdnImporterBallView *ball = [[CdnImporterBallView alloc] initWithFrame:CGRectMake(0, 0, kCdnBallSize, kCdnBallSize)];
        ball.translatesAutoresizingMaskIntoConstraints = NO;
        ball.userInteractionEnabled = YES;
        [ball addGestureRecognizer:[[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(handleBallPan:)]];
        [ball addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(handleBallTap:)]];
        self.ball = ball;
    }
}

- (void)layoutBall {
    UIView *window = self.window;
    CdnImporterBallView *ball = self.ball;
    if (window == nil || ball == nil) return;

    [NSLayoutConstraint deactivateConstraints:self.ballConstraints];
    [self.ballConstraints removeAllObjects];

    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    CGFloat size = kCdnBallSize;
    CGFloat maxX = MAX(0, window.bounds.size.width - size);
    CGFloat maxY = MAX(0, window.bounds.size.height - size);
    CGFloat x = [defaults objectForKey:CdnImporterBallXKey] != nil
        ? (CGFloat)[defaults doubleForKey:CdnImporterBallXKey]
        : window.bounds.size.width - size - 12.0;
    CGFloat y = [defaults objectForKey:CdnImporterBallYKey] != nil
        ? (CGFloat)[defaults doubleForKey:CdnImporterBallYKey]
        : window.bounds.size.height * 0.35;
    x = MIN(MAX(0, x), maxX);
    y = MIN(MAX(0, y), maxY);

    [self.ballConstraints addObject:[ball.widthAnchor constraintEqualToConstant:size]];
    [self.ballConstraints addObject:[ball.heightAnchor constraintEqualToConstant:size]];
    [self.ballConstraints addObject:[ball.leadingAnchor constraintEqualToAnchor:window.leadingAnchor constant:x]];
    [self.ballConstraints addObject:[ball.topAnchor constraintEqualToAnchor:window.topAnchor constant:y]];
    [NSLayoutConstraint activateConstraints:self.ballConstraints];
}

- (void)setBallVisible:(BOOL)visible {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self setBallVisible:visible];
        });
        return;
    }
    self.ball.hidden = !visible;
}

#pragma mark - 保活（三条路幂等：定时器 + 窗口变 key + 手动 install）

- (void)startWatchdog {
    if (self.watchdog != nil) return;
    self.watchdog = [NSTimer scheduledTimerWithTimeInterval:2.0
                                                    repeats:YES
                                                      block:^(NSTimer *timer) {
        UIWindow *window = self.window;
        if (window == nil) {
            [self install];
            return;
        }
        if (window.hidden) window.hidden = NO;
        if (self.ball.superview == nil) {
            [window addSubview:self.ball];
            [self layoutBall];
        }
        if (window.rootViewController.view.superview == nil) {
            // 窗口被系统摘掉视图层级时的兜底
            window.hidden = NO;
        }
    }];
}

- (void)handleWindowBecameKey:(NSNotification *)note {
    if (![NSThread isMainThread]) return;
    UIWindow *window = self.window;
    if (window == nil) {
        [self install];
        return;
    }
    if (window.hidden) window.hidden = NO;
    [window setWindowLevel:UIWindowLevelStatusBar + 120.0];
}

#pragma mark - 交互

- (void)handleBallPan:(UIPanGestureRecognizer *)gesture {
    UIView *window = self.window;
    CdnImporterBallView *ball = self.ball;
    if (window == nil || ball == nil) return;

    CGPoint translation = [gesture translationInView:window];
    [gesture setTranslation:CGPointZero inView:window];

    CGPoint center = ball.center;
    center.x += translation.x;
    center.y += translation.y;
    CGFloat half = kCdnBallSize / 2.0;
    center.x = MIN(MAX(half, center.x), MAX(half, window.bounds.size.width - half));
    center.y = MIN(MAX(half, center.y), MAX(half, window.bounds.size.height - half));
    ball.center = center;

    if (gesture.state == UIGestureRecognizerStateEnded || gesture.state == UIGestureRecognizerStateCancelled) {
        CGRect frame = ball.frame;
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setDouble:frame.origin.x forKey:CdnImporterBallXKey];
        [defaults setDouble:frame.origin.y forKey:CdnImporterBallYKey];
    }
}

- (void)handleBallTap:(UITapGestureRecognizer *)gesture {
    [self showPanel];
}

- (void)showPanel {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self showPanel];
        });
        return;
    }
    UIWindow *window = self.window;
    if (window == nil) {
        [self install];
        return;
    }

    if (self.panel == nil) {
        CdnImporterPanelViewController *panel = [[CdnImporterPanelViewController alloc] init];
        __weak typeof(self) weakSelf = self;
        panel.closeHandler = ^{
            [weakSelf hidePanel];
        };
        self.panel = panel;
    }

    UIViewController *host = window.rootViewController;
    if (self.panel.parentViewController != host) {
        [host addChildViewController:self.panel];
    }

    CGFloat width = MIN(window.bounds.size.width - 24.0, 380.0);
    CGFloat height = MIN(window.bounds.size.height - 80.0, 560.0);
    self.panel.view.frame = CGRectMake((window.bounds.size.width - width) / 2.0,
                                       (window.bounds.size.height - height) / 2.0,
                                       width, height);
    self.panel.view.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin |
        UIViewAutoresizingFlexibleTopMargin | UIViewAutoresizingFlexibleBottomMargin;
    if (self.panel.view.superview == nil) {
        [host.view addSubview:self.panel.view];
    }
    [self.panel didMoveToParentViewController:host];
    self.panel.view.hidden = NO;
    [self.panel refreshFromDisk];
}

- (void)hidePanel {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self hidePanel];
        });
        return;
    }
    self.panel.view.hidden = YES;
}

@end
