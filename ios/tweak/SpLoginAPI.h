// SpLoginAPI.h —— `/sp-auth/*` 客户端（P10-B）
//
// 契约权威 = 分工文档 §3.2「客户端 ↔ 服务端（自研命名空间 /sp-auth/*）」：
//   POST + application/json，HTTP 一律 200；
//   成功 {ok:true,data:{...}}；失败 {ok:false,code,message,data?}
//
// 本文件只实现 UI 真正用到的四个：register / login / bind-status / resend /
// logout。响应字段名严格照契约，不自创第二个命名空间。

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// ok=YES 时 data 为契约里的 data 段；ok=NO 时 code/message 为契约里的错误码与话术。
typedef void (^SpLoginResultBlock)(BOOL ok, NSDictionary *_Nullable data, NSString *_Nullable code, NSString *_Nullable message);

@interface SpLoginAPI : NSObject

+ (instancetype)sharedAPI;

/// 当前会话 token（15 天不活跃失效、活跃即滑动顺延，只用于本页轮询/登出；持久化在 NSUserDefaults）
@property (nonatomic, copy, readonly, nullable) NSString *token;
/// 游戏自己的设备号（= 游戏 /api/index.php/tool/signup 请求体里的 device_id）
@property (nonatomic, copy, readonly, nullable) NSString *deviceId;

/// 由网络嗅探在每次请求体里顺带调用：抓到 device_id 就记住（含持久化）。
/// @return 是否是"本次新抓到"（用于日志去重）
+ (BOOL)captureDeviceIdFromRequestBody:(nullable NSData *)body;

/// POST /sp-auth/register  {username,password,device_id,version}
///   → data:{token, code, code_expires_at, viewer_id, username}
- (void)registerWithUsername:(NSString *)username
                    password:(NSString *)password
                  completion:(SpLoginResultBlock)completion;

/// POST /sp-auth/login  {login_name,password,device_id}
///   → data:{token, viewer_id, username, bound:true}；失败可能是 BIND_REQUIRED(+data:{code,code_expires_at})
- (void)loginWithLoginName:(NSString *)loginName
                  password:(NSString *)password
                completion:(SpLoginResultBlock)completion;

/// POST /sp-auth/bind-status  {token}  → data:{bound, code, code_expires_at, viewer_id?}
- (void)fetchBindStatusWithCompletion:(SpLoginResultBlock)completion;

/// POST /sp-auth/resend  {token}  → data:{code, code_expires_at}
- (void)resendCodeWithCompletion:(SpLoginResultBlock)completion;

/// POST /sp-auth/logout  {token}（尽力而为，失败也不阻塞 UI）
- (void)logout;

@end

NS_ASSUME_NONNULL_END
