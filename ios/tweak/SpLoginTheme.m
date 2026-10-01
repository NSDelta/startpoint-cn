// SpLoginTheme.m —— 官方样式 token 的 Objective-C 投影（P10-B）
//
// 数值来源：D:\wfcnmod\ios-ui-kit\style-tokens.json（从官方 .ui 预制件抽出）。
// 缺项（深色铭牌、光晕的 alpha、装饰条形状）以游戏内同类界面的既有观感补齐，
// 补了哪些、依据是什么，写在 ios/tweak/README.md 第 8 节。
//
// ★ 本文件的每一个方法都只做「给一个 view/layer 上色」。没有网络、没有定时器、
//   没有状态机、没有读取任何业务字段；改这里不可能改变插件的行为。

#import "SpLoginTheme.h"

#pragma mark - 内部：渐变层

/// 竖向渐变的宿主层。它是 UIView.layer 的**兄弟层**（加在 superlayer 上、zPosition = -1），
/// 所以不受宿主 view 的 clipsToBounds / cornerRadius 影响——宿主自己负责圆角裁剪。
/// 用 layoutSublayers 跟随宿主 bounds，免去手动维护 frame。
@interface SpLoginGradientLayer : CAGradientLayer
@property (nonatomic, weak, nullable) UIView *hostView;
@end

@implementation SpLoginGradientLayer

- (void)layoutSublayers {
    [super layoutSublayers];
    UIView *host = self.hostView;
    if (host == nil) return;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];   // 布局期的隐式动画会让渐变「追着」视图跑
    self.frame = host.bounds;
    [CATransaction commit];
}

@end

static NSString *const kSpLoginGradientKey = @"SpLoginGradient";

#pragma mark - 内部：本文件私有方法（不对外，避免污染公开 API）

@interface SpLoginTheme ()
+ (UIColor *)colorWithHex:(NSUInteger)hex;
+ (void)applyFilledButtonStyle:(UIButton *)button
                        colors:(NSArray<UIColor *> *)colors
                          glow:(UIColor *)glow
                    glyphColor:(UIColor *)glyphColor;
@end

#pragma mark - 内部：小工具

/// 08/18/28 亮度变化，用来做顶部内高光（官方九宫格的 gloss 位）。
static UIColor *SpLoginTint(UIColor *color, CGFloat delta) {
    CGFloat r = 0, g = 0, b = 0, a = 0;
    if (![color getRed:&r green:&g blue:&b alpha:&a]) return color;
    return [UIColor colorWithRed:MIN(1.0, MAX(0.0, r + delta))
                           green:MIN(1.0, MAX(0.0, g + delta))
                           blue:MIN(1.0, MAX(0.0, b + delta))
                           alpha:a];
}

/// 给 view 挂一层「指定圆角的描边」子层。glowWidth 用 token 里的 glow6。
static CAShapeLayer *SpLoginEnsureStrokeLayer(UIView *view,
                                              NSString *key,
                                              CGFloat lineWidth,
                                              CGFloat inset,
                                              UIColor *color) {
    if (view == nil) return nil;
    CAShapeLayer *layer = (CAShapeLayer *)[view.layer valueForKey:key];
    if (![layer isKindOfClass:[CAShapeLayer class]]) {
        layer = [CAShapeLayer layer];
        layer.fillColor = UIColor.clearColor.CGColor;
        layer.contentsScale = UIScreen.mainScreen.scale;
        [view.layer setValue:layer forKey:key];
        [view.layer addSublayer:layer];
    }
    layer.lineWidth = lineWidth;
    layer.strokeColor = color.CGColor;
    UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:CGRectInset(view.bounds, inset, inset)
                                               byRoundingCorners:UIRectCornerAllCorners
                                                     cornerRadii:CGSizeMake(view.layer.cornerRadius,
                                                                            view.layer.cornerRadius)];
    layer.path = path.CGPath;
    return layer;
}

/// 圆角矩形阴影路径：比默认的「按 alpha 通道算」便宜得多，也不会因为渐变层在
/// 兄弟层级上而算出空阴影。
static void SpLoginApplyRoundedShadow(UIView *view,
                                      CGFloat radius,
                                      UIColor *color,
                                      CGFloat opacity,
                                      CGFloat blur,
                                      CGSize offset) {
    if (view == nil) return;
    view.layer.shadowColor = color.CGColor;
    view.layer.shadowOpacity = (float)opacity;
    view.layer.shadowRadius = blur;
    view.layer.shadowOffset = offset;
    UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:view.bounds
                                               byRoundingCorners:UIRectCornerAllCorners
                                                     cornerRadii:CGSizeMake(radius, radius)];
    view.layer.shadowPath = path.CGPath;
}

@implementation SpLoginTheme

#pragma mark - 配色（token）

+ (UIColor *)primary      { return [self colorWithHex:0x2EC4B6]; }
+ (UIColor *)danger       { return [self colorWithHex:0xEA3553]; }
+ (UIColor *)accent       { return [self colorWithHex:0xFF9F1C]; }
+ (UIColor *)infoBlue     { return [self colorWithHex:0x55ACEE]; }
+ (UIColor *)panel        { return [self colorWithHex:0xFAFAFA]; }
+ (UIColor *)textPrimary  { return [self colorWithHex:0x444444]; }   // token 正文色
+ (UIColor *)textSecondary{ return [self colorWithHex:0x515151]; }   // general_menu.ui
+ (UIColor *)textDisabled { return [self colorWithHex:0xC9C9C9]; }
+ (UIColor *)hairline     { return [self colorWithHex:0xDDDDDD]; }

+ (UIColor *)scrim {
    // 遮罩不是官方素材（游戏里没有「覆盖在别人画面上的弹窗」这种东西），
    // 取主色的深色变体压暗游戏画面：比纯黑更像游戏内弹窗的着色，且能压住亮背景。
    return [UIColor colorWithRed:0.043 green:0.106 blue:0.114 alpha:0.62];
}

/// 0xRRGGBB → UIColor。
+ (UIColor *)colorWithHex:(NSUInteger)hex {
    return [UIColor colorWithRed:((hex >> 16) & 0xFF) / 255.0
                           green:((hex >> 8) & 0xFF) / 255.0
                           blue:(hex & 0xFF) / 255.0
                           alpha:1.0];
}

#pragma mark - 配色（token 派生）

+ (UIColor *)surfaceMuted { return [self colorWithHex:0xEAEAEA]; }
+ (UIColor *)plateDark    { return [self colorWithHex:0x2A2F35]; }
+ (UIColor *)textOnDark   { return UIColor.whiteColor; }
+ (UIColor *)textOnDarkSecondary {
    return [UIColor colorWithWhite:1.0 alpha:0.72];
}
+ (UIColor *)primaryGlow:(CGFloat)alpha {
    return [[self primary] colorWithAlphaComponent:alpha];
}
+ (UIColor *)dangerGlow:(CGFloat)alpha {
    return [[self danger] colorWithAlphaComponent:alpha];
}

#pragma mark - 几何

+ (CGFloat)radiusPanel      { return 32.0; }
+ (CGFloat)radiusButton     { return 24.0; }
+ (CGFloat)radiusField      { return 18.0; }
+ (CGFloat)radiusChip       { return 12.0; }
+ (CGFloat)radiusPlate      { return 8.0; }
+ (CGFloat)glowWidth        { return 6.0; }
+ (CGFloat)shadowOpacity    { return 0.18; }
+ (CGFloat)shadowRadius     { return 20.0; }
+ (CGFloat)shadowRadiusSoft { return 4.0; }
+ (CGFloat)hairlineWidth    { return 1.0; }

#pragma mark - 字号

+ (UIFont *)fontOfSize:(CGFloat)size weight:(UIFontWeight)weight {
    return [UIFont systemFontOfSize:size weight:weight];
}

+ (UIFont *)monospacedDigitFontOfSize:(CGFloat)size weight:(UIFontWeight)weight {
    UIFont *base = [UIFont monospacedDigitSystemFontOfSize:size weight:weight];
    return base ?: [self fontOfSize:size weight:weight];
}

+ (UIFont *)fontTitle  { return [self fontOfSize:22.0 weight:UIFontWeightSemibold]; }  // xml size24
+ (UIFont *)fontButton { return [self fontOfSize:19.0 weight:UIFontWeightSemibold]; }
+ (UIFont *)fontBody   { return [self fontOfSize:15.0 weight:UIFontWeightRegular]; }
+ (UIFont *)fontCaption{ return [self fontOfSize:13.0 weight:UIFontWeightRegular]; }
+ (UIFont *)fontBall   { return [self fontOfSize:22.0 weight:UIFontWeightBold]; }
+ (UIFont *)codeDigitFont { return [self monospacedDigitFontOfSize:30.0 weight:UIFontWeightBold]; } // xml size32/fafafa, size30/bold

#pragma mark - 渐变

+ (void)applyVerticalGradient:(UIView *)view
                        colors:(NSArray<UIColor *> *)colors
                    locations:(NSArray<NSNumber *> *)locations {
    if (view == nil || colors.count < 2) return;
    CALayer *existing = [view.layer valueForKey:kSpLoginGradientKey];
    SpLoginGradientLayer *gradient = nil;
    if ([existing isKindOfClass:[SpLoginGradientLayer class]]) {
        gradient = (SpLoginGradientLayer *)existing;
    } else {
        gradient = [SpLoginGradientLayer layer];
        gradient.hostView = view;
        gradient.startPoint = CGPointMake(0.5, 0.0);
        gradient.endPoint = CGPointMake(0.5, 1.0);
        // 兄弟层 + zPosition = -1：在背景之上、所有子视图之下，且永远在正确位置。
        // 类型写成 NSNumber 而不是 @(-1)：CAGradientLayer 的 zPosition 是 CGFloat，
        // 直接写 @(-1) 会被当成 int，在 64 位下是不同的 NSNumber 编码。
        gradient.zPosition = (CGFloat)-1.0;
        [view.layer setValue:gradient forKey:kSpLoginGradientKey];
        [view.layer addSublayer:gradient];
    }
    gradient.hostView = view;
    NSMutableArray *cgColors = [NSMutableArray arrayWithCapacity:colors.count];
    for (UIColor *color in colors) {
        [cgColors addObject:(__bridge id)color.CGColor];
    }
    gradient.colors = cgColors;
    gradient.locations = locations;
    gradient.frame = view.bounds;
    [gradient setNeedsLayout];
}

#pragma mark - 形状

/// 通用实心按钮：渐变 + 描边 + 光晕环 + 落影。所有按钮样式都汇到这里。
+ (void)applyFilledButtonStyle:(UIButton *)button
                        colors:(NSArray<UIColor *> *)colors
                         glow:(UIColor *)glow
                      glyphColor:(UIColor *)glyphColor {
    if (button == nil) return;
    button.clipsToBounds = NO;   // 光晕/落影要画到 bounds 外面
    button.layer.cornerRadius = [self radiusButton];
    button.layer.masksToBounds = NO;
    button.backgroundColor = UIColor.clearColor;
    button.titleLabel.font = [self fontButton];
    [button setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    [button setTitleColor:UIColor.whiteColor forState:UIControlStateHighlighted];
    [button setTitleColor:glyphColor forState:UIControlStateDisabled];

    [self applyVerticalGradient:button colors:colors locations:@[@0.0, @1.0]];
    SpLoginEnsureStrokeLayer(button, @"SpLoginBtnStroke", [self glowWidth], -([self glowWidth] * 0.5), glow);
    SpLoginEnsureStrokeLayer(button, @"SpLoginBtnEdge", 1.0, 0.5, [UIColor colorWithWhite:1.0 alpha:0.35]);
    SpLoginApplyRoundedShadow(button, [self radiusButton], UIColor.blackColor,
                              [self shadowOpacity], [self shadowRadius], CGSizeMake(0, 6));
}

+ (void)applyPrimaryButtonStyle:(UIButton *)button {
    // token: bg-assets/color2ec4b6_round24_glow6_shadow20
    [self applyFilledButtonStyle:button
                          colors:@[SpLoginTint([self primary], 0.08), [self primary]]
                            glow:[self primaryGlow:0.55]
                      glyphColor:[self textDisabled]];
}

+ (void)applySecondaryButtonStyle:(UIButton *)button {
    // token: bg-assets/colorea3553_round24_glow6_shadow20
    [self applyFilledButtonStyle:button
                          colors:@[SpLoginTint([self danger], 0.07), [self danger]]
                            glow:[self dangerGlow:0.45]
                      glyphColor:[self textDisabled]];
}

/// 正向高亮按钮（`colorff9f1c_round24_glow6_shadow20`）。当前面板没用到，
/// 留给「回到游戏」这类需要更醒目的入口，避免以后为了一个颜色去改业务文件。
+ (void)applyAccentButtonStyle:(UIButton *)button {
    // token: bg-assets/colorff9f1c_round24_glow6_shadow20
    UIColor *accent = [self accent];
    [self applyFilledButtonStyle:button
                          colors:@[SpLoginTint(accent, 0.09), accent]
                            glow:[accent colorWithAlphaComponent:0.5]
                      glyphColor:[self textDisabled]];
}

+ (void)applyLinkButtonStyle:(UIButton *)button {
    if (button == nil) return;
    button.clipsToBounds = NO;
    button.layer.cornerRadius = 14.0;
    button.layer.masksToBounds = NO;
    button.layer.shadowOpacity = 0.0f;
    button.layer.shadowPath = NULL;
    button.backgroundColor = [[self primary] colorWithAlphaComponent:0.10];
    button.titleLabel.font = [self fontCaption];
    [button setTitleColor:[self primary] forState:UIControlStateNormal];
    [button setTitleColor:[[self primary] colorWithAlphaComponent:0.55] forState:UIControlStateHighlighted];
    [button setTitleColor:[self textDisabled] forState:UIControlStateDisabled];
}

+ (void)applyPanelStyle:(UIView *)view {
    if (view == nil) return;
    view.backgroundColor = [self panel];
    view.layer.cornerRadius = [self radiusPanel];
    view.layer.masksToBounds = NO;          // 落影在圆角外
    view.clipsToBounds = NO;
    view.layer.borderWidth = 0.0;
    view.layer.borderColor = UIColor.clearColor.CGColor;
    SpLoginApplyRoundedShadow(view, [self radiusPanel], UIColor.blackColor, 0.34,
                              [self shadowRadiusSoft] * 3.0, CGSizeMake(0, 10));
    // 面板顶缘高光（官方九宫格 gloss 位的程序化近似）
    SpLoginEnsureStrokeLayer(view, @"SpLoginPanelEdge", 1.0, 0.5, [UIColor colorWithWhite:1.0 alpha:0.9]);
}

+ (void)applyFieldStyle:(UITextField *)field {
    if (field == nil) return;
    field.backgroundColor = [self surfaceMuted];
    field.textColor = [self textPrimary];
    field.font = [self fontBody];
    field.layer.cornerRadius = [self radiusField];
    field.layer.masksToBounds = NO;
    field.clipsToBounds = NO;
    [self setFieldFocused:field focused:NO];
}

+ (void)setFieldFocused:(UITextField *)field focused:(BOOL)focused {
    if (field == nil) return;
    field.backgroundColor = focused ? UIColor.whiteColor : [self surfaceMuted];
    CAShapeLayer *stroke = SpLoginEnsureStrokeLayer(field,
                                                    @"SpLoginFieldStroke",
                                                    focused ? 2.0 : [self hairlineWidth],
                                                    focused ? -1.0 : 0.5,
                                                    focused ? [self primary] : [self hairline]);
    if (focused) {
        field.layer.shadowColor = [[self primary] CGColor];
        field.layer.shadowOpacity = 0.28f;
        field.layer.shadowRadius = [self glowWidth];
        field.layer.shadowOffset = CGSizeZero;
        UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:field.bounds
                                                   byRoundingCorners:UIRectCornerAllCorners
                                                         cornerRadii:CGSizeMake([self radiusField],
                                                                                [self radiusField])];
        field.layer.shadowPath = path.CGPath;
    } else {
        field.layer.shadowOpacity = 0.0f;
        field.layer.shadowPath = NULL;
    }
    (void)stroke;
}

+ (void)applyDarkPlateStyle:(UIView *)view cornerRadius:(CGFloat)radius {
    if (view == nil) return;
    view.backgroundColor = [self plateDark];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
    // 下亮上暗的轻微渐变：让铭牌看起来是「嵌」进面板的，而不是贴上去的
    [self applyVerticalGradient:view
                         colors:@[SpLoginTint([self plateDark], -0.04), [self plateDark]]
                      locations:@[@0.0, @1.0]];
    SpLoginEnsureStrokeLayer(view, @"SpLoginPlateEdge", 1.0, 0.5, [UIColor colorWithWhite:1.0 alpha:0.16]);
}

+ (void)applyFloatingBallStyle:(UIButton *)button diameter:(CGFloat)diameter {
    if (button == nil) return;
    CGFloat radius = diameter * 0.5;
    button.clipsToBounds = NO;
    button.layer.cornerRadius = radius;
    button.layer.masksToBounds = NO;
    button.backgroundColor = UIColor.clearColor;
    button.titleLabel.font = [self fontBall];
    [button setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    [button setTitleColor:[UIColor colorWithWhite:1.0 alpha:0.85] forState:UIControlStateHighlighted];

    // token: circle-assets/color2ec4b6_radius64_glow6_shadow8（圆形，半径 64）
    UIColor *primary = [self primary];
    [self applyVerticalGradient:button
                         colors:@[SpLoginTint(primary, 0.10), SpLoginTint(primary, -0.06)]
                      locations:@[@0.0, @1.0]];
    // 渐变层是宿主层的子层，而球的 `masksToBounds = NO`（要给光晕与落影留出 bounds 外的位置），
    // 于是渐变层不会被球的圆角裁掉 —— 真机上表现为圆球背后顶着一块**方形青底**。
    // 球本来就是正圆，这里让渐变层自己裁圆即可；改的是 layer 不是 frame，不会被 layoutSublayers 冲掉。
    CALayer *ballGradient = [button.layer valueForKey:kSpLoginGradientKey];
    if ([ballGradient isKindOfClass:[SpLoginGradientLayer class]]) {
        ballGradient.cornerRadius = radius;
        ballGradient.masksToBounds = YES;
    }
    SpLoginEnsureStrokeLayer(button, @"SpLoginBallGlow", [self glowWidth], -([self glowWidth] * 0.5),
                             [self primaryGlow:0.55]);
    SpLoginEnsureStrokeLayer(button, @"SpLoginBallEdge", 2.0, 1.0, [UIColor colorWithWhite:1.0 alpha:0.85]);
    SpLoginApplyRoundedShadow(button, radius, UIColor.blackColor, 0.35, 8.0, CGSizeMake(0, 3));
}

#pragma mark - 装饰

/// `decoration-assets/bottom_decoration_part_a|b|c` 的程序化近似：三段拼接，
/// 左右两段是收窄的斜角（a/c），中段重复平铺（b）。官方是位图素材，这里用矢量等价形状，
/// 色值仍取自 token（主色 #2EC4B6 与橙强调 #FF9F1C）。
+ (UIView *)makeBottomDecorationBarWithWidth:(CGFloat)width {
    CGFloat w = MAX(width, 1.0);
    UIView *bar = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, w * 14.0 / 320.0)];
    bar.backgroundColor = UIColor.clearColor;
    bar.userInteractionEnabled = NO;
    bar.clipsToBounds = YES;

    UIColor *primary = [self primary];
    UIColor *accent = [self accent];
    CGFloat height = CGRectGetHeight(bar.bounds);
    CGFloat side = w * 62.0 / 320.0;          // a / c 两段的宽度
    CGFloat midLeft = side;
    CGFloat midRight = w - side;

    if (midRight > midLeft) {
        UIView *mid = [[UIView alloc] initWithFrame:CGRectMake(midLeft, height * 0.30,
                                                              midRight - midLeft, height * 0.10)];
        mid.backgroundColor = [primary colorWithAlphaComponent:0.85];
        mid.autoresizingMask = UIViewAutoresizingFlexibleWidth;
        [bar addSubview:mid];
    }

    // a：左端的上斜条 + 下方圆点（point a）
    UIView *left = [[UIView alloc] initWithFrame:CGRectMake(0, height * 0.30, side, height * 0.10)];
    [self applyVerticalGradient:left
                         colors:@[accent, [self danger]]
                      locations:@[@0.0, @1.0]];
    [bar addSubview:left];
    UIView *leftDot = [[UIView alloc] initWithFrame:CGRectMake(side * 0.10, height * 0.62,
                                                              height * 0.26, height * 0.26)];
    leftDot.backgroundColor = accent;
    leftDot.layer.cornerRadius = height * 0.13;
    [bar addSubview:leftDot];

    // c：右端镜像
    UIView *right = [[UIView alloc] initWithFrame:CGRectMake(midRight, height * 0.30, side, height * 0.10)];
    [self applyVerticalGradient:right
                         colors:@[[self danger], accent]
                      locations:@[@0.0, @1.0]];
    [bar addSubview:right];
    UIView *rightDot = [[UIView alloc] initWithFrame:CGRectMake(w - side * 0.10 - height * 0.26,
                                                               height * 0.62, height * 0.26, height * 0.26)];
    rightDot.backgroundColor = accent;
    rightDot.layer.cornerRadius = height * 0.13;
    [bar addSubview:rightDot];

    left.autoresizingMask = UIViewAutoresizingFlexibleRightMargin;
    right.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
    leftDot.autoresizingMask = UIViewAutoresizingFlexibleRightMargin;
    rightDot.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
    return bar;
}

+ (void)pinAspectOfBottomDecoration:(UIView *)decorationView {
    if (decorationView == nil) return;
    decorationView.translatesAutoresizingMaskIntoConstraints = NO;
    CGFloat height = CGRectGetHeight(decorationView.bounds);
    CGFloat width = MAX(CGRectGetWidth(decorationView.bounds), 1.0);
    [decorationView.heightAnchor constraintEqualToConstant:MAX(height, 1.0)].active = YES;
    [decorationView.widthAnchor constraintEqualToAnchor:decorationView.heightAnchor
                                            multiplier:(width / MAX(height, 1.0))].active = YES;
}

@end
