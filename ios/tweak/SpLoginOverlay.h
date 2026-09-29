// SpLoginOverlay.h —— 独立覆盖窗口（悬浮球 + 登录面板容器）
//
// 为什么要有这个类（真机反馈 2026-09-29：「装好 deb 后没有 dylib 的窗口」）：
//   旧实现把面板 `presentViewController:` 弹进**游戏自己的视图层级**，于是显示与否取决于
//   ①官方 UI 钩子命不命中、②keyWindow 上有没有能 present 的 VC。两条都不满足就永远不显示；
//   就算显示了，AIR 重建视图层级时也会把它带走或盖住。
//   本类改用**独立 UIWindow**（windowLevel = UIWindowLevelStatusBar + 100）：不参与游戏层级，
//   游戏怎么重建都影响不到它；显示手段只有 `hidden = NO`（**绝不 makeKeyAndVisible**，
//   AIR 对 key 变化敏感），只有文本输入需要键盘时才临时抢一次 key，编辑结束立刻还给宿主。
//
// 机制的完整说明、日志判读与真机排查见 ios/tweak/README.md 第 5 节。

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginOverlay : NSObject

+ (instancetype)sharedOverlay;

/// 装机：1.5s 首挂 + `UIWindowDidBecomeKeyNotification` 观察者 + 5s 看门狗，三条都调同一个
/// 幂等的挂载例程。可安全重复调用（重复调用只记一行日志）。
- (void)install;

/// 打开登录面板（幂等：已打开时只记日志）。内部会先尝试挂载一次；
/// 宿主窗口还没就绪时挂起（记为 pending），挂上后自动打开。返回 YES 表示此刻面板已可见。
- (BOOL)showPanel;

/// 关掉面板：把面板 VC 的 view 藏起来（`hidden = YES`）并收起键盘 —— 触摸随即穿透回游戏。
/// 面板实例与它的轮询/倒计时状态保留，再点悬浮球即恢复原样。
- (void)hidePanel;

/// 悬浮球点击动作：已打开则关，未打开则开。
- (void)togglePanel;

/// 面板当前是否可见（= 面板 view 已建且未隐藏）。
@property (nonatomic, readonly, getter=isPanelVisible) BOOL panelVisible;
/// 悬浮球当前是否已挂到覆盖窗口上（真机取证：这一条能证明「窗口到底建没建、挂没挂上」）。
@property (nonatomic, readonly, getter=isFloatingButtonVisible) BOOL floatingButtonVisible;

@end

NS_ASSUME_NONNULL_END
