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
@property (nonatomic, readonly) NSString *hostPort;
/// "http://host:port"
@property (nonatomic, readonly) NSString *apiBaseURLString;
/// 是否接管官方 SDK 登录界面（plist: SPLoginUITakeover，默认 YES）
@property (nonatomic, readonly) BOOL uiTakeover;
/// 是否跳过官方隐私弹窗（plist: SPLoginSkipPrivacyDialogs，默认 NO）
@property (nonatomic, readonly) BOOL skipPrivacyDialogs;
/// 越狱根：rootless = "/var/jb"，传统 = ""
@property (nonatomic, readonly) NSString *jailbreakRoot;

@end

/// 统一日志：NSLog + 可选落盘（真机没有 Mac 时靠日志文件取证）
void SPLoginLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

NS_ASSUME_NONNULL_END
