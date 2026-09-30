// SpLoginURLProtocol.m —— 见头文件注释（P10-B）

#import "SpLoginURLProtocol.h"
#import "SpLoginAPI.h"
#import "SpLoginConfig.h"

// dispatch_once / dispatch_once_t：显式引入，不依赖 Foundation 的传递包含。
#import <dispatch/dispatch.h>

static NSString *const SpLoginHandledKey = @"SpLoginHandledByURLProtocol";

/// 官方 SDK 域名后缀（唯一依据 = P10-A 的 patch-ipa.mjs:41 正则）。
static NSArray<NSString *> *SpLoginOfficialSuffixes(void)
{
    return @[ @"leiting.com", @"roguelike.com", @"cl2009.com" ];
}

/// 不跟随重定向：改写后的目标是自建服务，任何 3xx 都意味着配置错了，
/// 跟随它只会把请求打到真实官方域名上去（绝不允许）。
@interface SpLoginURLProtocolRedirectBlocker : NSObject <NSURLSessionTaskDelegate>
@end

@implementation SpLoginURLProtocolRedirectBlocker

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler
{
    SPLoginLog(@"[SpLogin] refusing a redirect (%ld) — 改写目标不该有 3xx", (long)response.statusCode);
    completionHandler(nil);
}

@end

@interface SpLoginURLProtocol ()
@property (nonatomic, strong, nullable) NSURLSessionDataTask *task;
@property (nonatomic, strong) SpLoginURLProtocolRedirectBlocker *redirectBlocker;
@end

@implementation SpLoginURLProtocol

+ (void)installIfNeeded
{
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [NSURLProtocol registerClass:self];
        SPLoginLog(@"[SpLogin] NSURLProtocol registered (rewrite prefix: %@)", [self rewritePrefix] ?: @"(none)");
    });
}

+ (NSString *)rewritePrefix
{
    NSString *hostPort = [SpLoginConfig sharedConfig].hostPort;
    if (hostPort.length == 0) {
        return nil;
    }
    return [@"http://" stringByAppendingString:hostPort];
}

+ (BOOL)isOfficialSdkHost:(NSString *)host
{
    NSString *lower = host.lowercaseString;
    if (lower.length == 0) {
        return NO;
    }
    for (NSString *suffix in SpLoginOfficialSuffixes()) {
        if ([lower isEqualToString:suffix] || [lower hasSuffix:[@"." stringByAppendingString:suffix]]) {
            return YES;
        }
    }
    return NO;
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request
{
    if ([NSURLProtocol propertyForKey:SpLoginHandledKey inRequest:request] != nil) {
        return NO;                                            // 已经是改写后的请求，别再进来
    }
    if ([self rewritePrefix] == nil) {
        return NO;                                            // 没配地址 ⇒ 完全不介入
    }
    NSString *host = request.URL.host;
    if (![self isOfficialSdkHost:host]) {
        return NO;
    }
    NSString *scheme = request.URL.scheme.lowercaseString;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request
{
    return request;
}

/// 原始 request-target（`absoluteString` 去掉 `scheme://authority` 之后的那一段：
/// path + `?query` + `#fragment`，**原样**，未做任何解码/重编码）。
/// authority（host[:port]）里的合法字符是字母数字、`-._~%!$&'()*+,;=:` 与 IPv6 的 `[` `]`，
/// 都不含 `/` `?` `#`；所以 authority 之后第一个 `/` `?` `#` 就是 request-target 的起点。
/// 切不出来时返回 `@""`（等价于「origin 之后什么都没有」）。
+ (NSString *)requestTargetForURL:(NSURL *)url
{
    if (url == nil) {
        return @"";
    }
    NSString *absolute = url.absoluteString;
    NSRange schemeMark = [absolute rangeOfString:@"://"];
    if (schemeMark.location == NSNotFound) {
        return @"";
    }
    NSUInteger authorityStart = NSMaxRange(schemeMark);
    NSRange scan = NSMakeRange(authorityStart, absolute.length - authorityStart);
    NSRange pathMark = [absolute rangeOfString:@"/" options:0 range:scan];
    NSRange queryMark = [absolute rangeOfString:@"?" options:0 range:scan];
    NSRange fragmentMark = [absolute rangeOfString:@"#" options:0 range:scan];
    NSUInteger hinge = absolute.length;
    if (pathMark.location != NSNotFound && pathMark.location < hinge) {
        hinge = pathMark.location;
    }
    if (queryMark.location != NSNotFound && queryMark.location < hinge) {
        hinge = queryMark.location;
    }
    if (fragmentMark.location != NSNotFound && fragmentMark.location < hinge) {
        hinge = fragmentMark.location;
    }
    if (hinge <= authorityStart || hinge >= absolute.length) {
        return @"";                 // authority 之后什么都没有（例：`https://api.leiting.com`）
    }
    return [absolute substringFromIndex:hinge];
}

/// 改写后的 URL：`http://<host:port>` + **原始 request-target**。
///
/// 为什么必须切 `absoluteString` 而不是拼 `url.path` / `url.query`：后两者（以及
/// `url.fragment`、`url.absolutePath`）是**已百分号解码**的取值。拿它们重新拼 URL 等于
/// 把查询串重新编码一遍 —— `%26` 会变成 `&`（凭空多出一个参数）、`%3D` 变成 `=`
/// （参数值里凭空多出一个键值对）、`+` 与空格的往返不再稳定、非 ASCII 会被按新的规则
/// 重新编码，而签名类参数（`sign=`）对字节敏感 ⇒ 服务端验签必失败；`url.fragment` 还会被
/// 直接丢掉。参考实现 wfcore `net.m:133` 同样是**保留原文**。
///
/// 本实现逐字符等于「`absoluteString` 切掉 `scheme://authority`」的结果，不做任何
/// 解码/重编码，因此签名字节不变。
+ (nullable NSURL *)rewrittenURLForRequest:(NSURLRequest *)request
{
    NSURL *url = request.URL;
    NSString *prefix = [self rewritePrefix];
    if (prefix == nil) {
        return nil;                 // 没配地址：完全不介入（语义未变）
    }
    NSString *target = [self requestTargetForURL:url];
    NSString *rewritten = [prefix stringByAppendingString:target];
    if (target.length == 0) {
        // prefix 由 +rewritePrefix 构造成完整 URL（`http://host:port`，没有尾斜杠），
        // 所以「authority 之后什么都没有」时这里就是 `http://host:port`（不多一个 `/`）。
        return [NSURL URLWithString:rewritten];
    }
    NSURL *result = [NSURL URLWithString:rewritten];
    if (result == nil) {
        // 正常路径走不到：target 是 NSURL 自己从 `absoluteString` 里切出来的合法 request-target。
        // 这里**不做**「percentEncoded* 兜底」——`percentEncodedPath` / `percentEncodedQuery` /
        // `percentEncodedFragment` 是 **NSURLComponents** 的属性，**NSURL 上没有**（CI 实测：
        // `error: property 'percentEncodedPath' not found on object of type 'NSURL *'`）。
        // 也不退回 `url.path` / `url.query`（已百分号解码，会破坏 `%26`/`%3D`/`+`/空格/非 ASCII，
        // 把签名字节改掉）。宁可当坏 URL 报错（NSURLErrorBadURL），也不发一个签名被改坏的请求。
        return nil;
    }
    // 防御性校验：改写后的 authority 必须还落在我们自己的 host:port 上，且 request-target
    // 一段不丢（防止目标被拼成 `/`、或 `@`/`#` 之类字符把解析引到别的 host 上去）。
    NSString *origin = [prefix substringFromIndex:@"http://".length];
    if (![result.absoluteString hasPrefix:prefix]
        || ![result.host isEqualToString:url.host]
        || [[self class] requestTargetForURL:result].length != target.length) {
        SPLoginLog(@"[SpLogin] 拒绝改写：目标未落在 %@ 上（target=%@）", origin, rewritten);
        return nil;
    }
    return result;
}

- (void)startLoading
{
    NSURLRequest *request = self.request;
    NSURL *target = [[self class] rewrittenURLForRequest:request];
    if (target == nil) {
        [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain
                                                                          code:NSURLErrorBadURL
                                                                      userInfo:nil]];
        return;
    }

    // 顺带嗅探 device_id（游戏侧请求体经过这里；命中一次就够）
    [SpLoginAPI captureDeviceIdFromRequestBody:request.HTTPBody];

    // 日志里的 request-target 与改写用同一份原文（含 `?query` / `#fragment`），
    // 否则真机上只看到 path、看不到查询串，排查签名问题时会被误导。
    SPLoginLog(@"[SpLogin] rewrite %@://%@%@ -> %@",
               request.URL.scheme, request.URL.host,
               [[self class] requestTargetForURL:request.URL], target.absoluteString);

    NSMutableURLRequest *rewritten = [request mutableCopy];
    rewritten.URL = target;
    [NSURLProtocol setProperty:@YES forKey:SpLoginHandledKey inRequest:rewritten];

    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    configuration.timeoutIntervalForRequest = 20.0;
    configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    self.redirectBlocker = [[SpLoginURLProtocolRedirectBlocker alloc] init];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration
                                                         delegate:self.redirectBlocker
                                                    delegateQueue:nil];

    __weak typeof(self) weakSelf = self;
    self.task = [session dataTaskWithRequest:rewritten
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            __strong typeof(self) strongSelf = weakSelf;
            if (strongSelf == nil) {
                return;
            }
            if (error != nil) {
                [strongSelf.client URLProtocol:strongSelf didFailWithError:error];
                return;
            }
            [strongSelf.client URLProtocol:strongSelf didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
            if (data.length > 0) {
                [strongSelf.client URLProtocol:strongSelf didLoadData:data];
            }
            [strongSelf.client URLProtocolDidFinishLoading:strongSelf];
        }];
    [self.task resume];
}

- (void)stopLoading
{
    [self.task cancel];
    self.task = nil;
}

@end
