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
/// 越狱根：rootless = "/var/jb"，传统 = ""
@property (nonatomic, copy, readonly) NSString *jailbreakRoot;

@end

NS_ASSUME_NONNULL_END

// SPLoginLog 是 C 函数，必须用 extern "C" 声明。
// Theos 把 .xm/.m 当 **C++** 编译（clang++），没有这个包裹时定义处（SpLoginConfig.m）
// 会按 C++ 规则改名，而 Tweak.xm 侧按 C 链接名引用，于是链接期报：
//   ld: symbol(s) not found for architecture arm64
//   NOTE: found '_SPLoginLog' in SpLoginConfig.m.*.o, declaration possibly missing 'extern "C"'
#ifdef __cplusplus
extern "C" {
#endif

/// 统一日志：NSLog + 可选落盘（真机没有 Mac 时靠日志文件取证）
void SPLoginLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

#ifdef __cplusplus
}
#endif
