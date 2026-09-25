// SpLoginViewController.h —— 类游戏登录面板（P10-B）
//
// 视觉规格与 `ios/prototype/index.html` 一致，参数全部来自 SpLoginTheme（= 官方 token）。
// 状态机（与原型同一套）：
//   waitingCode  等待服务端下发验证码（还没创建/登录）
//   codeShown    已拿到 6 位码，等待玩家把它发给 bot（倒计时中）
//   binding      已提交，轮询 /sp-auth/bind-status 等人工确认
//   error        失败，可重试（错误码 → 中文话术走 C7）
//   success      已绑定成功：回到游戏点「点击开始」

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginViewController : UIViewController

/// 在主窗口最上层弹出登录面板（幂等：已经显示时不再叠一层）。
/// 由 Tweak.xm 在 SDK 想弹它自己的登录/欢迎界面时调用。
+ (BOOL)presentOnKeyWindow;

/// 关掉面板（回到游戏）。绑定成功后由「回到游戏」按钮调用。
+ (void)dismissIfPresented;

@end

NS_ASSUME_NONNULL_END
