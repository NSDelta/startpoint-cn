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
// CALayer（field.layer.cornerRadius / .borderWidth / .borderColor）需要显式引入。
#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginViewController : UIViewController

/// 打开登录面板（幂等：已经打开时不再叠一层）。
///
/// 悬浮窗修复：显示**不再走 `presentViewController:`**（那条路要弹进游戏自己的视图层级，
/// 真机反馈就是「一个窗口都没有」），而是转交给 SpLoginOverlay 的独立覆盖窗口 ——
/// 本 VC 的 view 作为覆盖窗口 root 的子视图；宿主窗口还没就绪时自动挂起、就绪后补开。
/// 由 Tweak.xm 在 SDK 想弹它自己的登录/欢迎界面时调用；返回 YES 表示此刻面板已可见。
+ (BOOL)presentOnKeyWindow;

/// 关掉面板（回到游戏）。绑定成功后由「回到游戏」按钮调用，也是「点面板外空白」的动作。
/// 只把面板藏起来（连同触摸一起让开），面板实例与轮询/倒计时状态保留，再点悬浮球即恢复。
+ (void)dismissIfPresented;

/// 键盘避让：keyboardTopY = 键盘顶边的窗口 Y 坐标（传 0 表示键盘收起、复位）。
/// 由 SpLoginOverlay 在键盘 frame 变化时调用；只对面板卡片做平移，不碰业务状态。
- (void)adjustForKeyboardTop:(CGFloat)keyboardTopY;

/// 「本地已有验证码/令牌 ⇒ 接着轮询绑定状态」这条续跑的**显式入口**。
///
/// 为什么需要它：覆盖窗口版是用 `addChildViewController:` 把本 VC 容器化的，**刻意不做
/// appearance 过渡**（`beginAppearanceTransition:`/`endAppearanceTransition:`）——一旦做了，
/// 隐藏面板时会连带触发 `viewDidDisappear:` → `stopTimers`，而「面板隐藏期间轮询/倒计时继续跑」
/// 是覆盖窗口版的**有意取舍**。代价是 `viewDidAppear:` 在覆盖窗口这条路径上**永远不触发**，
/// 于是它里面那段「本地有令牌就续轮询」在冷启动时不会跑（用户必须手点一次主按钮）。
/// 所以把那段逻辑抽成本方法，由 SpLoginOverlay 在把面板挂进容器时显式调一次。
///
/// 语义与旧 `viewDidAppear:` 那段**完全一致**（同一段代码），差别只是多一层幂等：
///   · 本地没有令牌（`SpLoginAPI.sharedAPI.token.length == 0`）⇒ 什么都不做，不发请求、不弹面板；
///   · 已经有轮询在跑（`pollTimer` 有效）⇒ 直接跳过，重复挂载/看门狗重挂不会叠加定时器。
- (void)sp_resumeFromStoredTokenIfNeeded;

@end

NS_ASSUME_NONNULL_END
