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

@interface SpLoginViewController () <UITextFieldDelegate>

@property (nonatomic, strong) UIView *panel;
@property (nonatomic, strong) UILabel *titleLabel;
@property (nonatomic, strong) UILabel *codeLabel;
@property (nonatomic, strong) UILabel *countdownLabel;
@property (nonatomic, strong) UITextField *accountField;
@property (nonatomic, strong) UITextField *passwordField;
@property (nonatomic, strong) UITextField *confirmField;
@property (nonatomic, strong) UIButton *primaryButton;
@property (nonatomic, strong) UIButton *secondaryButton;
@property (nonatomic, strong) UIButton *resendButton;
@property (nonatomic, strong) UILabel *statusLabel;

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

- (void)viewDidAppear:(BOOL)animated
{
    [super viewDidAppear:animated];
    // 本地已有会话 ⇒ 直接继续轮询绑定状态（换设备/重开会话都能续上）
    if ([SpLoginAPI sharedAPI].token.length > 0) {
        [self refreshBindStatus];
    }
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

#pragma mark - 视图

- (void)buildViews
{
    self.view.backgroundColor = [SpLoginTheme scrim];

    UIView *panel = [[UIView alloc] initWithFrame:CGRectZero];
    panel.translatesAutoresizingMaskIntoConstraints = NO;
    [SpLoginTheme applyPanelStyle:panel];
    self.panel = panel;
    [self.view addSubview:panel];

    UILabel *title = [self labelWithFont:[SpLoginTheme fontOfSize:20 weight:UIFontWeightSemibold]
                                   color:[SpLoginTheme textPrimary]
                                   lines:1];
    title.text = @"服务器绑定";
    title.textAlignment = NSTextAlignmentCenter;
    self.titleLabel = title;

    UILabel *code = [self labelWithFont:[SpLoginTheme monospacedDigitFontOfSize:40 weight:UIFontWeightBold]
                                  color:[SpLoginTheme primary]
                                  lines:1];
    code.textAlignment = NSTextAlignmentCenter;
    code.text = @"------";
    self.codeLabel = code;

    UILabel *countdown = [self labelWithFont:[SpLoginTheme fontOfSize:13 weight:UIFontWeightRegular]
                                       color:[SpLoginTheme textSecondary]
                                       lines:1];
    countdown.textAlignment = NSTextAlignmentCenter;
    countdown.text = @"验证码会随公告下发到游戏里";
    self.countdownLabel = countdown;

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
    [resend setTitleColor:[SpLoginTheme primary] forState:UIControlStateNormal];
    resend.titleLabel.font = [SpLoginTheme fontOfSize:13 weight:UIFontWeightMedium];
    [resend addTarget:self action:@selector(onResendTapped) forControlEvents:UIControlEventTouchUpInside];
    self.resendButton = resend;

    UILabel *status = [self labelWithFont:[SpLoginTheme fontOfSize:13 weight:UIFontWeightRegular]
                                    color:[SpLoginTheme textSecondary]
                                    lines:0];
    status.textAlignment = NSTextAlignmentCenter;
    self.statusLabel = status;

    NSArray<UIView *> *rows = @[ title, code, countdown, self.accountField, self.passwordField,
                                 self.confirmField, primary, secondary, resend, status ];
    for (UIView *row in rows) {
        row.translatesAutoresizingMaskIntoConstraints = NO;
        [panel addSubview:row];
    }
    UILayoutGuide *guide = panel.layoutMarginsGuide;
    [NSLayoutConstraint activateConstraints:@[
        [panel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [panel.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
        [panel.widthAnchor constraintEqualToConstant:320.0],

        [title.topAnchor constraintEqualToAnchor:guide.topAnchor constant:20.0],
        [title.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [title.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],

        [code.topAnchor constraintEqualToAnchor:title.bottomAnchor constant:12.0],
        [code.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [code.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],

        [countdown.topAnchor constraintEqualToAnchor:code.bottomAnchor constant:6.0],
        [countdown.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [countdown.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],

        [self.accountField.topAnchor constraintEqualToAnchor:countdown.bottomAnchor constant:18.0],
        [self.accountField.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.accountField.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [self.accountField.heightAnchor constraintEqualToConstant:44.0],

        [self.passwordField.topAnchor constraintEqualToAnchor:self.accountField.bottomAnchor constant:10.0],
        [self.passwordField.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.passwordField.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [self.passwordField.heightAnchor constraintEqualToConstant:44.0],

        [self.confirmField.topAnchor constraintEqualToAnchor:self.passwordField.bottomAnchor constant:10.0],
        [self.confirmField.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [self.confirmField.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [self.confirmField.heightAnchor constraintEqualToConstant:44.0],

        [primary.topAnchor constraintEqualToAnchor:self.confirmField.bottomAnchor constant:16.0],
        [primary.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [primary.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [primary.heightAnchor constraintEqualToConstant:48.0],

        [secondary.topAnchor constraintEqualToAnchor:primary.bottomAnchor constant:10.0],
        [secondary.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [secondary.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [secondary.heightAnchor constraintEqualToConstant:44.0],

        [resend.topAnchor constraintEqualToAnchor:secondary.bottomAnchor constant:8.0],
        [resend.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [resend.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [resend.heightAnchor constraintEqualToConstant:28.0],

        [status.topAnchor constraintEqualToAnchor:resend.bottomAnchor constant:12.0],
        [status.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
        [status.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
        [status.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor constant:-18.0],
    ]];
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
    field.backgroundColor = [UIColor whiteColor];
    field.textColor = [SpLoginTheme textPrimary];
    field.font = [SpLoginTheme fontOfSize:15 weight:UIFontWeightRegular];
    field.layer.cornerRadius = [SpLoginTheme radiusField];
    field.layer.borderWidth = 1.0;
    field.layer.borderColor = [SpLoginTheme hairline].CGColor;
    field.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 12, 0)];
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
