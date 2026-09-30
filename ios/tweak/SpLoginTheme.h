// SpLoginTheme.h —— 官方样式 token 的 Objective-C 投影（P10-B）
//
// 数值全部来自 D:\wfcnmod\ios-ui-kit\style-tokens.json（从官方预制件抽出），
// 与 P6（Android AS3 登录页）共用同一份 token，两边不得各调一套。
// 九宫格素材命名规范：color<RRGGBB>_round<圆角>_glow<发光>_shadow<阴影>
//
// 对应关系（素材名 → 本文件常量）：
//   bg-assets/color2ec4b6_round24_glow6_shadow20   → 主按钮
//   bg-assets/colorea3553_round24_glow6_shadow20   → 次按钮 / 危险
//   bg-assets/colorc9c9c9_round24_glow6_shadow20   → 禁用
//   bg-assets/colorfafafa_round32_shadow8          → 面板
//   bg-assets/color222222_round4_shadow8           → 深色底（loading.ui）
//   decoration-assets/bottom_decoration_part_a|b|c → 面板底缘装饰条
//
// ★ 补值（token 里没有、但面板必须有的，逐条依据见 README「8.3 补了哪些值」）：
//   plateDark #2A2F35（深色标题铭牌，介于 token 的深底 #222222 与正文 #444444 之间）、
//   textOnDark/textOnDarkSecondary（官方位图字体名 size24_medium_ffffff ⇒ 深底配白字）、
//   primaryGlow:/dangerGlow:（glow6 的程序化近似：主色 55% 不透明度、半径 6）、
//   radiusChip 12（官方圆角阶只有 18/24/32/64，验证码方块取 18 的下半档）、
//   shadowRadiusSoft 4 / hairlineWidth 1（shadow4 档 + iOS 最小可见线宽）。
//
// ★ 本层只负责「长什么样」，**不碰任何业务逻辑**：
//   SpLoginTheme 里没有任何网络/定时器/状态机代码，所有方法都是「给一个 view 上色」。
//   业务（SpLoginAPI / 轮询 / 状态机）全部在 SpLoginViewController 与 SpLoginAPI 里，未改。

#import <UIKit/UIKit.h>
// UIView.layer 的类型 CALayer 由 QuartzCore 引入。UIKit 不再保证传递引入它，
// 缺了它 button.layer.cornerRadius 等成员访问在 CI 上是硬错误。
#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

/// 面板底缘装饰条的三个部件，对应 token 里的
/// `decoration-assets/bottom_decoration_part_a|b|c`（左 / 中 / 右）。
typedef NS_ENUM(NSInteger, SpLoginDecorPart) {
    SpLoginDecorPartA = 0,   ///< bottom_decoration_part_a（左段）
    SpLoginDecorPartB,       ///< bottom_decoration_part_b（中段，重复平铺）
    SpLoginDecorPartC,       ///< bottom_decoration_part_c（右段）
};

@interface SpLoginTheme : NSObject

#pragma mark - 配色（token）

// 配色（token: #2EC4B6 / #EA3553 / #FF9F1C / #55ACEE / #FAFAFA / #EAEAEA / #C9C9C9
//        / #444444 / #515151 / #DDDDDD / #222222）
+ (UIColor *)primary;        // #2EC4B6  主色（take_over.ui / general_button.ui）
+ (UIColor *)danger;         // #EA3553  危险 / 次色
+ (UIColor *)accent;         // #FF9F1C  强调橙（tab_active_bar.ui）
+ (UIColor *)infoBlue;       // #55ACEE
+ (UIColor *)panel;          // #FAFAFA
+ (UIColor *)scrim;          // 全屏遮罩（半透明黑，压住游戏画面）
+ (UIColor *)textPrimary;    // #444444  dialog_template / panel / general_menu 正文色
+ (UIColor *)textSecondary;  // #515151  general_menu.ui
+ (UIColor *)textDisabled;   // #C9C9C9
+ (UIColor *)hairline;       // #DDDDDD  dialog_template.ui

#pragma mark - 配色（token 派生：游戏化皮肤用）

/// #EAEAEA（general_button.ui）—— 输入框底 / 次级面片
+ (UIColor *)surfaceMuted;
/// #2A2F35 —— 深色标题铭牌底（由 loading.ui 的 #222222 深色底 + dialog_template 的
/// #444444 正文色推得，见 README「补值依据」）
+ (UIColor *)plateDark;
/// #FFFFFF —— 深色底上的正文
+ (UIColor *)textOnDark;
/// #FFFFFF @ 0.72 —— 深色底上的次要文字
+ (UIColor *)textOnDarkSecondary;
/// #2EC4B6 @ alpha —— 主色的半透明光晕（glow6 的程序化近似）
+ (UIColor *)primaryGlow:(CGFloat)alpha;
/// #EA3553 @ alpha
+ (UIColor *)dangerGlow:(CGFloat)alpha;

#pragma mark - 几何（token: round18 / round24 / round32，glow6，shadow4 / shadow8 / shadow20）

+ (CGFloat)radiusPanel;      // 32
+ (CGFloat)radiusButton;     // 24
+ (CGFloat)radiusField;      // 18
+ (CGFloat)radiusChip;       // 12（小面片：验证码格 / 装饰）
+ (CGFloat)radiusPlate;      // 8  （铭牌：标题条）
+ (CGFloat)glowWidth;        // 6
+ (CGFloat)shadowOpacity;    // shadow20
+ (CGFloat)shadowRadius;     // 20
+ (CGFloat)shadowRadiusSoft; // 4  （shadow4：面板落在遮罩上的近距离投影）
+ (CGFloat)hairlineWidth;    // 1

#pragma mark - 字号（token: 字体 xml size24_medium / size30_bold / size32_fafafa）

+ (UIFont *)fontTitle;       // 22 semibold —— 面板标题
+ (UIFont *)fontButton;      // 19 semibold —— 按钮
+ (UIFont *)fontBody;        // 15 regular  —— 输入框 / 正文
+ (UIFont *)fontCaption;     // 13 regular  —— 倒计时 / 状态
+ (UIFont *)fontBall;        // 22 bold     —— 悬浮球的「登」

/// 统一字体：包内无 TTF/OTF（token 文档已确认），第一版用系统字体近似。
+ (UIFont *)fontOfSize:(CGFloat)size weight:(UIFontWeight)weight;
/// 6 位验证码用等宽，逐位对齐、不跳动。
+ (UIFont *)monospacedDigitFontOfSize:(CGFloat)size weight:(UIFontWeight)weight;
/// 验证码格里每一位用的字号（30 等宽 bold，对应 token 的 `size30_ffffff_bold` 档）
+ (UIFont *)codeDigitFont;

#pragma mark - 形状（程序化复刻九宫格素材）

/// 主按钮外观（青底渐变 + glow6 + shadow20 + round24）。**保留旧名与旧语义**。
+ (void)applyPrimaryButtonStyle:(UIButton *)button;
/// 次按钮外观（红底渐变 + glow6 + shadow20 + round24）。
+ (void)applySecondaryButtonStyle:(UIButton *)button;
/// 面板外观（#FAFAFA + round32 + shadow4）。
+ (void)applyPanelStyle:(UIView *)view;

/// 「回游戏」这种正向高亮按钮：橙底渐变（#FF9F1C，token `round24_glow6_shadow20`）。
+ (void)applyAccentButtonStyle:(UIButton *)button;
/// 文字链按钮（重新获取验证码）：透明底 + 主色字。
+ (void)applyLinkButtonStyle:(UIButton *)button;
/// 输入框外观：surfaceMuted 底 + round18 + hairline 描边（聚焦态由 setFieldFocused: 切换）。
+ (void)applyFieldStyle:(UITextField *)field;
/// 输入框聚焦态：背景转白 + 主色描边 + 主色光晕。只改 layer，不改任何输入行为。
+ (void)setFieldFocused:(UITextField *)field focused:(BOOL)focused;
/// 深色铭牌（标题条 / 验证码底板）：plateDark 底 + roundPlate|radiusChip + 顶部内高光。
+ (void)applyDarkPlateStyle:(UIView *)view cornerRadius:(CGFloat)radius;
/// 悬浮球外观：圆 + 主色竖向渐变 + 描边 + 光晕 + 顶部内高光。
+ (void)applyFloatingBallStyle:(UIButton *)button diameter:(CGFloat)diameter;
/// 面板底缘装饰条（`decoration-assets/bottom_decoration_part_a|b|c` 的程序化近似）。
+ (UIView *)makeBottomDecorationBarWithWidth:(CGFloat)width;

/// 把 `bottomDecoration` 的宽高比约束成固定形状（不会随面板拉伸）。
+ (void)pinAspectOfBottomDecoration:(UIView *)decorationView;

/// 给 view 挂一层竖向渐变（幂等：重复调用只更新已有那层，不会叠出第二层）。
+ (void)applyVerticalGradient:(UIView *)view
                         colors:(NSArray<UIColor *> *)colors
                     locations:(nullable NSArray<NSNumber *> *)locations;

@end

NS_ASSUME_NONNULL_END
