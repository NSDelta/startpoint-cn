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

// ---- 以下全部是皮肤层新增的装饰视图，不参与任何业务判定 ----
@property (nonatomic, strong) UIView *titleBar;             // 深色标题铭牌
@property (nonatomic, strong) UIView *titleAccent;          // 铭牌下沿的橙/红渐变描边
@property (nonatomic, strong) UIView *codePlate;            // 验证码底板（深色）
@property (nonatomic, strong) UIView *codeValueView;        // 逐位方块容器
@property (nonatomic, strong) NSArray<UILabel *> *codeTiles;// 6 个方块，只做显示
@property (nonatomic, strong) UIView *separator;            // 固定高度的分隔条
@property (nonatomic, strong) UIView *bottomDecoration;     // 面板底缘装饰条
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
    CGFloat overlap = CGRectGetMaxY(self.panel.bounds) - keyboardTopY;
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

// 皮肤层固定尺寸：全部是「长什么样」的参数，改它们不影响任何行为。
static const CGFloat SpLoginPanelWidth      = 320.0;
static const CGFloat SpLoginPanelMaxWidth   = 360.0;
static const CGFloat SpLoginTitleBarHeight  = 44.0;
static const CGFloat SpLoginTitleAccentH    = 3.0;
static const CGFloat SpLoginFooterHeight    = 30.0;   // 底缘装饰条（decoration-assets）
static const CGFloat SpLoginCodeTileW       = 40.0;
static const CGFloat SpLoginCodeTileH       = 50.0;
static const CGFloat SpLoginButtonHeight    = 48.0;
static const CGFloat SpLoginSecondaryHeight = 42.0;
static const CGFloat SpLoginResendHeight    = 30.0;
static const CGFloat SpLoginFieldHeight     = 44.0;
static const CGFloat SpLoginSeparatorH      = 1.0;

#pragma mark - 视图

- (void)buildViews
{
    BOOL skin = SpLoginSkinEnabled();
    // 小屏（iPhone SE 之类）收紧一点间距，避免面板比屏幕还高。
    CGFloat screenH = CGRectGetHeight([UIScreen mainScreen].bounds);
    BOOL compact = (screenH > 0.0 && screenH < 700.0);
    CGFloat topPad     = compact ? 12.0 : 16.0;
    CGFloat gapBig     = compact ? 14.0 : 20.0;
    CGFloat gapField   = compact ? 8.0 : 10.0;

    self.view.backgroundColor = [SpLoginTheme scrim];

    UIView *panel = [[UIView alloc] initWithFrame:CGRectZero];
    panel.translatesAutoresizingMaskIntoConstraints = NO;
    [SpLoginTheme applyPanelStyle:panel];
    self.panel = panel;
    [self.view addSubview:panel];

    // ---- 深色标题铭牌（token: loading.ui 的 #222222 深底 + panel.ui 的 title 位）----
    UIView *titleBar = [[UIView alloc] initWithFrame:CGRectZero];
    titleBar.translatesAutoresizingMaskIntoConstraints = NO;
    titleBar.backgroundColor = [SpLoginTheme plateDark];
    titleBar.layer.cornerRadius = [SpLoginTheme radiusPlate];
    if (@available(iOS 11.0, *)) {
        titleBar.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
    }
    titleBar.layer.masksToBounds = YES;
    self.titleBar = titleBar;
    [panel addSubview:titleBar];

    UIView *titleAccent = [[UIView alloc] initWithFrame:CGRectZero];
    titleAccent.translatesAutoresizingMaskIntoConstraints = NO;
    [SpLoginTheme applyVerticalGradient:titleAccent
                                 colors:@[[SpLoginTheme accent], [SpLoginTheme danger]]
                              locations:@[@0.0, @1.0]];
    self.titleAccent = titleAccent;
    [titleBar addSubview:titleAccent];

    UILabel *title = [self labelWithFont:(skin ? [SpLoginTheme fontTitle]
                                               : [SpLoginTheme fontOfSize:20 weight:UIFontWeightSemibold])
                                   color:(skin ? [SpLoginTheme textOnDark] : [SpLoginTheme textPrimary])
                                   lines:1];
    title.text = @"服务器绑定";
    title.textAlignment = NSTextAlignmentCenter;
    title.translatesAutoresizingMaskIntoConstraints = NO;
    self.titleLabel = title;
    [titleBar addSubview:title];

    // ---- 验证码逐位方块（业务侧只写 codeLabel.text，方块由 sp_syncCodeTiles 跟随）----
    UIView *codePlate = [[UIView alloc] initWithFrame:CGRectZero];
    codePlate.translatesAutoresizingMaskIntoConstraints = NO;
    [SpLoginTheme applyDarkPlateStyle:codePlate cornerRadius:18.0];
    self.codePlate = codePlate;

    UIView *codeValue = [[UIView alloc] initWithFrame:CGRectZero];
    codeValue.translatesAutoresizingMaskIntoConstraints = NO;
    self.codeValueView = codeValue;
    [codePlate addSubview:codeValue];

    SpLoginCodeLabel *code = [[SpLoginCodeLabel alloc] initWithFrame:CGRectZero];
    code.font = [SpLoginTheme monospacedDigitFontOfSize:32.0 weight:UIFontWeightBold];
    code.textColor = [SpLoginTheme textOnDark];
    code.textAlignment = NSTextAlignmentCenter;
    code.numberOfLines = 1;
    code.text = @"------";
    code.translatesAutoresizingMaskIntoConstraints = NO;
    self.codeLabel = code;
    [codeValue addSubview:code];

    NSMutableArray<UILabel *> *tiles = [NSMutableArray arrayWithCapacity:6];
    for (NSInteger i = 0; i < 6; i++) {
        UILabel *tile = [[UILabel alloc] initWithFrame:CGRectZero];
        tile.font = [SpLoginTheme codeDigitFont];
        tile.textColor = [SpLoginTheme textOnDark];
        tile.textAlignment = NSTextAlignmentCenter;
        tile.backgroundColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.16];
        tile.layer.cornerRadius = [SpLoginTheme radiusChip];
        tile.layer.masksToBounds = YES;
        tile.layer.borderWidth = 1.0;
        tile.layer.borderColor = [[SpLoginTheme primary] colorWithAlphaComponent:0.55].CGColor;
        tile.userInteractionEnabled = NO;
        tile.hidden = YES;
        tile.translatesAutoresizingMaskIntoConstraints = NO;
        [codeValue addSubview:tile];
        [NSLayoutConstraint activateConstraints:@[
            [tile.widthAnchor constraintEqualToConstant:SpLoginCodeTileW],
            [tile.heightAnchor constraintEqualToConstant:SpLoginCodeTileH],
        ]];
        [tiles addObject:tile];
    }
    self.codeTiles = tiles;
    [codeValue addConstraints:@[
        [code.leadingAnchor constraintEqualToAnchor:codeValue.leadingAnchor],
        [code.trailingAnchor constraintEqualToAnchor:codeValue.trailingAnchor],
        [code.topAnchor constraintEqualToAnchor:codeValue.topAnchor],
        [code.heightAnchor constraintEqualToConstant:SpLoginCodeTileH],
    ]];

    // 逐位方块用「懒惰创建 + 横向两端对齐」摆位：完全走约束，不手算 frame。
    // 首尾两块分别贴住容器两侧，中间四块的间距由 equalSpacing 均分。
    NSMutableArray<NSLayoutConstraint *> *tileConstraints = [NSMutableArray array];
    UILabel *previous = nil;
    for (UILabel *tile in tiles) {
        [tileConstraints addObject:[tile.centerYAnchor constraintEqualToAnchor:codeValue.centerYAnchor]];
        [tileConstraints addObject:[tile.topAnchor constraintGreaterThanOrEqualToAnchor:codeValue.topAnchor]];
        [tileConstraints addObject:[tile.bottomAnchor constraintLessThanOrEqualToAnchor:codeValue.bottomAnchor]];
        if (previous == nil) {
            [tileConstraints addObject:[tile.leadingAnchor constraintEqualToAnchor:codeValue.leadingAnchor]];
        } else {
            [tileConstraints addObject:[tile.leadingAnchor constraintGreaterThanOrEqualToAnchor:previous.trailingAnchor
                                                                                      constant:6.0]];
        }
        previous = tile;
    }
    [tileConstraints addObject:[previous.trailingAnchor constraintEqualToAnchor:codeValue.trailingAnchor]];
    [NSLayoutConstraint activateConstraints:tileConstraints];

    UILabel *countdown = [self labelWithFont:[SpLoginTheme fontCaption]
                                       color:[SpLoginTheme textSecondary]
                                       lines:1];
    countdown.textAlignment = NSTextAlignmentCenter;
    countdown.text = @"验证码会随公告下发到游戏里";
    self.countdownLabel = countdown;

    UIView *separator = [[UIView alloc] initWithFrame:CGRectZero];
    separator.translatesAutoresizingMaskIntoConstraints = NO;
    separator.backgroundColor = [SpLoginTheme hairline];
    separator.layer.cornerRadius = SpLoginSeparatorH * 0.5;
    self.separator = separator;

    self.accountField = [self textFieldWithPlaceholder:@"QQ 号" secure:NO keyboard:UIKeyboardTypeNumberPad];
    self.passwordField = [self textFieldWithPlaceholder:@"密码" secure:YES keyboard:UIKeyboardTypeDefault];
    self.confirmField = [self textFieldWithPlaceholder:@"确认密码" secure:YES keyboard:UIKeyboardTypeDefault];

    UIButton *primary = [UIButton buttonWithType:UIButtonTypeCustom];
    [primary setTitle:@"创建账号并绑定" forState:UIControlStateNormal];
    [primary addTarget:self action:@selector(onPrimaryTapped) forControlEvents:UIControlEventTouchUpInside];
    [SpLoginTheme applyPrimaryButtonStyle:primary];
    self.primaryButton = primary;

    UIButton *secondary = [UIButton buttonWithType:UIButtonTypeCustom];
    [secondary setTitle:@"我已有账号" forState:UIControlStateNormal];
    [secondary addTarget:self action:@selector(onSecondaryTapped) forControlEvents:UIControlEventTouchUpInside];
    [SpLoginTheme applySecondaryButtonStyle:secondary];
    self.secondaryButton = secondary;

    UIButton *resend = [UIButton buttonWithType:UIButtonTypeCustom];
    [resend setTitle:@"重新获取验证码" forState:UIControlStateNormal];
    [resend addTarget:self action:@selector(onResendTapped) forControlEvents:UIControlEventTouchUpInside];
    [SpLoginTheme applyLinkButtonStyle:resend];
    self.resendButton = resend;

    UILabel *status = [self labelWithFont:[SpLoginTheme fontCaption]
                                    color:[SpLoginTheme textSecondary]
                                    lines:0];
    status.textAlignment = NSTextAlignmentCenter;
    self.statusLabel = status;

    // ---- 纵向内容栈。注意：UITextField 一旦进了 stack view 就会被「零间距填充」，
    //      间距改由 stack 的 spacing 提供，所以字段没有单独的间距常量。 ----
    UIStackView *stack = [[UIStackView alloc] initWithFrame:CGRectZero];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.alignment = UIStackViewAlignmentFill;
    stack.spacing = gapField;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    self.contentStack = stack;
    [panel addSubview:stack];
    for (UIView *row in @[ codePlate, countdown, separator, self.accountField,
                           self.passwordField, self.confirmField, primary, secondary, resend, status ]) {
        [stack addArrangedSubview:row];
    }
    [stack setCustomSpacing:gapBig afterView:codePlate];
    [stack setCustomSpacing:12.0 afterView:separator];
    [stack setCustomSpacing:gapBig afterView:self.confirmField];
    [stack setCustomSpacing:6.0 afterView:countdown];
    [stack setCustomSpacing:5.0 afterView:secondary];

    // ---- 底缘装饰条（token: decoration-assets/bottom_decoration_part_a|b|c）----
    UIView *decoration = [SpLoginTheme makeBottomDecorationBarWithWidth:SpLoginPanelWidth];
    decoration.translatesAutoresizingMaskIntoConstraints = NO;
    self.bottomDecoration = decoration;
    [panel addSubview:decoration];

    // 160 = 面板内容的横向内边距合计；用 guide 表达，面板窄了内容跟着窄，不写死。
    UILayoutGuide *contentGuide = [[UILayoutGuide alloc] init];
    [panel addLayoutGuide:contentGuide];

    CGFloat panelWidth = MIN(SpLoginPanelMaxWidth, CGRectGetWidth([UIScreen mainScreen].bounds) - 40.0);
    panelWidth = MAX(panelWidth, 280.0);
    self.accountField.translatesAutoresizingMaskIntoConstraints = NO;
    self.passwordField.translatesAutoresizingMaskIntoConstraints = NO;
    self.confirmField.translatesAutoresizingMaskIntoConstraints = NO;

    [NSLayoutConstraint activateConstraints:@[
        [panel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [panel.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor constant:-8.0],
        [panel.widthAnchor constraintEqualToConstant:panelWidth],

        [titleBar.topAnchor constraintEqualToAnchor:panel.topAnchor],
        [titleBar.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor],
        [titleBar.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor],
        [titleBar.heightAnchor constraintEqualToConstant:SpLoginTitleBarHeight],

        [title.centerXAnchor constraintEqualToAnchor:titleBar.centerXAnchor],
        [title.centerYAnchor constraintEqualToAnchor:titleBar.centerYAnchor],
        [title.leadingAnchor constraintGreaterThanOrEqualToAnchor:titleBar.leadingAnchor constant:12.0],
        [title.trailingAnchor constraintLessThanOrEqualToAnchor:titleBar.trailingAnchor constant:-12.0],

        [titleAccent.leadingAnchor constraintEqualToAnchor:titleBar.leadingAnchor],
        [titleAccent.trailingAnchor constraintEqualToAnchor:titleBar.trailingAnchor],
        [titleAccent.bottomAnchor constraintEqualToAnchor:titleBar.bottomAnchor],
        [titleAccent.heightAnchor constraintEqualToConstant:SpLoginTitleAccentH],

        [decoration.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor],
        [decoration.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor],
        [decoration.bottomAnchor constraintEqualToAnchor:panel.bottomAnchor],
        [decoration.heightAnchor constraintEqualToConstant:SpLoginFooterHeight],

        [contentGuide.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor constant:12.0],
        [contentGuide.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor constant:-12.0],
        [contentGuide.topAnchor constraintEqualToAnchor:titleBar.bottomAnchor constant:topPad],
        [contentGuide.bottomAnchor constraintEqualToAnchor:decoration.topAnchor constant:-topPad],

        [stack.leadingAnchor constraintEqualToAnchor:contentGuide.leadingAnchor],
        [stack.trailingAnchor constraintEqualToAnchor:contentGuide.trailingAnchor],
        [stack.topAnchor constraintEqualToAnchor:contentGuide.topAnchor],

        [codeValue.leadingAnchor constraintEqualToAnchor:codePlate.leadingAnchor constant:10.0],
        [codeValue.trailingAnchor constraintEqualToAnchor:codePlate.trailingAnchor constant:-10.0],
        [codeValue.topAnchor constraintEqualToAnchor:codePlate.topAnchor constant:12.0],
        [codeValue.bottomAnchor constraintEqualToAnchor:codePlate.bottomAnchor constant:-12.0],

        [separator.heightAnchor constraintEqualToConstant:SpLoginSeparatorH],

        [self.accountField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [self.passwordField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [self.confirmField.heightAnchor constraintEqualToConstant:SpLoginFieldHeight],
        [primary.heightAnchor constraintEqualToConstant:SpLoginButtonHeight],
        [secondary.heightAnchor constraintEqualToConstant:SpLoginSecondaryHeight],
        [resend.heightAnchor constraintEqualToConstant:SpLoginResendHeight],
    ]];

    if (skin) {
        // 逐位方块视觉：codeLabel.text 一变就刷新（业务侧那一行没动）。
        __weak typeof(self) weakSelf = self;
        self.codeLabel.sp_onTextChanged = ^(NSString *text) {
            __strong typeof(self) strongSelf = weakSelf;
            [strongSelf sp_syncCodeTilesWithText:text];
        };
        [self sp_syncCodeTilesWithText:self.codeLabel.text];
        // 输入框聚焦描边（纯 layer：不缓存子视图树，所以光标与键盘行为一字不改）
        for (UITextField *field in @[ self.accountField, self.passwordField, self.confirmField ]) {
            [field addTarget:self action:@selector(sp_fieldEditingBegan:)
            forControlEvents:UIControlEventEditingDidBegin];
            [field addTarget:self action:@selector(sp_fieldEditingEnded:)
            forControlEvents:UIControlEventEditingDidEnd];
        }
    } else {
        // 皮肤关掉：收掉所有装饰，回到「只有标题 + 控件」的通用表单。
        self.codeLabel.hidden = YES;
        self.codeLabel.sp_onTextChanged = nil;
        for (UILabel *tile in tiles) {
            tile.hidden = YES;
        }
        [self sp_setDecorationsHidden:YES];
    }

    SPLoginLog(@"[SpLogin] panel skin=%@ compact=%@ width=%.0f（纯外观层，业务未变）",
               skin ? @"on" : @"off", compact ? @"yes" : @"no", panelWidth);
}

/// 装饰视图整体开关（皮肤关掉时用）。只切 hidden，不动任何业务控件。
- (void)sp_setDecorationsHidden:(BOOL)hidden
{
    self.titleBar.backgroundColor = hidden ? [SpLoginTheme primary] : [SpLoginTheme plateDark];
    self.titleLabel.textColor = hidden ? [SpLoginTheme textOnDark] : self.titleLabel.textColor;
    self.titleAccent.hidden = hidden;
    self.codePlate.backgroundColor = hidden ? UIColor.clearColor : [SpLoginTheme plateDark];
    self.bottomDecoration.hidden = hidden;
    self.separator.hidden = hidden;
}

/// 把 `codeLabel.text` 映射到 6 个方块。等宽字体 + 固定格宽 ⇒ 逐位对齐、不跳动。
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
    [SpLoginTheme setFieldFocused:field focused:YES];
}

- (void)sp_fieldEditingEnded:(UITextField *)field
{
    [SpLoginTheme setFieldFocused:field focused:NO];
}

- (UILabel *)labelWithFont:(UIFont *)font color:(UIColor *)color lines:(NSInteger)lines
{
    UILabel *label = [[UILabel alloc] initWithFrame:CGRectZero];
    label.font = font;
    label.textColor = color;
    label.numberOfLines = lines;
    return label;
}

- (UITextField *)textFieldWithPlaceholder:(NSString *)placeholder secure:(BOOL)secure keyboard:(UIKeyboardType)keyboard
{
    UITextField *field = [[UITextField alloc] initWithFrame:CGRectZero];
    field.placeholder = placeholder;
    field.secureTextEntry = secure;
    field.keyboardType = keyboard;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo;
    field.borderStyle = UITextBorderStyleNone;
    // 外观整体交给皮肤层（底/描边/圆角/内边距/聚焦态）。行为部分（delegate、
    // returnKeyType、键盘类型、左右视图）仍在下面照旧设置，一个字没改。
    [SpLoginTheme applyFieldStyle:field];
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
        self.statusLabel.textColor = [SpLoginTheme textSecondary];
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
