// SpLoginAPI.m —— `/sp-auth/*` 客户端实现（P10-B）
//
// 契约权威 = `D:\wfcnmod\分工文档-自研登录页与账号绑定.md` §3.2。要点：
//   * 统一 POST + application/json；HTTP **一律 200**，成败看 body 里的 ok 字段；
//   * 成功 {ok:true,data:{...}}；失败 {ok:false,code,message,data?}；
//   * token = 随机 32 字节 hex、15 天不活跃失效（每次 bind-status/resend/profile
//     都算活跃并把窗口顺延，服务端滑动续期，见契约 3.2 2026-10-01 修订），
//     只用于本页轮询/登出。
//
// ⚠️ 已知未决项（真机联调必须确认，见报告 §7）：游戏 `/api/index.php/tool/signup` 用的
//   `device_id` 是**客户端自己生成的**。绑定闸门（result_code 517）查的就是这个键，
//   所以本页登记的 device_id 必须与游戏请求体里的一致；做法是「嗅探优先」：
//   由 SpLoginURLProtocol 在每次出站请求体里顺带抓（+captureDeviceIdFromRequestBody:），
//   抓不到才退到本机持久化的自生成 UUID。两者不一致会导致「绑定挂在另一个设备键上」。

#import "SpLoginAPI.h"
#import "SpLoginConfig.h"

// memcmp 需要显式声明：clang 16+（Xcode 15/16）把隐式函数声明当**错误**而非警告，
// 少这一行会在 CI 上直接把 SpLoginAPI.m 的编译打断。
#import <string.h>

// dispatch_once / dispatch_once_t / dispatch_async / dispatch_get_main_queue：
// 同样显式引入，不依赖 Foundation 的传递包含。
#import <dispatch/dispatch.h>

static NSString *const SpLoginTokenKey = @"SpLoginToken";
static NSString *const SpLoginDeviceIdKey = @"SpLoginDeviceId";

@implementation SpLoginAPI

+ (instancetype)sharedAPI
{
    static SpLoginAPI *shared = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        shared = [[SpLoginAPI alloc] init];
    });
    return shared;
}

- (NSString *)token
{
    NSString *token = [[NSUserDefaults standardUserDefaults] stringForKey:SpLoginTokenKey];
    return token.length > 0 ? token : nil;
}

- (NSString *)deviceId
{
    NSString *deviceId = [[NSUserDefaults standardUserDefaults] stringForKey:SpLoginDeviceIdKey];
    if (deviceId.length > 0) {
        return deviceId;
    }
    // 首次运行：生成一个稳定 UUID 并落盘（同一台设备此后恒定，**不是**随机身份）
    deviceId = [[NSUUID UUID] UUIDString];
    [[NSUserDefaults standardUserDefaults] setObject:deviceId forKey:SpLoginDeviceIdKey];
    SPLoginLog(@"[SpLogin] generated a local device_id (no sniffed value yet)");
    return deviceId;
}

- (void)setToken:(NSString *)token
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    if (token.length > 0) {
        [defaults setObject:token forKey:SpLoginTokenKey];
    } else {
        [defaults removeObjectForKey:SpLoginTokenKey];
    }
}

#pragma mark - device_id 嗅探

/// 在出站请求体里找 `device_id` 后面的值。同时支持 JSON（`"device_id":"x"`）与
/// msgpack（fixstr `0xa0..0xbf` / str8 `0xd9` / str16 `0xda`）两种编码 —— 游戏协议主体是
/// msgpack，SDK 登录是 JSON，两种都会经过这里。抓不到就返回 nil（**不猜**）。
+ (NSString *)deviceIdInBytes:(NSData *)body
{
    static const uint8_t key[] = { 'd', 'e', 'v', 'i', 'c', 'e', '_', 'i', 'd' };
    const uint8_t *bytes = (const uint8_t *)body.bytes;
    NSUInteger length = body.length;

    for (NSUInteger i = 0; i + sizeof(key) < length; i++) {
        if (memcmp(bytes + i, key, sizeof(key)) != 0) {
            continue;
        }
        NSUInteger j = i + sizeof(key);
        while (j < length && (bytes[j] == '"' || bytes[j] == ':' || bytes[j] == ' ' || bytes[j] == '=')) {
            j++;
        }
        if (j >= length) {
            continue;
        }
        NSUInteger start = j;
        NSUInteger valueLength = 0;
        if (bytes[j] >= 0xa0 && bytes[j] <= 0xbf) {          // msgpack fixstr
            valueLength = (NSUInteger)(bytes[j] - 0xa0);
            start = j + 1;
        } else if (bytes[j] == 0xd9 && j + 1 < length) {      // msgpack str8
            valueLength = (NSUInteger)bytes[j + 1];
            start = j + 2;
        } else if (bytes[j] == 0xda && j + 2 < length) {      // msgpack str16
            valueLength = ((NSUInteger)bytes[j + 1] << 8) | (NSUInteger)bytes[j + 2];
            start = j + 3;
        } else {                                             // JSON 字符串
            NSUInteger end = j;
            while (end < length && bytes[end] != '"' && bytes[end] != ',' && bytes[end] != '}' && bytes[end] != '&') {
                end++;
            }
            valueLength = end - j;
            start = j;
        }
        if (valueLength == 0 || valueLength > 128 || start + valueLength > length) {
            continue;
        }
        NSString *value = [[NSString alloc] initWithBytes:bytes + start
                                                   length:valueLength
                                                 encoding:NSUTF8StringEncoding];
        if (value.length == 0 || ![value canBeConvertedToEncoding:NSASCIIStringEncoding]) {
            continue;                                        // 设备号是 ASCII（UUID/hex/数字）
        }
        return value;
    }
    return nil;
}

+ (BOOL)captureDeviceIdFromRequestBody:(NSData *)body
{
    if (body.length < 12 || body.length > 4 * 1024 * 1024) {
        return NO;
    }
    NSString *found = [self deviceIdInBytes:body];
    if (found.length == 0) {
        return NO;
    }
    NSString *current = [[NSUserDefaults standardUserDefaults] stringForKey:SpLoginDeviceIdKey];
    if ([current isEqualToString:found]) {
        return NO;
    }
    [[NSUserDefaults standardUserDefaults] setObject:found forKey:SpLoginDeviceIdKey];
    SPLoginLog(@"[SpLogin] captured device_id from an outgoing request body (len=%lu)", (unsigned long)found.length);
    return YES;
}

#pragma mark - HTTP

- (void)postPath:(NSString *)path
         payload:(NSDictionary *)payload
      completion:(SpLoginResultBlock)completion
{
    NSString *base = [SpLoginConfig sharedConfig].apiBaseURLString;
    NSURL *url = [NSURL URLWithString:[base stringByAppendingString:path]];
    if (url == nil) {
        SPLoginLog(@"[SpLogin] bad api base url: %@", base);
        [self finish:completion ok:NO data:nil code:@"CLIENT_BAD_URL" message:@"服务地址无效"];
        return;
    }

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = 15.0;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:NULL];

    SPLoginLog(@"[SpLogin] POST %@", path);
    __weak typeof(self) weakSelf = self;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            __strong typeof(self) strongSelf = weakSelf;
            if (strongSelf == nil) {
                return;
            }
            if (error != nil) {
                SPLoginLog(@"[SpLogin] %@ failed: %@", path, error.localizedDescription);
                [strongSelf finish:completion ok:NO data:nil code:@"NETWORK" message:error.localizedDescription];
                return;
            }
            NSDictionary *json = nil;
            if (data.length > 0) {
                id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                if ([parsed isKindOfClass:[NSDictionary class]]) {
                    json = (NSDictionary *)parsed;
                }
            }
            if (json == nil) {
                NSInteger status = [(NSHTTPURLResponse *)response statusCode];
                SPLoginLog(@"[SpLogin] %@ returned a non-JSON body (http=%ld)", path, (long)status);
                [strongSelf finish:completion ok:NO data:nil code:@"BAD_RESPONSE" message:@"服务端响应无法解析"];
                return;
            }
            BOOL ok = [json[@"ok"] boolValue];
            NSDictionary *dataSection = [json[@"data"] isKindOfClass:[NSDictionary class]] ? json[@"data"] : nil;
            NSString *code = [json[@"code"] isKindOfClass:[NSString class]] ? json[@"code"] : nil;
            NSString *message = [json[@"message"] isKindOfClass:[NSString class]] ? json[@"message"] : nil;
            if (ok) {
                NSString *token = [dataSection[@"token"] isKindOfClass:[NSString class]] ? dataSection[@"token"] : nil;
                if (token.length > 0) {
                    [strongSelf setToken:token];
                }
            }
            SPLoginLog(@"[SpLogin] %@ -> ok=%d code=%@", path, ok ? 1 : 0, code ?: @"-");
            [strongSelf finish:completion ok:ok data:dataSection code:code message:message];
        }];
    [task resume];
}

- (void)finish:(SpLoginResultBlock)completion
            ok:(BOOL)ok
          data:(NSDictionary *)data
          code:(NSString *)code
       message:(NSString *)message
{
    if (completion == nil) {
        return;
    }
    if ([NSThread isMainThread]) {
        completion(ok, data, code, message);
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(ok, data, code, message);
        });
    }
}

#pragma mark - 契约端点

- (NSDictionary *)basePayload
{
    NSMutableDictionary *payload = [NSMutableDictionary dictionary];
    NSString *deviceId = self.deviceId;
    if (deviceId.length > 0) {
        payload[@"device_id"] = deviceId;
    }
    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    payload[@"version"] = version.length > 0 ? version : @"unknown";
    return payload;
}

- (void)registerWithUsername:(NSString *)username
                    password:(NSString *)password
                  completion:(SpLoginResultBlock)completion
{
    NSMutableDictionary *payload = [[self basePayload] mutableCopy];
    payload[@"username"] = username ?: @"";
    payload[@"password"] = password ?: @"";
    [self postPath:@"/sp-auth/register" payload:payload completion:completion];
}

- (void)loginWithLoginName:(NSString *)loginName
                  password:(NSString *)password
                completion:(SpLoginResultBlock)completion
{
    NSMutableDictionary *payload = [[self basePayload] mutableCopy];
    payload[@"login_name"] = loginName ?: @"";
    payload[@"password"] = password ?: @"";
    [self postPath:@"/sp-auth/login" payload:payload completion:completion];
}

- (void)fetchBindStatusWithCompletion:(SpLoginResultBlock)completion
{
    NSString *token = self.token;
    if (token.length == 0) {
        [self finish:completion ok:NO data:nil code:@"NO_SESSION" message:@"本地还没有会话，请先创建账号"];
        return;
    }
    [self postPath:@"/sp-auth/bind-status" payload:@{ @"token": token } completion:completion];
}

- (void)resendCodeWithCompletion:(SpLoginResultBlock)completion
{
    NSString *token = self.token;
    if (token.length == 0) {
        [self finish:completion ok:NO data:nil code:@"NO_SESSION" message:@"本地还没有会话，请先创建账号"];
        return;
    }
    [self postPath:@"/sp-auth/resend" payload:@{ @"token": token } completion:completion];
}

- (void)logout
{
    NSString *token = self.token;
    [self setToken:nil];
    if (token.length == 0) {
        return;
    }
    [self postPath:@"/sp-auth/logout" payload:@{ @"token": token } completion:nil];
}

@end
