// SpLoginConfig.m —— 运行时配置 + 日志（P10-B）

#import "SpLoginConfig.h"

// dispatch_once / dispatch_once_t（sharedConfig 的单例初始化）：显式引入，不依赖
// Foundation 的传递包含（SDK 收紧头文件时才暴露）。
#import <dispatch/dispatch.h>

#import <stdio.h>
#import <string.h>

// 构建期注入（Makefile: SpLogin_CFLAGS = ... -DSP_LOGIN_HOST=@"host:port"）。
// 这里的兜底值 = hygiene 白名单占位，只在有人绕过 Makefile 直接编译时才可能出现。
#ifndef SP_LOGIN_HOST
#define SP_LOGIN_HOST @"192.168.1.10:8001"
#endif

static NSString *const kSPLoginPreferenceFileName = @"SpLogin.plist";
static NSString *const kSPLoginLogFileName = @"SpLogin.log";

// +sharedConfig 在 dispatch_once 里跑 -load，而 -load 自己会打日志；
// SPLoginLog 又会去取 sharedConfig —— dispatch_once 不可重入，必须挡住这次回环。
static BOOL sSPLoginConfigIsLoading = NO;

/// app 沙盒 Documents 目录 —— 写「取证标记」与日志的首选地。
/// 非越狱注入场景下这是唯一用户能自己打开看的目录（见 SPLoginMarker 的说明）。
static NSString * _Nullable SPLoginDocumentsDirectory(void)
{
    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                                    NSUserDomainMask, YES);
    NSString *dir = dirs.firstObject;
    return [dir isKindOfClass:[NSString class]] ? dir : nil;
}

@interface SpLoginConfig ()
@property (nonatomic, copy) NSString *hostPort;
@property (nonatomic, copy) NSString *apiBaseURLString;
@property (nonatomic, assign) BOOL uiTakeover;
@property (nonatomic, assign) BOOL skipPrivacyDialogs;
@property (nonatomic, assign) BOOL logToFile;
@property (nonatomic, assign) BOOL autoPresent;
@property (nonatomic, assign) NSTimeInterval autoPresentDelay;
@property (nonatomic, assign) BOOL floatingButton;
@property (nonatomic, assign) BOOL skinEnabled;
@property (nonatomic, copy, nullable) NSString *preferenceSourcePath;
@property (nonatomic, copy, nullable) NSString *logFilePath;
@end

@implementation SpLoginConfig

+ (instancetype)sharedConfig {
    static SpLoginConfig *shared = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        shared = [[SpLoginConfig alloc] init];
        [shared load];
    });
    return shared;
}

/// plist 覆写的候选位置，**顺序即优先级**。全部是沙盒内路径，与越狱布局无关。
///
/// 为什么不是 `/Library/MobileSubstrate/DynamicLibraries/SpLogin.plist`：
/// 本 dylib 的目标用法是「**非越狱设备上自签、自注入**」，那种设备上不存在任何
/// MobileSubstrate 目录，越狱路径写了也读不到 —— 于是「覆写开关」变成永远无效的摆设。
/// 改成沙盒内的三处：
///   1. `Documents/SpLogin.plist`  —— 用户不用重签名就能改（「文件」App / 爱思 / iMazing 丢进去）
///   2. `<主包>/SpLogin.plist`     —— 打包进 .app 的默认配置（注入时顺手塞进去）
///   3. `<dylib 所在 bundle>/SpLogin.plist` —— 与 dylib 同目录（通常 Frameworks/）
+ (nullable NSString *)sp_firstExistingPreferencePath {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableArray<NSString *> *candidates = [NSMutableArray array];
    NSString *documents = SPLoginDocumentsDirectory();
    if (documents.length > 0) {
        [candidates addObject:[documents stringByAppendingPathComponent:kSPLoginPreferenceFileName]];
    }
    NSString *inApp = [[NSBundle mainBundle] pathForResource:@"SpLogin" ofType:@"plist"];
    if (inApp.length > 0) {
        [candidates addObject:inApp];
    }
    NSString *besideDylib = [[NSBundle bundleForClass:[SpLoginConfig class]]
                             pathForResource:@"SpLogin" ofType:@"plist"];
    if (besideDylib.length > 0 && ![candidates containsObject:besideDylib]) {
        [candidates addObject:besideDylib];
    }
    for (NSString *path in candidates) {
        if ([fm fileExistsAtPath:path]) {
            return path;
        }
    }
    return nil;
}

- (void)load {
    sSPLoginConfigIsLoading = YES;

    // 缺省：编译期常量 + 保守开关
    NSString *hostPort = SP_LOGIN_HOST;
    _uiTakeover = YES;
    _skipPrivacyDialogs = NO;
    _logToFile = YES;
    _autoPresent = NO;
    _autoPresentDelay = 2.0;
    _floatingButton = YES;   // 缺省 = 修复后的行为：常驻悬浮球（不依赖任何官方 UI 钩子）
    _skinEnabled = YES;      // 缺省 = 游戏化皮肤（纯外观；关掉退回素色表单）

    // plist 覆写：候选全部在沙盒内（见 sp_firstExistingPreferencePath 的说明）
    NSString *plistPath = [[self class] sp_firstExistingPreferencePath];
    NSDictionary *prefs = plistPath != nil ? [NSDictionary dictionaryWithContentsOfFile:plistPath] : nil;
    _preferenceSourcePath = [plistPath copy];
    BOOL hostOverrideEnabled = NO;
    if ([prefs isKindOfClass:[NSDictionary class]]) {
        id overrideFlag = prefs[@"SPLoginHostOverrideEnabled"];
        id overrideHost = prefs[@"SPLoginHost"];
        if ([overrideFlag isKindOfClass:[NSNumber class]]) {
            hostOverrideEnabled = [overrideFlag boolValue];
        }
        if (hostOverrideEnabled && [overrideHost isKindOfClass:[NSString class]] &&
            [(NSString *)overrideHost length] > 0) {
            hostPort = overrideHost;
        }
        if ([prefs[@"SPLoginUITakeover"] isKindOfClass:[NSNumber class]]) {
            _uiTakeover = [prefs[@"SPLoginUITakeover"] boolValue];
        }
        if ([prefs[@"SPLoginSkipPrivacyDialogs"] isKindOfClass:[NSNumber class]]) {
            _skipPrivacyDialogs = [prefs[@"SPLoginSkipPrivacyDialogs"] boolValue];
        }
        if ([prefs[@"SPLoginLogToFile"] isKindOfClass:[NSNumber class]]) {
            _logToFile = [prefs[@"SPLoginLogToFile"] boolValue];
        }
        if ([prefs[@"SPLoginAutoPresent"] isKindOfClass:[NSNumber class]]) {
            _autoPresent = [prefs[@"SPLoginAutoPresent"] boolValue];
        }
        if ([prefs[@"SPLoginAutoPresentDelay"] isKindOfClass:[NSNumber class]]) {
            _autoPresentDelay = [prefs[@"SPLoginAutoPresentDelay"] doubleValue];
        }
        if ([prefs[@"SPLoginFloatingButton"] isKindOfClass:[NSNumber class]]) {
            _floatingButton = [prefs[@"SPLoginFloatingButton"] boolValue];
        }
        if ([prefs[@"SPLoginSkinEnabled"] isKindOfClass:[NSNumber class]]) {
            _skinEnabled = [prefs[@"SPLoginSkinEnabled"] boolValue];
        }
    } else {
        SPLoginLog(@"[config] 未读到 plist 覆写（Documents / 主包 / dylib 同目录都没有），用编译期常量");
    }

    // 去掉可能被写进来的 scheme / 结尾斜杠，统一成 host:port
    hostPort = [hostPort stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([hostPort hasPrefix:@"http://"]) {
        hostPort = [hostPort substringFromIndex:[@"http://" length]];
    } else if ([hostPort hasPrefix:@"https://"]) {
        hostPort = [hostPort substringFromIndex:[@"https://" length]];
    }
    while ([hostPort hasSuffix:@"/"]) {
        hostPort = [hostPort substringToIndex:[hostPort length] - 1];
    }

    _hostPort = [hostPort copy];
    _apiBaseURLString = [[NSString stringWithFormat:@"http://%@", hostPort] copy];

    [self prepareLogFile];
    SPLoginLog(@"[config] host=%@ (plist覆写=%@ 来源=%@) uiTakeover=%@ skipPrivacy=%@ autoPresent=%@ floatingButton=%@",
               _hostPort,
               hostOverrideEnabled ? @"开" : @"关",
               _preferenceSourcePath != nil ? _preferenceSourcePath : @"(无，用编译期常量)",
               _uiTakeover ? @"YES" : @"NO",
               _skipPrivacyDialogs ? @"YES" : @"NO",
               _autoPresent ? @"YES" : @"NO",
               _floatingButton ? @"YES" : @"NO");
    sSPLoginConfigIsLoading = NO;
}

- (void)prepareLogFile {
    if (!_logToFile) {
        return;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    // 顺序即优先级。**Documents 放第一位**：本包的主用法是「非越狱设备上自签、把 dylib
    // 注入进 IPA」，那种环境里没有任何越狱目录可写，/tmp 用户也进不去，只有 Documents 能在
    // 「文件」App / Filza / iMazing 里直接看到 —— 看不到日志的日志等于没有日志。
    // 这里刻意**不**探测 /var/jb 之类越狱根：这个 dylib 只有一份构建，不按 rootful/
    // rootless 分叉，任何越狱布局都不该出现在它的路径假设里。
    NSArray<NSString *> *candidates = @[
        SPLoginDocumentsDirectory() ?: @"",
        NSTemporaryDirectory() ?: @""
    ];
    for (NSString *dir in candidates) {
        if (![dir isKindOfClass:[NSString class]] || [dir length] == 0) {
            continue;
        }
        if (![fm fileExistsAtPath:dir]) {
            [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
        }
        NSString *path = [dir stringByAppendingPathComponent:kSPLoginLogFileName];
        if ([fm fileExistsAtPath:dir] && [fm isWritableFileAtPath:dir]) {
            _logFilePath = [path copy];
            return;
        }
    }
    _logFilePath = nil;   // 写不进去就只走 NSLog，不报错
}

@end

void SPLoginMarker(NSString *name, NSString *detail, BOOL append) {
    @try {
        if (name.length == 0) {
            return;
        }
        NSString *dir = SPLoginDocumentsDirectory();
        if (dir.length == 0) {
            return;
        }
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm fileExistsAtPath:dir]) {
            [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
        }
        NSString *path = [dir stringByAppendingPathComponent:
                          [name stringByAppendingPathExtension:@"txt"]];

        NSMutableString *text = [NSMutableString string];
        if (!append) {
            [text appendFormat:@"== %@（覆盖写：这里永远是最新一次状态）\n", name];
        }
        [text appendFormat:@"%@\n", [NSDate date]];
        [text appendFormat:@"bundle=%@\n", [NSBundle mainBundle].bundleIdentifier ?: @"(nil)"];
        [text appendFormat:@"pid=%d %@\n",
                           (int)[NSProcessInfo processInfo].processIdentifier,
                           [NSThread isMainThread] ? @"main-thread" : @"bg-thread"];
        if (detail.length > 0) {
            [text appendFormat:@"%@\n", detail];
        }
        NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
        if (data == nil) {
            return;
        }

        // 覆盖语义：高频状态（挂载尝试）用，文件不增长，永远只有最新一份。
        // 追加语义：一次性事件（构造 / 安装 / 球 / 面板）用，攒成时间线；
        //           超过 64KB 就整体重来，避免 5s 看门狗把它写爆。
        BOOL rewrite = !append;
        if (!rewrite && [fm fileExistsAtPath:path]) {
            NSDictionary<NSFileAttributeKey, id> *attrs = [fm attributesOfItemAtPath:path error:NULL];
            unsigned long long size = [attrs[NSFileSize] unsignedLongLongValue];
            rewrite = (size + (unsigned long long)data.length > 64ULL * 1024ULL);
        }
        if (rewrite || ![fm fileExistsAtPath:path]) {
            [data writeToFile:path atomically:NO];
            return;
        }
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
        if (handle == nil) {
            [data writeToFile:path atomically:NO];
            return;
        }
        @try {
            [handle seekToEndOfFile];
            [handle writeData:data];
        } @finally {
            [handle closeFile];
        }
    } @catch (NSException *e) {
        NSLog(@"[SpLogin] marker(%@) 写入异常（已吞，绝不因此崩溃）: %@", name, e);
    }
}

void SPLoginLog(NSString *format, ...) {
    if (format == nil) {
        return;
    }
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    if (message == nil) {
        return;
    }

    NSLog(@"[SpLogin] %@", message);

    if (sSPLoginConfigIsLoading) {
        return;   // 配置加载中：只 NSLog，绝不回头取 sharedConfig（dispatch_once 不可重入）
    }
    SpLoginConfig *config = [SpLoginConfig sharedConfig];
    NSString *path = config.logFilePath;
    if (path == nil) {
        return;
    }

    static NSDateFormatter *formatter = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"MM-dd HH:mm:ss.SSS";
    });
    NSString *line = [NSString stringWithFormat:@"%@ %@\n", [formatter stringFromDate:[NSDate date]], message];

    FILE *fp = fopen([path fileSystemRepresentation], "a");
    if (fp == NULL) {
        return;
    }
    const char *utf8 = [line UTF8String];
    if (utf8 != NULL) {
        fputs(utf8, fp);
    }
    fclose(fp);
}
