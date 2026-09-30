// SpLoginConfig.h —— 运行时配置 + 日志（P10-B）
//
// 地址来源优先级：plist 覆写（默认关） > 编译期常量 SP_LOGIN_HOST。
// 编译期常量由 Makefile 通过 -DSP_LOGIN_HOST=@"host:port" 注入；仓库里的缺省值只是
// hygiene 白名单占位 192.168.1.10:8001，绝不是任何真实机器。

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginConfig : NSObject

+ (instancetype)sharedConfig;

/// "host:port"（不含 scheme）
@property (nonatomic, copy, readonly) NSString *hostPort;
/// "http://host:port"
@property (nonatomic, copy, readonly) NSString *apiBaseURLString;
/// 是否接管官方 SDK 登录界面（plist: SPLoginUITakeover，默认 YES）
@property (nonatomic, readonly) BOOL uiTakeover;
/// 是否跳过官方隐私弹窗（plist: SPLoginSkipPrivacyDialogs，默认 NO）
@property (nonatomic, readonly) BOOL skipPrivacyDialogs;
/// 启动后是否主动弹出登录面板（plist: SPLoginAutoPresent，默认 NO）。
/// 默认关：正常流程是被官方 SDK 的登录/欢迎界面触发；打开只用于真机单点验证面板本身。
@property (nonatomic, readonly) BOOL autoPresent;
/// 主动弹出的延迟秒数（plist: SPLoginAutoPresentDelay，默认 2.0）
@property (nonatomic, readonly) NSTimeInterval autoPresentDelay;
/// 是否显示常驻悬浮球（plist: SPLoginFloatingButton，**默认 YES = 修复后的行为**）。
/// 悬浮球是「不依赖任何官方 UI 钩子也能打开面板」的入口；关掉只收起这个入口，
/// 官方登录界面出现时的自动弹面板与 autoPresent 都不受影响。
@property (nonatomic, readonly) BOOL floatingButton;
/// **游戏化皮肤开关（plist: SPLoginSkinEnabled，默认 YES）**。
/// 这是纯外观开关：关掉只是把面板/悬浮球退回「素色通用表单」的样子，
/// 与网络改写、验证码、轮询、绑定状态等业务行为**没有任何关系**。
/// 加这个键是为了真机上万一皮肤在小屏/横屏下不好看，能不改代码先退回旧观感。
@property (nonatomic, readonly) BOOL skinEnabled;
/// 实际生效的 plist 来源路径（沙盒 Documents / app 包内 / dylib 同目录）；一个都没读到就是 nil。
/// 只为取证：日志与 `SpLogin-1-install` 标记里都写它，方便一眼看出「覆写到底有没有被读到」。
@property (nonatomic, copy, readonly, nullable) NSString *preferenceSourcePath;

@end

NS_ASSUME_NONNULL_END

// SPLoginLog 是 C 函数，必须用 extern "C" 声明。
// Theos 把 .xm 先预处理成 **.mm（Objective-C++）** 再用 clang++ 编，.m 也按 C++ 编。
// 没有这个包裹时定义处（SpLoginConfig.m）按 C++ 规则改名，而 Tweak.xm 侧按 C 链接名
// 引用，于是链接期报（run 36420791202 的 ld 原文）：
//   ld: symbol(s) not found for architecture arm64
//   NOTE: found '_SPLoginLog' in SpLoginConfig.m.*.o, declaration possibly missing 'extern "C"'
//
// 注意 format 必须**显式**写 _Nonnull：本块在 NS_ASSUME_NONNULL_END 之后，区域外
// 缺 nullability 的指针参数在 -Werror,-Wnullability-completeness 下是硬错误
// （run 36421222764 的 C 侧编译错误就是这么来的）。显式标注与 pragma 区域解耦，
// 将来这块挪到哪儿都不会复发。
#ifdef __cplusplus
extern "C" {
#endif

/// 统一日志：NSLog + 可选落盘（真机没有 Mac 时靠日志文件取证）
void SPLoginLog(NSString * _Nonnull format, ...) NS_FORMAT_FUNCTION(1, 2);

/// 取证标记：往 **app 沙盒 Documents** 写一个 `<name>.txt`，内容 = 时间 + 进程信息 + detail。
///
/// 为什么必须是 Documents（照抄 wfcore `dylib/src/main.m:22-25` 往 Documents 写
/// `WFCore-ctor.txt` 的做法）：本包的使用方式是「**非越狱设备上自己签名、自己把 dylib
/// 注入进 IPA**」，那种环境下根本没有任何越狱目录可写，`NSTemporaryDirectory()`
/// 用户也进不去 —— 结果就是「装没装上、卡在哪一步」完全不可判，只能凭猜。
/// Documents 是沙盒里唯一用「文件」App / Filza / iMazing 都能直接看到的地方，
/// 所以「dylib 到底加载没有」这件事必须落在那里。
///
/// append=YES：追加，攒成一条时间线（构造/安装/面板等一次性事件用）。
/// append=NO ：覆盖，只留最新状态（挂载尝试这种高频事件用，避免无限增长）。
void SPLoginMarker(NSString * _Nonnull name, NSString * _Nullable detail, BOOL append);

#ifdef __cplusplus
}
#endif
