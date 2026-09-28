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

/// 改写后的 URL：`http://<host:port><path>[?query]`（官方 URL 上不会有需要保留的 port）。
+ (nullable NSURL *)rewrittenURLForRequest:(NSURLRequest *)request
{
    NSURL *url = request.URL;
    NSString *prefix = [self rewritePrefix];
    if (prefix == nil || url.path.length == 0) {
        return nil;
    }
    NSString *rewritten = [prefix stringByAppendingString:url.path];
    if (url.query.length > 0) {
        rewritten = [[rewritten stringByAppendingString:@"?"] stringByAppendingString:url.query];
    }
    return [NSURL URLWithString:rewritten];
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

    SPLoginLog(@"[SpLogin] rewrite %@://%@%@ -> %@",
               request.URL.scheme, request.URL.host, request.URL.path, target.absoluteString);

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
