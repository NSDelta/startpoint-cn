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

#import <UIKit/UIKit.h>
// UIView.layer 的类型 CALayer 由 QuartzCore 引入。UIKit 不再保证传递引入它，
// 缺了它 button.layer.cornerRadius 等成员访问在 CI 上是硬错误。
#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginTheme : NSObject

// 配色（token: #2EC4B6 / #EA3553 / #FF9F1C / #55ACEE / #FAFAFA / #222222 ...）
+ (UIColor *)primary;        // #2EC4B6  主色（take_over.ui / general_button.ui）
+ (UIColor *)danger;         // #EA3553  危险 / 次色
+ (UIColor *)accent;         // #FF9F1C  强调橙（tab_active_bar.ui）
+ (UIColor *)infoBlue;       // #55ACEE
+ (UIColor *)panel;          // #FAFAFA
+ (UIColor *)scrim;          // 全屏遮罩（半透明黑，压住游戏画面）
+ (UIColor *)textPrimary;    // #414141  take_over 正文色
+ (UIColor *)textSecondary;  // #515151
+ (UIColor *)textDisabled;   // #C9C9C9
+ (UIColor *)hairline;       // #DDDDDD

// 几何（token: round18 / round24 / round32，glow6，shadow4 / shadow8 / shadow20）
+ (CGFloat)radiusPanel;      // 32
+ (CGFloat)radiusButton;     // 24
+ (CGFloat)radiusField;      // 18
+ (CGFloat)glowWidth;        // 6
+ (CGFloat)shadowOpacity;    // shadow20
+ (CGFloat)shadowRadius;     // 20

/// 统一字体：包内无 TTF/OTF（token 文档已确认），第一版用系统字体近似。
+ (UIFont *)fontOfSize:(CGFloat)size weight:(UIFontWeight)weight;
/// 6 位验证码用等宽，逐位对齐、不跳动。
+ (UIFont *)monospacedDigitFontOfSize:(CGFloat)size weight:(UIFontWeight)weight;

/// 主按钮外观（青底 + glow6 + shadow20 + round24）
+ (void)applyPrimaryButtonStyle:(UIButton *)button;
/// 次按钮外观（红底）
+ (void)applySecondaryButtonStyle:(UIButton *)button;
/// 面板外观（#FAFAFA + round32 + shadow8）
+ (void)applyPanelStyle:(UIView *)view;

@end

NS_ASSUME_NONNULL_END
