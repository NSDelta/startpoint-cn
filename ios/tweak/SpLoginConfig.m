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
@property (nonatomic, copy) NSString *jailbreakRoot;
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

- (void)load {
    sSPLoginConfigIsLoading = YES;
    // rootless（Dopamine）把整个越狱树挂在 /var/jb 下 —— 判断依据就这一个目录。
    NSFileManager *fm = [NSFileManager defaultManager];
    _jailbreakRoot = [fm fileExistsAtPath:@"/var/jb"] ? @"/var/jb" : @"";

    // 缺省：编译期常量 + 保守开关
    NSString *hostPort = SP_LOGIN_HOST;
    _uiTakeover = YES;
    _skipPrivacyDialogs = NO;
    _logToFile = YES;
    _autoPresent = NO;
    _autoPresentDelay = 2.0;
    _floatingButton = YES;   // 缺省 = 修复后的行为：常驻悬浮球（不依赖任何官方 UI 钩子）
    _skinEnabled = YES;      // 缺省 = 游戏化皮肤（纯外观；关掉退回素色表单）

    // plist 覆写（与 MobileSubstrate 过滤器同文件，见 SpLogin.plist）
    NSString *plistPath = [NSString stringWithFormat:@"%@/Library/MobileSubstrate/DynamicLibraries/%@",
                           _jailbreakRoot, kSPLoginPreferenceFileName];
    NSDictionary *prefs = [NSDictionary dictionaryWithContentsOfFile:plistPath];
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
        SPLoginLog(@"[config] 未读到 %@（用编译期常量）", plistPath);
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
    SPLoginLog(@"[config] host=%@ (plist覆写=%@) root=\"%@\" uiTakeover=%@ skipPrivacy=%@ autoPresent=%@ floatingButton=%@",
               _hostPort,
               hostOverrideEnabled ? @"开" : @"关",
               _jailbreakRoot,
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
    NSArray<NSString *> *candidates = @[
        [NSString stringWithFormat:@"%@/var/mobile/Library/Logs", _jailbreakRoot],
        NSTemporaryDirectory()
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
