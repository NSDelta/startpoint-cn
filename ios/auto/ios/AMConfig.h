//
//  AMConfig.h —— 面板状态与运行偏好的持久化
//
//  为什么不用 NSUserDefaults：注入 dylib 的进程（游戏）里，standardUserDefaults
//  的 domain 是游戏的 bundle id。我们写进去的键会混在游戏的偏好里，
//  卸载插件后残留、也可能被游戏的偏好同步搅乱。单独一个 plist 文件最干净：
//
//      Library/Application Support/AutoClick/panel.plist
//
//  另外给一个**构建期/部署期**的只在读配置：main bundle 里的
//  AutoClick.plist。部署者往里面写 { "autoStart": true, "script": "幻想连战.auto" }
//  就能做到"启动即跑，不弹面板"——非越狱侧唯一现实的自动化方式。
//

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

@interface AMConfig : NSObject

+ (instancetype)shared;

#pragma mark - 只读配置（main bundle 里的 AutoClick.plist）

/// bundle 配置里的一个键（没有则 nil）。只读，部署者写死的。
- (nullable id)bundleValueForKey:(NSString *)key;

/// 启动时是否直接开跑（bundle 配置 autoStart）。
@property (nonatomic, readonly) BOOL autoStart;

/// bundle 配置里指定的脚本文件名；没有则 nil。会在 discoverScripts 的结果里按
/// 文件名匹配（找不到就退回第一个）。
@property (nonatomic, readonly, nullable) NSString *preferredScriptName;

/// 启动时是否显示面板。缺省 YES（越狱侧要能看到它才好操作）。
@property (nonatomic, readonly) BOOL panelVisibleAtLaunch;

#pragma mark - 可写状态（Library/.../panel.plist）

/// 面板是否可见。
@property (nonatomic, readwrite) BOOL panelVisible;

/// 悬浮球位置（屏幕坐标，**点**）。
@property (nonatomic, readwrite) CGPoint ballCenter;

/// 最近一次运行的脚本路径。
@property (nonatomic, readwrite, copy, nullable) NSString *lastScriptPath;

/// 用户是否把触摸注入关掉了（"让游戏能正常玩"开关）。缺省 YES = 允许注入。
@property (nonatomic, readwrite) BOOL touchEnabled;

/// 立刻写盘（正常路径下 setter 内部已经节流保存，这个方法给"退出前"用）。
- (void)flush;

@end

NS_ASSUME_NONNULL_END
