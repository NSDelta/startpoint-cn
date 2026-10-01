// SpLoginViewController.m —— 类游戏登录面板实现（P10-B）
//
// 有话术自写：不复用任何他人产物里的字符串或颜色常量（B 线红线）。唯一外部依据是
// `D:\wfcnmod\ios-ui-kit\style-tokens.json`（官方 token）与契约 C1/C7。

#import "SpLoginViewController.h"
#import "SpLoginAPI.h"
#import "SpLoginConfig.h"
#import "SpLoginOverlay.h"
#import "SpLoginTheme.h"

typedef NS_ENUM(NSInteger, SpLoginUIState) {
    SpLoginUIStateWaitingCode = 0,
    SpLoginUIStateCodeShown,
    SpLoginUIStateBinding,
    SpLoginUIStateError,
    SpLoginUIStateSuccess,
};

typedef NS_ENUM(NSInteger, SpLoginUIMode) {
    SpLoginUIModeCreate = 0,   // 新账号：QQ 号 + 密码 + 确认密码
    SpLoginUIModeExisting,     // 我已有账号：QQ 号 + 密码
};

static const NSTimeInterval SpLoginPollInterval = 3.0;
static const NSInteger SpLoginPollLimit = 100;   // 3s × 100 ≈ 5 分钟；到点就提示手动重试

// 皮肤层开关（plist 选填键 `SPLoginSkinEnabled`，默认 YES）。
// 关掉时 buildViews 走「旧通用表单」那条分支：只换颜色/圆角，不改任何布局与行为。
static BOOL SpLoginSkinEnabled(void)
{
    return [SpLoginConfig sharedConfig].skinEnabled;
}

#pragma mark - 皮肤层：验证码逐位显示

/// 只看不写的 UILabel：业务代码写 `self.codeLabel.text = code`（这一行没动），
/// 本子类在 setText: 里把同一个字符串拆成逐位方块。业务侧完全不知道这件事。
@interface SpLoginCodeLabel : UILabel
@property (nonatomic, copy, nullable) void (^sp_onTextChanged)(NSString * _Nullable text);
@end

@implementation SpLoginCodeLabel

- (void)setText:(NSString *)text
{
    [super setText:text];
    void (^handler)(NSString *) = self.sp_onTextChanged;
    if (handler != nil) {
        handler(text);
    }
}

@end

#pragma mark - 外观构件

/// 自带 `CAGradientLayer` 的容器（走 `layerClass`，不是 `addSublayer:`）。
///
/// 为什么必须有这个类：`[view.layer addSublayer:gradient]` 加进去的层是**独立坐标系**，
/// Auto Layout 改的是 `view.bounds`，那层不会跟着走 —— 上一版面板上下两根装饰条
/// 就是这么错位的。让渐变成 view 自己的 layer，尺寸自动同步，这一类问题从根上消失。
@interface SpLoginGradientView : UIView
@property (nonatomic, strong, readonly) CAGradientLayer *sp_gradient;
/// 竖向渐变（上 → 下）。构造即定型，调用方只需再上圆角/约束。
+ (instancetype)sp_verticalGradientWithColors:(NSArray<UIColor *> *)colors
                                    locations:(nullable NSArray<NSNumber *> *)locations;
@end

@implementation SpLoginGradientView

+ (Class)layerClass
{
    return [CAGradientLayer class];
}

- (CAGradientLayer *)sp_gradient
{
    return (CAGradientLayer *)self.layer;
}

/// 竖向渐变（上 → 下）。构造即定型，调用方只需再上圆角/约束。
+ (instancetype)sp_verticalGradientWithColors:(NSArray<UIColor *> *)colors
                                    locations:(nullable NSArray<NSNumber *> *)locations
{
    SpLoginGradientView *view = [[self alloc] initWithFrame:CGRectZero];
    NSMutableArray *cgColors = [NSMutableArray arrayWithCapacity:colors.count];
    for (UIColor *color in colors) {
        [cgColors addObject:(__bridge id)color.CGColor];
    }
    view.sp_gradient.colors = cgColors;
    view.sp_gradient.locations = locations;
    view.sp_gradient.startPoint = CGPointMake(0.5, 0.0);
    view.sp_gradient.endPoint = CGPointMake(0.5, 1.0);
    view.translatesAutoresizingMaskIntoConstraints = NO;
    return view;
}

@end

/// 渐变底的主按钮：`layer` 本身就是渐变层，圆角 / 裁切 / 高亮全部照常生效。
@interface SpLoginGradientButton : UIButton
@end

@implementation SpLoginGradientButton

+ (Class)layerClass
{
    return [CAGradientLayer class];
}

- (void)setHighlighted:(BOOL)highlighted
{
    [super setHighlighted:highlighted];
    // 深色卡片上没有系统自带的高亮反馈，用透明度做按压态（纯视觉，不碰业务）。
    self.alpha = highlighted ? 0.82 : 1.0;
}

@end

#pragma mark - 深色卡片色板

// 上一版面板直接照搬官方浅色 token（#FAFAFA 底 + #444444 字），压在游戏彩色画面上
// 就是「白天面板糊在夜里画面上」：浅底四周漏白、深灰字看不见。这一版整体换成深色卡片，
// 只有主色仍取官方 token（#2EC4B6），保证和游戏的青色调性一致。
static UIColor *SpLoginCardColor(void)   { return [UIColor colorWithRed:0.067 green:0.078 blue:0.090 alpha:0.97]; }
static UIColor *SpLoginInnerColor(void)  { return [UIColor colorWithWhite:1.0 alpha:0.07]; }
static UIColor *SpLoginInnerBorder(void) { return [UIColor colorWithWhite:1.0 alpha:0.10]; }
static UIColor *SpLoginFieldColor(void)  { return [UIColor colorWithWhite:1.0 alpha:0.08]; }
static UIColor *SpLoginFieldBorder(void) { return [UIColor colorWithWhite:1.0 alpha:0.14]; }
static UIColor *SpLoginPlaceholder(void) { return [UIColor colorWithWhite:1.0 alpha:0.38]; }
static UIColor *SpLoginHintColor(void)   { return [UIColor colorWithWhite:1.0 alpha:0.62]; }
/// 主按钮渐变的上下两端（token 主色 #2EC4B6 的亮/暗两档）。
static UIColor *SpLoginButtonTop(void)    { return [UIColor colorWithRed:0.235 green:0.831 blue:0.780 alpha:1.0]; }
static UIColor *SpLoginButtonBottom(void) { return [UIColor colorWithRed:0.098 green:0.639 blue:0.596 alpha:1.0]; }

@interface SpLoginViewController () <UITextFieldDelegate>

@property (nonatomic, strong) UIView *panel;
@property (nonatomic, strong) UILabel *titleLabel;
@property (nonatomic, strong) SpLoginCodeLabel *codeLabel;
@property (nonatomic, strong) UILabel *countdownLabel;
@property (nonatomic, strong) UITextField *accountField;
@property (nonatomic, strong) UITextField *passwordField;
@property (nonatomic, strong) UITextField *confirmField;
@property (nonatomic, strong) UIButton *primaryButton;
@property (nonatomic, strong) UIButton *secondaryButton;
@property (nonatomic, strong) UIButton *resendButton;
@property (nonatomic, strong) UILabel *statusLabel;

// ---- 以下全部是外观构件，不参与任何业务判定 ----
@property (nonatomic, strong) UIView *titleBar;              // 卡片头部（标题 + 关闭）
@property (nonatomic, strong) UIView *titleAccent;           // 卡片顶缘渐变高光
@property (nonatomic, strong) UIView *codePlate;             // 验证码底板
@property (nonatomic, strong) UIView *codeValueView;         // 逐位方块容器
@property (nonatomic, strong) NSArray<UILabel *> *codeTiles; // 6 个方块，只做显示
@property (nonatomic, strong) UIButton *closeButton;         // 右上角关闭（只藏面板）
@property (nonatomic, strong) UIScrollView *bodyScrollView;  // 内容超高时滚动（小屏兜底）
@property (nonatomic, strong) UIStackView *contentStack;

@property (nonatomic, assign) SpLoginUIState state;
@property (nonatomic, assign) SpLoginUIMode mode;
@property (nonatomic, strong, nullable) NSTimer *pollTimer;
@property (nonatomic, strong, nullable) NSTimer *countdownTimer;
@property (nonatomic, strong, nullable) NSDate *codeExpiry;
@property (nonatomic, assign) NSInteger pollCount;

@end

@implementation SpLoginViewController

#pragma mark - 打开/关闭（走独立覆盖窗口，不再走 presentViewController:）

+ (BOOL)presentOnKeyWindow
{
    // 显示能力整体交给 SpLoginOverlay：
    //   · 面板 view 是覆盖窗口 root 的子视图，不再弹进游戏自己的视图层级；
    //   · 宿主（游戏）窗口还没就绪时它会把这次请求挂起，挂上后自动补开；
    //   · 打开只是 hidden=NO，绝不抢 keyWindow（只有键盘才临时抢，编辑结束立刻归还）。
    BOOL visible = [[SpLoginOverlay sharedOverlay] showPanel];
    SPLoginLog(@"[SpLogin] login panel %@ (独立覆盖窗口)", visible ? @"shown" : @"pending");
    return visible;
}

+ (void)dismissIfPresented
{
    // 只藏起来、不销毁：面板实例与验证码/倒计时/轮询状态都保留，再点悬浮球即原样恢复。
    [[SpLoginOverlay sharedOverlay] hidePanel];
    SPLoginLog(@"[SpLogin] login panel dismissed (独立覆盖窗口)");
}

#pragma mark - 键盘避让

/// 输入框左右内边距（皮肤层的排版参数，纯视觉）。
+ (CGFloat)textInsets
{
    return 14.0;
}

- (void)adjustForKeyboardTop:(CGFloat)keyboardTopY
{
    if (self.panel == nil) {
        return;
    }
    // 用 center/bounds 算，不用 frame：被 transform 平移过的 frame 会反馈污染（面板来回抖）。
    // 未平移时的卡片底边 = 视图中心（约束里的 centerY 常量为 -8）+ 卡片半高。
    // 这个 -8.0 必须与 buildViews 里 card.centerY 的常量保持一致，否则避让会差几个点。
    CGFloat cardHeight = CGRectGetHeight(self.panel.bounds);
    CGFloat restingCenterY = CGRectGetMidY(self.view.bounds) - 8.0;
    CGFloat restingMaxY = restingCenterY + cardHeight / 2.0;
    CGFloat overlap = restingMaxY - keyboardTopY;
    CGFloat offset = (keyboardTopY > 0 && overlap > 0) ? -overlap : 0;
    self.panel.transform = CGAffineTransformMakeTranslation(0, offset);
}

#pragma mark - 生命周期

- (void)viewDidLoad
{
    [super viewDidLoad];
    self.state = SpLoginUIStateWaitingCode;
    self.mode = SpLoginUIModeCreate;
    [self buildViews];
    [self applyState];
}

- (void)dealloc
{
    // 只清掉皮肤层自己订阅的通知，不碰键盘/轮询/网络（那些在 SpLoginOverlay 与 SpLoginAPI 里）。
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)viewDidAppear:(BOOL)animated
{
    [super viewDidAppear:animated];
    // 本地已有会话 ⇒ 直接继续轮询绑定状态（换设备/重开会话都能续上）。
    // 覆盖窗口路径不触发 appearance，所以那段逻辑抽进了 sp_resumeFromStoredTokenIfNeeded，
    // 由 SpLoginOverlay 在挂面板时显式调一次；这里留着是给「VC 真被 present 出来」的场合兜底。
    [self sp_resumeFromStoredTokenIfNeeded];
}

- (void)sp_resumeFromStoredTokenIfNeeded
{
    // 定时器要挂到当前 runloop（主线程），非主线程进来先弹回去——
    // 与 SpLoginOverlay 里 sp_attachWithReason: / showPanel / hidePanel 的写法一致。
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self sp_resumeFromStoredTokenIfNeeded];
        });
        return;
    }

    NSString *token = [SpLoginAPI sharedAPI].token;
    if (token.length == 0) {
        // 没有本地令牌 ⇒ 一次请求都不发（冷启动默认状态就是这条路径）。
        SPLoginLog(@"[SpLogin] resume: 本地无令牌，不续轮询（等用户在面板里创建/登录）");
        return;
    }

    // 幂等闸门：已经在轮询就不再开一个。
    // 覆盖窗口的 5s 看门狗每次重挂、scene 迁移、面板重复容器化都会走到这里；
    // 没有这道闸门就会叠出多个 pollTimer（每个都在打 /sp-auth/bind-status）。
    if (self.pollTimer != nil && self.pollTimer.isValid) {
        SPLoginLog(@"[SpLogin] resume: 轮询已在跑，跳过（幂等，token 长度=%lu）",
                   (unsigned long)token.length);
        return;
    }

    // 起轮询（首拍在 SpLoginPollInterval=3s 后）= 旧的 viewDidAppear 里 refreshBindStatus 的效果，
    // 但不会只查一次就停：绑定是「群内 bot 人工确认」，必须持续等到 bound=true 才有意义。
    [self startPolling];
    SPLoginLog(@"[SpLogin] resume: 本地已有令牌 ⇒ 续轮询 bind-status（每 %.1fs 一次，最多 %ld 次；"
               @"token 长度=%lu，面板挂载完成即触发）",
               SpLoginPollInterval, (long)SpLoginPollLimit, (unsigned long)token.length);
}

- (void)viewDidDisappear:(BOOL)animated
{
    [super viewDidDisappear:animated];
    [self stopTimers];
}

- (void)stopTimers
{
    [self.pollTimer invalidate];
    self.pollTimer = nil;
    [self.countdownTimer invalidate];
    self.countdownTimer = nil;
}

// 外观固定尺寸：全部是「长什么样」的参数，改它们不影响任何行为。
static const CGFloat SpLoginPanelMaxWidth   = 360.0;   // 卡片最大宽度（窄屏按屏宽收缩）
static const CGFloat SpLoginHeaderHeight    = 58.0;    // 卡片头部高度
static const CGFloat SpLoginAccentH         = 4.0;     // 卡片顶缘渐变条高度
static const CGFloat SpLoginCardPad         = 20.0;    // 卡片左右内边距
static const CGFloat SpLoginCodeTileH       = 50.0;    // 验证码格高度
static const CGFloat SpLoginButtonHeight    = 50.0;
static const CGFloat SpLoginSecondaryHeight = 44.0;
static const CGFloat SpLoginResendHeight    = 32.0;
static const CGFloat SpLoginFieldHeight     = 46.0;

#pragma mark - 视图

- (void)buildViews
{
    BOOL skin = SpLoginSkinEnabled();

    // 安全区在 viewDidLoad 里拿不到（view 还没进 window，safeAreaInsets 恒为 0），
    // 用保守常量：刘海机是 44/34，非刘海机只是多留一点白，不会被切内容。
    const CGFloat safeTop = 44.0;
    const CGFloat safeBottom = 34.0;
    const CGFloat cardMargin = 16.0;
    CGFloat screenW = CGRectGetWidth([UIScreen mainScreen].bounds);
    CGFloat screenH = CGRectGetHeight([UIScreen mainScreen].bounds);
    CGFloat cardWidth = MIN(SpLoginPanelMaxWidth, screenW - cardMargin * 2.0);
    cardWidth = MAX(cardWidth, 272.0);
    // 卡片总高上限 = 屏高 − 安全区 − 上下各 12pt 呼吸位；内容再高就滚动（小屏兜底）。
    CGFloat maxCardHeight = MAX(320.0, screenH - safeTop - safeBottom - 24.0);
    CGFloat maxBodyHeight = MAX(160.0, maxCardHeight - SpLoginHeaderHeight - SpLoginAccentH - SpLoginCardPad);

    self.view.backgroundColor = [SpLoginTheme scrim];
    // 点卡片外的空白 = 关面板（与「回到游戏」同一个动作，只藏不销毁）。
    UITapGestureRecognizer *tapOutside =
        [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(sp_scrimTapped:)];
    tapOutside.cancelsTouchesInView = NO;
    [self.view addGestureRecognizer:tapOutside];

    // ---------- 卡片 ----------
    UIView *card = [[UIView alloc] initWithFrame:CGRectZero];
    card.translatesAutoresizingMaskIntoConstraints = NO;
    card.backgroundColor = SpLoginCardColor();
    card.layer.cornerRadius = 22.0;
    card.layer.cornerCurve = kCACornerCurveContinuous;
    card.layer.borderWidth = 1.0;
    card.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.10].CGColor;
    // 阴影要露到卡片外面 ⇒ 这里不能 masksToBounds（顶缘渐变条自己裁圆角，见下）。
    card.layer.shadowColor = UIColor.blackColor.CGColor;
    card.layer.shadowOpacity = 0.55;
    card.layer.shadowRadius = 28.0;
    card.layer.shadowOffset = CGSizeMake(0.0, 12.0);
    self.panel = card;
    [self.view addSubview:card];

    // 顶缘一道细渐变高光（取代上一版的「深色铭牌 + 底缘装饰三件套」整块装饰）。
    SpLoginGradientView *accent =
        [SpLoginGradientView sp_verticalGradientWithColors:@[ [SpLoginTheme primary], [SpLoginTheme accent] ]
                                                  locations:@[ @0.0, @1.0 ]];
    accent.sp_gradient.startPoint = CGPointMake(0.0, 0.5);   // 横向：左青 → 右橙
    accent.sp_gradient.endPoint = CGPointMake(1.0, 0.5);
    accent.layer.cornerRadius = 22.0;
    accent.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
    accent.layer.masksToBounds = YES;
    self.titleAccent = accent;
    [card addSubview:accent];

    // ---------- 头部：标题 + 关闭 ----------
    UIView *header = [[UIView alloc] initWithFrame:CGRectZero];
    header.translatesAutoresizingMaskIntoConstraints = NO;
    self.titleBar = header;
    [card addSubview:header];

    UIView *titleTick = [[UIView alloc] initWithFrame:CGRectZero];
    titleTick.translatesAutoresizingMaskIntoConstraints = NO;
    titleTick.backgroundColor = [SpLoginTheme primary];
    titleTick.layer.cornerRadius = 2.0;
    [header addSubview:titleTick];

    UILabel *title = [self labelWithFont:[SpLoginTheme fontOfSize:19.0 weight:UIFontWeightSemibold]
                                   color:UIColor.whiteColor
                                   lines:1];
    title.text = @"服务器绑定";
    self.titleLabel = title;
    [header addSubview:title];

    UIButton *close = [UIButton buttonWithType:UIButtonTypeCustom];
    [close setTitle:@"×" forState:UIControlStateNormal];
    close.titleLabel.font = [SpLoginTheme fontOfSize:24.0 weight:UIFontWeightRegular];
    [close setTitleColor:SpLoginHintColor() forState:UIControlStateNormal];
    [close addTarget:self action:@selector(sp_closeTapped:) forControlEvents:UIControlEventTouchUpInside];
    close.translatesAutoresizingMaskIntoConstraints = NO;
    self.closeButton = close;
    [header addSubview:close];

    // ---------- 内容区（超高可滚） ----------
    UIScrollView *scroll = [[UIScrollView alloc] initWithFrame:CGRectZero];
    scroll.translatesAutoresizingMaskIntoConstraints = NO;
    scroll.backgroundColor = UIColor.clearColor;
    scroll.showsVerticalScrollIndicator = NO;
    scroll.alwaysBounceVertical = NO;
    scroll.keyboardDismissMode = UIScrollViewKeyboardDismissModeOnDrag;
    self.bodyScrollView = scroll;
    [card addSubview:scroll];

    // ---------- 验证码底板 ----------
    UIView *codePlate = [[UIView alloc] initWithFrame:CGRectZero];
    codePlate.translatesAutoresizingMaskIntoConstraints = NO;
    codePlate.backgroundColor = SpLoginInnerColor();
    codePlate.layer.cornerRadius = 16.0;
    codePlate.layer.borderWidth = 1.0;
    codePlate.layer.borderColor = SpLoginInnerBorder().CGColor;
    self.codePlate = codePlate;

    UIView *codeValue = [[UIView alloc] initWithFrame:CGRectZero];
    codeValue.translatesAutoresizingMaskIntoConstraints = NO;
    self.codeValueView = codeValue;
    [codePlate addSubview:codeValue];

    // 逐位方块用 FillEqually 横排：宽度自适应。上一版写死 6×40 宽，窄屏上会把容器撑爆破约束。
    UIStackView *tilesRow = [[UIStackView alloc] initWithFrame:CGRectZero];
    tilesRow.axis = UILayoutConstraintAxisHorizontal;
    tilesRow.distribution = UIStackViewDistributionFillEqually;
    tilesRow.spacing = 6.0;
    tilesRow.translatesAutoresizingMaskIntoConstraints = NO;
    [codeValue addSubview:tilesRow];

    NSMutableArray<UILabel *> *tiles = [NSMutableArray arrayWithCapacity:6];
    for (NSInteger i = 0; i < 6; i++) {
        UILabel *tile = [[UILabel alloc] initWithFrame:CGRectZero];
        tile.font = [SpLoginTheme monospacedDigitFontOfSize:26.0 weight:UIFontWeightBold];
        tile.textColor = UIColor.whiteColor;
        tile.textAlignment = NSTextAlignmentCenter;
        tile.backgroundColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.18];
        tile.layer.cornerRadius = 10.0;
        tile.layer.masksToBounds = YES;
        tile.layer.borderWidth = 1.0;
        tile.layer.borderColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.45].CGColor;
        tile.userInteractionEnabled = NO;
        tile.hidden = YES;
        [tilesRow addArrangedSubview:tile];
        [tiles addObject:tile];
    }
    self.codeTiles = tiles;

    SpLoginCodeLabel *code = [[SpLoginCodeLabel alloc] initWithFrame:CGRectZero];
    code.font = [SpLoginTheme monospacedDigitFontOfSize:30.0 weight:UIFontWeightBold];
    code.textColor = UIColor.whiteColor;
    code.textAlignment = NSTextAlignmentCenter;
    code.numberOfLines = 1;
    code.adjustsFontSizeToFitWidth = YES;
    code.minimumScaleFactor = 0.6;
    code.text = @"------";
    code.translatesAutoresizingMaskIntoConstraints = NO;
    self.codeLabel = code;
    [codeValue addSubview:code];

    UILabel *countdown = [self labelWithFont:[SpLoginTheme fontOfSize:13.0 weight:UIFontWeightRegular]
                                       color:SpLoginHintColor()
                                       lines:1];
    countdown.textAlignment = NSTextAlignmentCenter;
    countdown.text = @"验证码会随公告下发到游戏里";
    self.countdownLabel = countdown;

    self.accountField = [self textFieldWithPlaceholder:@"QQ 号" secure:NO keyboard:UIKeyboardTypeNumberPad];
    self.passwordField = [self textFieldWithPlaceholder:@"密码" secure:YES keyboard:UIKeyboardTypeDefault];
    self.confirmField = [self textFieldWithPlaceholder:@"确认密码" secure:YES keyboard:UIKeyboardTypeDefault];

    // ---------- 按钮 ----------
    // 注意：不能用 `[SpLoginGradientButton buttonWithType:]` —— 那个方法返回的是 UIButton
    // 实例而不是子类实例，`primary.layer` 会是普通 CALayer，下一行 setColors: 直接崩。
    SpLoginGradientButton *primary = [[SpLoginGradientButton alloc] initWithFrame:CGRectZero];
    [primary setTitle:@"创建账号并绑定" forState:UIControlStateNormal];
    [primary setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    primary.titleLabel.font = [SpLoginTheme fontOfSize:17.0 weight:UIFontWeightSemibold];
    [primary addTarget:self action:@selector(onPrimaryTapped) forControlEvents:UIControlEventTouchUpInside];
    CAGradientLayer *primaryGradient = (CAGradientLayer *)primary.layer;
    primaryGradient.colors = @[ (__bridge id)SpLoginButtonTop().CGColor,
                                (__bridge id)SpLoginButtonBottom().CGColor ];
    primaryGradient.startPoint = CGPointMake(0.5, 0.0);
    primaryGradient.endPoint = CGPointMake(0.5, 1.0);
    primary.layer.cornerRadius = 14.0;
    primary.layer.masksToBounds = YES;
    primary.translatesAutoresizingMaskIntoConstraints = NO;
    self.primaryButton = primary;

    UIButton *secondary = [UIButton buttonWithType:UIButtonTypeCustom];
    [secondary setTitle:@"我已有账号" forState:UIControlStateNormal];
    [secondary setTitleColor:[SpLoginTheme primary] forState:UIControlStateNormal];
    secondary.titleLabel.font = [SpLoginTheme fontOfSize:16.0 weight:UIFontWeightMedium];
    secondary.backgroundColor = [UIColor colorWithWhite:1.0 alpha:0.05];
    secondary.layer.cornerRadius = 14.0;
    secondary.layer.borderWidth = 1.0;
    secondary.layer.borderColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.50].CGColor;
    [secondary addTarget:self action:@selector(onSecondaryTapped) forControlEvents:UIControlEventTouchUpInside];
    secondary.translatesAutoresizingMaskIntoConstraints = NO;
    self.secondaryButton = secondary;

    UIButton *resend = [UIButton buttonWithType:UIButtonTypeCustom];
    [resend setTitle:@"重新获取验证码" forState:UIControlStateNormal];
    [resend setTitleColor:[[SpLoginTheme primary] colorWithAlphaComponent:0.95] forState:UIControlStateNormal];
    resend.titleLabel.font = [SpLoginTheme fontOfSize:14.0 weight:UIFontWeightMedium];
    [resend addTarget:self action:@selector(onResendTapped) forControlEvents:UIControlEventTouchUpInside];
    resend.translatesAutoresizingMaskIntoConstraints = NO;
    self.resendButton = resend;

    UILabel *status = [self labelWithFont:[SpLoginTheme fontOfSize:13.0 weight:UIFontWeightRegular]
                                    color:SpLoginHintColor()
                                    lines:0];
    status.textAlignment = NSTextAlignmentCenter;
    self.statusLabel = status;

    // ---------- 纵向内容栈 ----------
    UIStackView *stack = [[UIStackView alloc] initWithFrame:CGRectZero];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.alignment = UIStackViewAlignmentFill;
    stack.spacing = 12.0;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    self.contentStack = stack;
    [scroll addSubview:stack];
    for (UIView *row in @[ codePlate, countdown, self.accountField, self.passwordField,
                           self.confirmField, primary, secondary, resend, status ]) {
        [stack addArrangedSubview:row];
    }
    [stack setCustomSpacing:10.0 afterView:codePlate];
    [stack setCustomSpacing:18.0 afterView:countdown];
    [stack setCustomSpacing:20.0 afterView:self.confirmField];
    [stack setCustomSpacing:10.0 afterView:secondary];

    // ---------- 约束 ----------
    [NSLayoutConstraint activateConstraints:@[
        [card.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [card.widthAnchor constraintEqualToConstant:cardWidth],
        [card.topAnchor constraintGreaterThanOrEqualToAnchor:self.view.topAnchor
                                                    constant:safeTop + 12.0],
        [card.bottomAnchor constraintLessThanOrEqualToAnchor:self.view.bottomAnchor
                                                    constant:-(safeBottom + 12.0)],

        [accent.leadingAnchor constraintEqualToAnchor:card.leadingAnchor],
        [accent.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
        [accent.topAnchor constraintEqualToAnchor:card.topAnchor],
        [accent.heightAnchor constraintEqualToConstant:SpLoginAccentH],

        [header.leadingAnchor constraintEqualToAnchor:card.leadingAnchor],
        [header.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
        [header.topAnchor constraintEqualToAnchor:accent.bottomAnchor],
        [header.heightAnchor constraintEqualToConstant:SpLoginHeaderHeight],

        [titleTick.leadingAnchor constraintEqualToAnchor:header.leadingAnchor constant:SpLoginCardPad],
        [titleTick.centerYAnchor constraintEqualToAnchor:header.centerYAnchor],
        [titleTick.widthAnchor constraintEqualToConstant:4.0],
        [titleTick.heightAnchor constraintEqualToConstant:18.0],

        [title.leadingAnchor constraintEqualToAnchor:titleTick.trailingAnchor constant:10.0],
        [title.centerYAnchor constraintEqualToAnchor:header.centerYAnchor],
        [title.trailingAnchor constraintLessThanOrEqualToAnchor:close.leadingAnchor constant:-8.0],

        [close.trailingAnchor constraintEqualToAnchor:header.trailingAnchor constant:-12.0],
        [close.centerYAnchor constraintEqualToAnchor:header.centerYAnchor],
        [close.widthAnchor constraintEqualToConstant:36.0],
        [close.heightAnchor constraintEqualToConstant:36.0],

        [scroll.leadingAnchor constraintEqualToAnchor:card.leadingAnchor],
        [scroll.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
        [scroll.topAnchor constraintEqualToAnchor:header.bottomAnchor],

        [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor
                                            constant:SpLoginCardPad],
        [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor
                                             constant:-SpLoginCardPad],
        [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor],
        [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor
                                           constant:-SpLoginCardPad],
        [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor
                                          constant:-SpLoginCardPad * 2.0],

        [codeValue.leadingAnchor constraintEqualToAnchor:codePlate.leadingAnchor constant:12.0],
        [codeValue.trailingAnchor constraintEqualToAnchor:codePlate.trailingAnchor constant:-12.0],
        [codeValue.topAnchor constraintEqualToAnchor:codePlate.topAnchor constant:12.0],
        [codeValue.bottomAnchor constraintEqualToAnchor:codePlate.bottomAnchor constant:-12.0],

        [tilesRow.leadingAnchor constraintEqualToAnchor:codeValue.leadingAnchor],
        [tilesRow.trailingAnchor constraintEqualToAnchor:codeValue.trailingAnchor],
        [tilesRow.topAnchor constraintEqualToAnchor:codeValue.topAnchor],
        // 上下都钉住：codeValue 的高度才被确定（= 格子高），否则 codePlate 高度欠定
        // （底板 ↔ 容器的约束成环），UIKit 会解成 0 高，数字被裁掉。
        [tilesRow.bottomAnchor constraintEqualToAnchor:codeValue.bottomAnchor],
        [tilesRow.heightAnchor constraintEqualToConstant:SpLoginCodeTileH],

        [code.leadingAnchor constraintEqualToAnchor:codeValue.leadingAnchor],
        [code.trailingAnchor constraintEqualToAnchor:codeValue.trailingAnchor],
        [code.centerYAnchor constraintEqualToAnchor:codeValue.centerYAnchor],
        [code.heightAnchor constraintEqualToConstant:SpLoginCodeTileH],

        [self.accountField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [self.passwordField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [self.confirmField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [primary.heightAnchor constraintEqualToConstant:SpLoginButtonHeight],
        [secondary.heightAnchor constraintEqualToConstant:SpLoginSecondaryHeight],
        [resend.heightAnchor constraintEqualToConstant:SpLoginResendHeight],
    ]];

    // 滚动区高度 = 内容高度（卡片贴着内容长），但不超过 maxBodyHeight（超了就滚）。
    // 999 而不是 required：让「贴着内容」优先，实在放不下才让步。
    NSLayoutConstraint *bodyFits =
        [scroll.heightAnchor constraintEqualToAnchor:stack.heightAnchor constant:SpLoginCardPad * 2.0];
    bodyFits.priority = 999;
    NSLayoutConstraint *cardCentered =
        [card.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor constant:-8.0];
    cardCentered.priority = 750;   // 让位给上面两条 required 的上下边界
    [NSLayoutConstraint activateConstraints:@[
        bodyFits,
        cardCentered,
        [scroll.heightAnchor constraintLessThanOrEqualToConstant:maxBodyHeight],
        [card.bottomAnchor constraintEqualToAnchor:scroll.bottomAnchor constant:SpLoginCardPad],
    ]];

    // 输入框聚焦描边（纯 layer：不缓存子视图树，所以光标与键盘行为一字不改）
    for (UITextField *field in @[ self.accountField, self.passwordField, self.confirmField ]) {
        [field addTarget:self action:@selector(sp_fieldEditingBegan:)
        forControlEvents:UIControlEventEditingDidBegin];
        [field addTarget:self action:@selector(sp_fieldEditingEnded:)
        forControlEvents:UIControlEventEditingDidEnd];
    }

    if (skin) {
        // 逐位方块视觉：codeLabel.text 一变就刷新（业务侧那一行没动）。
        __weak typeof(self) weakSelf = self;
        self.codeLabel.sp_onTextChanged = ^(NSString *text) {
            __strong typeof(self) strongSelf = weakSelf;
            [strongSelf sp_syncCodeTilesWithText:text];
        };
        [self sp_syncCodeTilesWithText:self.codeLabel.text];
    } else {
        // 皮肤关掉：收掉纯装饰（顶缘渐变条 + 逐位方块），只留标题 + 控件的通用表单。
        self.codeLabel.sp_onTextChanged = nil;
        for (UILabel *tile in tiles) {
            tile.hidden = YES;
        }
        [self sp_setDecorationsHidden:YES];
    }

    SPLoginLog(@"[SpLogin] panel 深色卡片 skin=%@ width=%.0f maxBody=%.0f（纯外观层，业务未变）",
               skin ? @"on" : @"off", cardWidth, maxBodyHeight);
}

/// 点卡片外的空白 = 关面板。卡片范围内的点击照旧交给控件。
- (void)sp_scrimTapped:(UITapGestureRecognizer *)gesture
{
    if (self.panel == nil) {
        return;
    }
    CGPoint point = [gesture locationInView:self.view];
    if (CGRectContainsPoint(self.panel.frame, point)) {
        return;
    }
    [SpLoginViewController dismissIfPresented];
}

- (void)sp_closeTapped:(UIButton *)sender
{
    [SpLoginViewController dismissIfPresented];
}

/// 装饰整体开关（皮肤关掉时用）。只切 hidden / 颜色，不动任何业务控件。
- (void)sp_setDecorationsHidden:(BOOL)hidden
{
    self.titleAccent.hidden = hidden;
    self.codePlate.backgroundColor = hidden ? [UIColor colorWithWhite:1.0 alpha:0.04] : SpLoginInnerColor();
    for (UILabel *tile in self.codeTiles) {
        tile.backgroundColor = hidden ? [UIColor colorWithWhite:1.0 alpha:0.06]
                                      : [[SpLoginTheme primary] colorWithAlphaComponent:0.18];
        tile.layer.borderColor = (hidden ? SpLoginInnerBorder()
                                         : [[SpLoginTheme primary] colorWithAlphaComponent:0.45]).CGColor;
    }
}

- (void)sp_syncCodeTilesWithText:(NSString *)text
{
    NSString *digits = @"";
    if ([text isKindOfClass:[NSString class]]) {
        NSCharacterSet *nonDigits = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
        digits = [[text componentsSeparatedByCharactersInSet:nonDigits] componentsJoinedByString:@""];
    }
    if (digits.length > 6) {
        digits = [digits substringToIndex:6];
    }
    BOOL showing = (digits.length == 6);
    for (NSInteger i = 0; i < self.codeTiles.count; i++) {
        UILabel *tile = self.codeTiles[(NSUInteger)i];
        tile.hidden = !showing;
        tile.text = (showing && i < (NSInteger)digits.length)
            ? [digits substringWithRange:NSMakeRange((NSUInteger)i, 1)]
            : @"";
    }
    self.codeLabel.hidden = showing;
}

- (void)sp_fieldEditingBegan:(UITextField *)field
{
    // 内联深色聚焦态（不再走皮肤层的通用浅色实现）。
    field.layer.borderColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.85].CGColor;
    field.backgroundColor = [UIColor colorWithWhite:1.0 alpha:0.12];
}

- (void)sp_fieldEditingEnded:(UITextField *)field
{
    field.layer.borderColor = SpLoginFieldBorder().CGColor;
    field.backgroundColor = SpLoginFieldColor();
}

- (UILabel *)labelWithFont:(UIFont *)font color:(UIColor *)color lines:(NSInteger)lines
{
    UILabel *label = [[UILabel alloc] initWithFrame:CGRectZero];
    label.font = font;
    label.textColor = color;
    label.numberOfLines = lines;
    label.translatesAutoresizingMaskIntoConstraints = NO;
    return label;
}

- (UITextField *)textFieldWithPlaceholder:(NSString *)placeholder secure:(BOOL)secure keyboard:(UIKeyboardType)keyboard
{
    UITextField *field = [[UITextField alloc] initWithFrame:CGRectZero];
    // attributedPlaceholder：系统默认 placeholder 是浅灰，压在这套深色底上几乎看不见。
    field.attributedPlaceholder = [[NSAttributedString alloc]
        initWithString:placeholder
            attributes:@{ NSForegroundColorAttributeName: SpLoginPlaceholder() }];
    field.secureTextEntry = secure;
    field.keyboardType = keyboard;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo;
    field.borderStyle = UITextBorderStyleNone;
    field.translatesAutoresizingMaskIntoConstraints = NO;
    // 深色输入框外观（纯外观层）。行为部分（delegate、returnKeyType、键盘类型、
    // 左右视图）仍在下面照旧设置，一个字没改。
    field.backgroundColor = SpLoginFieldColor();
    field.layer.cornerRadius = 14.0;
    field.layer.borderWidth = 1.0;
    field.layer.borderColor = SpLoginFieldBorder().CGColor;
    field.textColor = UIColor.whiteColor;
    field.tintColor = [SpLoginTheme primary];
    field.font = [SpLoginTheme fontOfSize:16.0 weight:UIFontWeightRegular];
    CGFloat inset = [SpLoginViewController textInsets];
    field.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, inset, 0)];
    field.leftViewMode = UITextFieldViewModeAlways;
    field.delegate = self;
    field.returnKeyType = UIReturnKeyDone;
    return field;
}

#pragma mark - 状态

- (void)applyState
{
    BOOL createMode = (self.mode == SpLoginUIModeCreate);
    self.confirmField.hidden = !createMode;
    [self.primaryButton setTitle:(createMode ? @"创建账号并绑定" : @"登录并绑定") forState:UIControlStateNormal];
    BOOL inputsVisible = (self.state == SpLoginUIStateWaitingCode || self.state == SpLoginUIStateError);
    for (UITextField *field in @[ self.accountField, self.passwordField, self.confirmField ]) {
        field.hidden = !inputsVisible;
        field.enabled = inputsVisible;
    }
    self.resendButton.hidden = !(self.state == SpLoginUIStateCodeShown || self.state == SpLoginUIStateBinding);
    switch (self.state) {
        case SpLoginUIStateWaitingCode:
            self.statusLabel.text = @"填写后点下面的按钮，验证码会出现在这里，也会随公告发到游戏里。";
            break;
        case SpLoginUIStateCodeShown:
            self.statusLabel.text = @"把上面这 6 位数字发给 QQ 群里的 bot，绑定会立刻生效。";
            break;
        case SpLoginUIStateBinding:
            self.statusLabel.text = @"正在等确认……绑定成功后这里会变绿。";
            break;
        case SpLoginUIStateError:
            self.statusLabel.text = self.statusLabel.text.length > 0 ? self.statusLabel.text : @"没成功，检查一下再试。";
            break;
        case SpLoginUIStateSuccess:
            self.statusLabel.text = @"已绑定成功。回游戏点「点击开始」即可进入。";
            self.statusLabel.textColor = [SpLoginTheme primary];
            break;
    }
    if (self.state == SpLoginUIStateSuccess) {
        self.statusLabel.textColor = [SpLoginTheme primary];
    } else if (self.state == SpLoginUIStateError) {
        self.statusLabel.textColor = [SpLoginTheme danger];
    } else {
        // 深色卡片上的提示文字：旧值 textSecondary(#515151) 压在深底上等于看不见。
        self.statusLabel.textColor = SpLoginHintColor();
    }
    SPLoginLog(@"[SpLogin] ui state=%ld mode=%ld", (long)self.state, (long)self.mode);
}

- (void)failWithCode:(NSString *)code message:(NSString *)message
{
    // C7：错误码 → 中文话术由服务端 message 承载；本地只兜底网络类错误。
    self.state = SpLoginUIStateError;
    NSString *text = message.length > 0 ? message : @"绑定没成功，请重试。";
    if (code.length > 0 && ![code isEqualToString:@"NETWORK"]) {
        text = [NSString stringWithFormat:@"%@（%@）", text, code];
    }
    self.statusLabel.text = text;
    [self applyState];
}

#pragma mark - 动作

- (void)onPrimaryTapped
{
    [self.view endEditing:YES];
    NSString *account = [self.accountField.text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    NSString *password = self.passwordField.text ?: @"";
    if (account.length == 0 || password.length == 0) {
        [self failWithCode:@"CLIENT_INPUT" message:@"请先填写 QQ 号和密码。"];
        return;
    }
    if (self.mode == SpLoginUIModeCreate && ![password isEqualToString:(self.confirmField.text ?: @"")]) {
        [self failWithCode:@"CLIENT_INPUT" message:@"两次输入的密码不一样。"];
        return;
    }

    self.state = SpLoginUIStateWaitingCode;
    self.statusLabel.text = self.mode == SpLoginUIModeCreate ? @"正在创建账号……" : @"正在登录……";
    [self applyState];

    __weak typeof(self) weakSelf = self;
    SpLoginResultBlock done = ^(BOOL ok, NSDictionary *data, NSString *code, NSString *message) {
        __strong typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            return;
        }
        if (!ok) {
            [strongSelf failWithCode:code message:message];
            return;
        }
        [strongSelf consumeSubscribeData:data];
    };
    if (self.mode == SpLoginUIModeCreate) {
        [[SpLoginAPI sharedAPI] registerWithUsername:account password:password completion:done];
    } else {
        [[SpLoginAPI sharedAPI] loginWithLoginName:account password:password completion:done];
    }
}

- (void)onSecondaryTapped
{
    self.mode = (self.mode == SpLoginUIModeCreate) ? SpLoginUIModeExisting : SpLoginUIModeCreate;
    [self.secondaryButton setTitle:(self.mode == SpLoginUIModeCreate ? @"我已有账号" : @"返回创建账号")
                          forState:UIControlStateNormal];
    self.state = SpLoginUIStateWaitingCode;
    [self applyState];
}

- (void)onResendTapped
{
    self.statusLabel.text = @"正在重新获取……";
    __weak typeof(self) weakSelf = self;
    [[SpLoginAPI sharedAPI] resendCodeWithCompletion:^(BOOL ok, NSDictionary *data, NSString *code, NSString *message) {
        __strong typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            return;
        }
        if (!ok) {
            [strongSelf failWithCode:code message:message];
            return;
        }
        [strongSelf consumeSubscribeData:data];
    }];
}

/// 从 register / login / bind-status / resend 的 data 段取 code + 到期时间，进入倒计时与轮询。
- (void)consumeSubscribeData:(NSDictionary *)data
{
    NSString *code = [data[@"code"] isKindOfClass:[NSString class]] ? data[@"code"] : nil;
    if (code.length == 0 && [data[@"code"] isKindOfClass:[NSNumber class]]) {
        code = [data[@"code"] stringValue];
    }
    if (code.length > 0) {
        self.codeLabel.text = code;
    }
    self.codeExpiry = [self parseExpiry:data[@"code_expires_at"]];
    [self startCountdown];

    NSNumber *bound = [data[@"bound"] isKindOfClass:[NSNumber class]] ? data[@"bound"] : nil;
    if (bound.boolValue) {
        [self enterSuccess];
        return;
    }
    self.state = SpLoginUIStateCodeShown;
    [self applyState];
    if (code.length > 0) {
        [self startPolling];
    }
}

- (nullable NSDate *)parseExpiry:(id)raw
{
    if ([raw isKindOfClass:[NSNumber class]]) {
        double value = [raw doubleValue];
        if (value > 1e12) {
            value /= 1000.0;                                   // 毫秒
        }
        return [NSDate dateWithTimeIntervalSince1970:value];
    }
    if ([raw isKindOfClass:[NSString class]]) {
        NSString *text = raw;
        if (text.length == 0) {
            return nil;
        }
        NSDate *iso = nil;
        if (@available(iOS 10.0, *)) {
            NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
            iso = [formatter dateFromString:text];
        }
        if (iso != nil) {
            return iso;
        }
        NSTimeInterval seconds = text.doubleValue;
        if (seconds > 1e12) {
            seconds /= 1000.0;
        }
        return seconds > 0 ? [NSDate dateWithTimeIntervalSince1970:seconds] : nil;
    }
    return nil;
}

#pragma mark - 倒计时与轮询

- (void)startCountdown
{
    [self.countdownTimer invalidate];
    if (self.codeExpiry == nil) {
        self.countdownLabel.text = @"验证码会随公告下发到游戏里";
        return;
    }
    self.countdownTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                          target:self
                                                        selector:@selector(tickCountdown)
                                                        userInfo:nil
                                                         repeats:YES];
    [self tickCountdown];
}

- (void)tickCountdown
{
    if (self.codeExpiry == nil) {
        return;
    }
    NSTimeInterval left = [self.codeExpiry timeIntervalSinceNow];
    if (left <= 0) {
        self.countdownLabel.text = @"验证码已过期，点「重新获取验证码」";
        [self.countdownTimer invalidate];
        self.countdownTimer = nil;
        return;
    }
    NSInteger total = (NSInteger)left;
    self.countdownLabel.text = [NSString stringWithFormat:@"有效期剩余 %02ld:%02ld", (long)(total / 60), (long)(total % 60)];
}

- (void)startPolling
{
    [self.pollTimer invalidate];
    self.pollCount = 0;
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:SpLoginPollInterval
                                                     target:self
                                                   selector:@selector(refreshBindStatus)
                                                   userInfo:nil
                                                    repeats:YES];
}

- (void)refreshBindStatus
{
    if (self.pollCount >= SpLoginPollLimit) {
        [self.pollTimer invalidate];
        self.pollTimer = nil;
        [self failWithCode:@"POLL_TIMEOUT" message:@"还没等到确认，点「重新获取验证码」再试一次。"];
        return;
    }
    self.pollCount += 1;
    self.state = SpLoginUIStateBinding;
    [self applyState];
    __weak typeof(self) weakSelf = self;
    [[SpLoginAPI sharedAPI] fetchBindStatusWithCompletion:^(BOOL ok, NSDictionary *data, NSString *code, NSString *message) {
        __strong typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil) {
            return;
        }
        if (!ok) {
            // 轮询期间的网络抖动不打断流程，只记一行日志
            SPLoginLog(@"[SpLogin] bind-status poll failed: %@ %@", code ?: @"-", message ?: @"-");
            return;
        }
        NSNumber *bound = [data[@"bound"] isKindOfClass:[NSNumber class]] ? data[@"bound"] : nil;
        if (bound.boolValue) {
            [strongSelf enterSuccess];
            return;
        }
        [strongSelf consumeSubscribeData:data];
    }];
}

- (void)enterSuccess
{
    [self stopTimers];
    self.state = SpLoginUIStateSuccess;
    self.codeLabel.text = @"已绑定";
    self.countdownLabel.text = @"";
    [self.primaryButton setTitle:@"回到游戏" forState:UIControlStateNormal];
    [self.primaryButton removeTarget:self action:@selector(onPrimaryTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.primaryButton addTarget:self action:@selector(onBackToGameTapped) forControlEvents:UIControlEventTouchUpInside];
    [self applyState];
    [self.view setNeedsLayout];
}

- (void)onBackToGameTapped
{
    [SpLoginViewController dismissIfPresented];
}

#pragma mark - UITextFieldDelegate

- (BOOL)textFieldShouldReturn:(UITextField *)textField
{
    [textField resignFirstResponder];
    return YES;
}

@end
