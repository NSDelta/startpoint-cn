// SpLoginURLProtocol.h —— 把 SDK 打向官方域名的请求改写到自建服务（P10-B）
//
// 为什么需要它：iOS 官方 1.8.4 的主二进制里嵌着 `https://<x>.leiting.com<path>` 之类的
// URL 常量（P10-A 的 `client-patch/build/patch-ipa.mjs:41` 用
// `/https?:\/\/[A-Za-z0-9.-]+\.(?:leiting\.com|roguelike\.com|cl2009\.com)(?::\d+)?/` 匹配它们）。
// P10-A 那条线是在 IPA 里原地改字节；本 tweak 线走运行时改写，好处是**官方 IPA 一字节不改**。
//
// 拦截面（只认官方 SDK 域名后缀，其余流量一律放行）：
//   leiting.com / roguelike.com / cl2009.com  →  http://<SPLoginHost>/<path>?<query>
// scheme 改成 http：官方 Info.plist 里 `NSAppTransportSecurity/NSAllowsArbitraryLoads = true`
// （已取证：`apkipa/iOS-1.8.4.ipa!Payload/worldflipper.app/Info.plist:127-131`），所以明文 HTTP
// 不会被 ATS 拦掉。
//
// 副作用（有意为之）：顺带把出站请求体喂给 `+[SpLoginAPI captureDeviceIdFromRequestBody:]`，
// 用来对齐游戏自己的 device_id（绑定闸门查的就是这个键）。

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SpLoginURLProtocol : NSURLProtocol

/// 幂等注册（多次调用安全）；tweak 构造器里调一次即可。
+ (void)installIfNeeded;

/// 供日志/报告用：当前生效的改写前缀（形如 `http://<host:port>`）。未配置时返回 nil。
+ (nullable NSString *)rewritePrefix;

@end

NS_ASSUME_NONNULL_END
