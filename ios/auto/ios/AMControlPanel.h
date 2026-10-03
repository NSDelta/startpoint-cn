//
//  AMControlPanel.h —— 悬浮控制面板
//
//  一个独立的 UIWindow（windowLevel = Alert + 1）：
//    · 收起时是右下角的悬浮球，可拖动，位置持久化
//    · 展开时是控制板：状态 / 脚本列表 / 开始停止 / 跟着游戏玩的开关 / 日志
//
//  ── 面板不会污染匹配，这是设计出来的，不是碰巧 ──────────────────────────────
//  取帧走的是 hook -[EAGLContext presentRenderbuffer:] + glReadPixels，
//  读的是 **GL 的默认 framebuffer**。UIKit 的窗口（包括本面板）在合成阶段
//  另外叠加，从来不在那个 framebuffer 里。所以面板可以一直显示、不需要
//  "截图前隐藏"这一步。
//  这条结论只对 GL 主路成立：兜底的 drawViewHierarchyInRect: 会**拍到面板**。
//  所以 AMCapture 的兜底后端一旦生效，面板必须自动隐藏 —— 见 -updateVisibility。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface AMControlPanel : NSObject

+ (instancetype)shared;

/// 装上面板。幂等。会读 AMConfig 决定初始是否可见。
- (void)install;

/// 显示 / 隐藏（写进 AMConfig 持久化）。
@property (nonatomic, readwrite) BOOL visible;

/// 卸载（移除窗口与所有视图）。幂等。
- (void)shutdown;

@end

NS_ASSUME_NONNULL_END
