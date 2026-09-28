// Tweak.xm —— SpLogin 主入口（P10-B，iOS「dylib 注入」线的越狱分支）
//
// 职责（集成者派工原文）：在 iOS 客户端启动早期把 SDK 登录相关请求/UI 接住，用于
// **显示服务端下发的注册验证码**与「已绑定/未绑定」提示。
//
// 三件事，全部带 NULL 检查（钩不到就记一行日志继续跑，绝不因为类不存在而崩）：
//   ① NSURLProtocol 注册：把 SDK 打向官方域名的请求改写到自建服务（官方 IPA 一字节不改）；
//   ② 官方 SDK 的登录/欢迎界面出现时，弹我们自己的类游戏面板（plist 开关 SPLoginUITakeover）；
//   ③ 可选的隐私弹窗跳过（plist 开关 SPLoginSkipPrivacyDialogs，**默认关**，红线）。
//
// ⚠️ 类名/选择器证据来源：P10-A 从官方主二进制字符串表里读到的
//    `LTWelcomeView` / `ShowProtocolView` / `ProtocolPrivacyPopView` / `LeitingSDK`
//    （`-[LeitingSDK needShowPrivacy]`）/ `GDPRManage` / `LTLoginManager showWelcomeView:`
//    （`client-patch/build/patch-ipa.mjs:199/223/227/242`）。真机上到底哪几个存在、
//    选择器签名是什么，**只能靠 `SpLogin.log` 的启动清单确认**（见报告 §7 [未验证-需真机]）。
//
// 用运行时 API 而不是 Logos `%hook`：官方类可能不存在或改名，`class_getInstanceMethod`
// 返回 NULL 时我们自己能兜住（本机成例 `D:\wfspcn\splash-text-dylib\Tweak.x` 也是这个写法）。

#import <UIKit/UIKit.h>
#import <objc/runtime.h>
// dispatch_after / dispatch_once 与 NSEC_PER_SEC：UIKit 目前会传递引入，但显式引入可
// 避免将来 SDK 收紧头文件时本文件被孤立地打断（零成本）。
#import <dispatch/dispatch.h>

#import "SpLoginAPI.h"
#import "SpLoginConfig.h"
#import "SpLoginURLProtocol.h"
#import "SpLoginViewController.h"

#pragma mark - 运行时小工具

/// 安全 swizzle：方法来自父类时先 `class_addMethod` 加一层，避免改到父类（如 UIViewController）。
static BOOL SpLoginSwizzle(Class cls, SEL selector, IMP replacement, IMP *outOriginal)
{
    if (cls == Nil || selector == NULL || replacement == NULL) {
        return NO;
    }
    Method method = class_getInstanceMethod(cls, selector);
    if (method == NULL) {
        return NO;
    }
    if (outOriginal != NULL) {
        *outOriginal = method_getImplementation(method);
    }
    const char *types = method_getTypeEncoding(method);
    if (class_addMethod(cls, selector, replacement, types)) {
        return YES;                     // 继承来的方法：本类现在有了自己的实现
    }
    method_setImplementation(method, replacement);
    return YES;
}

/// 官方 SDK 里「登录/欢迎/协议」界面的类名候选（真机启动时逐个 NSClassFromString 打清单）。
static NSArray<NSString *> *SpLoginSDKUIKitClassNames(void)
{
    return @[ @"LTWelcomeView",
              @"ShowProtocolView",
              @"ProtocolPrivacyPopView",
              @"LTLoginViewController",
              @"LTLoginView",
              @"LeitingLoginView" ];
}

static BOOL SpLoginClassLooksLikeSDKLoginUI(NSString *className)
{
    if (className.length == 0) {
        return NO;
    }
    if ([SpLoginSDKUIKitClassNames() containsObject:className]) {
        return YES;
    }
    // 兜底：以 LT / Leiting 开头且名字里带 Login/Welcome 的界面类
    NSString *lower = className.lowercaseString;
    BOOL prefixed = [className hasPrefix:@"LT"] || [lower hasPrefix:@"leiting"];
    BOOL looksLikeLogin = [lower containsString:@"login"] || [lower containsString:@"welcome"];
    return prefixed && looksLikeLogin;
}

#pragma mark - hook: 官方欢迎/登录界面出现时接管

static void (*sSpLoginOriginalViewDidAppear)(id, SEL, BOOL) = NULL;

static void SpLoginReplacementViewDidAppear(id self, SEL _cmd, BOOL animated)
{
    if (sSpLoginOriginalViewDidAppear != NULL) {
        sSpLoginOriginalViewDidAppear(self, _cmd, animated);
    }
    if (![SpLoginConfig sharedConfig].uiTakeover) {
        return;
    }
    NSString *className = NSStringFromClass([self class]);
    if (!SpLoginClassLooksLikeSDKLoginUI(className)) {
        return;
    }
    SPLoginLog(@"[SpLogin] SDK login UI appeared: %@ -> taking over", className);
    dispatch_async(dispatch_get_main_queue(), ^{
        [SpLoginViewController presentOnKeyWindow];
    });
}

#pragma mark - hook: LTLoginManager showWelcomeView:

// 选择器带一个参数（P10-A 从字符串表读到 `LTLoginManager showWelcomeView:`）。
// 只在「不接管」时才转调原实现；接管时直接不调 —— 参数原样转发，不猜签名。
static void (*sSpLoginOriginalShowWelcomeView)(id, SEL, id) = NULL;

static void SpLoginReplacementShowWelcomeView(id self, SEL _cmd, id argument)
{
    SPLoginLog(@"[SpLogin] LTLoginManager showWelcomeView: intercepted");
    if (![SpLoginConfig sharedConfig].uiTakeover) {
        if (sSpLoginOriginalShowWelcomeView != NULL) {
            sSpLoginOriginalShowWelcomeView(self, _cmd, argument);
        }
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        [SpLoginViewController presentOnKeyWindow];
    });
}

#pragma mark - hook: LeitingSDK needShowPrivacy

static BOOL (*sSpLoginOriginalNeedShowPrivacy)(id, SEL) = NULL;

static BOOL SpLoginReplacementNeedShowPrivacy(id self, SEL _cmd)
{
    if ([SpLoginConfig sharedConfig].skipPrivacyDialogs) {
        SPLoginLog(@"[SpLogin] LeitingSDK needShowPrivacy -> NO (跳过隐私弹窗)");
        return NO;
    }
    if (sSpLoginOriginalNeedShowPrivacy != NULL) {
        return sSpLoginOriginalNeedShowPrivacy(self, _cmd);
    }
    return YES;
}

#pragma mark - 启动

static void SpLoginInstallHooks(void)
{
    // ① 网络改写（先装：越早越好，SDK 一启动就会发请求）
    [SpLoginURLProtocol installIfNeeded];

    // ② UI 接管
    IMP original = NULL;
    BOOL hooked = SpLoginSwizzle([UIViewController class], @selector(viewDidAppear:),
                                 (IMP)SpLoginReplacementViewDidAppear, &original);
    sSpLoginOriginalViewDidAppear = (void (*)(id, SEL, BOOL))original;
    SPLoginLog(@"[SpLogin] hook UIViewController viewDidAppear: %@", hooked ? @"ok" : @"FAILED");

    // ③ 官方 SDK 类清单（真机取证用：哪些类真的在、选择器是什么）
    for (NSString *name in @[ @"LTLoginManager", @"LeitingSDK", @"GDPRManage", @"LTWelcomeView",
                              @"ShowProtocolView", @"ProtocolPrivacyPopView" ]) {
        Class cls = NSClassFromString(name);
        if (cls == Nil) {
            SPLoginLog(@"[SpLogin] class %@ : 不存在", name);
            continue;
        }
        Method welcome = class_getInstanceMethod(cls, NSSelectorFromString(@"showWelcomeView:"));
        Method privacy = class_getInstanceMethod(cls, NSSelectorFromString(@"needShowPrivacy"));
        SPLoginLog(@"[SpLogin] class %@ : 存在 (showWelcomeView:=%s needShowPrivacy=%s)",
                   name, welcome != NULL ? "有" : "无", privacy != NULL ? "有" : "无");
    }

    Class loginManager = NSClassFromString(@"LTLoginManager");
    if (SpLoginSwizzle(loginManager, NSSelectorFromString(@"showWelcomeView:"),
                       (IMP)SpLoginReplacementShowWelcomeView, &original)) {
        sSpLoginOriginalShowWelcomeView = (void (*)(id, SEL, id))original;
        SPLoginLog(@"[SpLogin] hook LTLoginManager showWelcomeView: ok");
    } else {
        SPLoginLog(@"[SpLogin] LTLoginManager showWelcomeView: 钩不到（靠 viewDidAppear 兜底）");
    }

    Class sdk = NSClassFromString(@"LeitingSDK");
    if (SpLoginSwizzle(sdk, NSSelectorFromString(@"needShowPrivacy"),
                       (IMP)SpLoginReplacementNeedShowPrivacy, &original)) {
        sSpLoginOriginalNeedShowPrivacy = (BOOL (*)(id, SEL))original;
        SPLoginLog(@"[SpLogin] hook LeitingSDK needShowPrivacy ok");
    } else {
        SPLoginLog(@"[SpLogin] LeitingSDK needShowPrivacy 钩不到（跳过隐私弹窗不可用，不影响主流程）");
    }

    // ④ 可选：启动后主动弹面板（plist SPLoginAutoPresent，默认关；只用于真机单点验证）
    SpLoginConfig *config = [SpLoginConfig sharedConfig];
    if (config.autoPresent) {
        NSTimeInterval delay = config.autoPresentDelay > 0 ? config.autoPresentDelay : 2.0;
        SPLoginLog(@"[SpLogin] autoPresent 已开启，%.1fs 后弹出登录面板", delay);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [SpLoginViewController presentOnKeyWindow];
        });
    }

    SPLoginLog(@"[SpLogin] ready (uiTakeover=%@ skipPrivacy=%@ host=%@)",
               config.uiTakeover ? @"YES" : @"NO",
               config.skipPrivacyDialogs ? @"YES" : @"NO",
               config.hostPort);
}

__attribute__((constructor)) static void SpLoginInit(void)
{
    @autoreleasepool {
        SpLoginInstallHooks();
        // 出站请求体里的 device_id 一次性对齐（见 SpLoginAPI.m 顶部注释）
        SPLoginLog(@"[SpLogin] current device_id=%@", [SpLoginAPI sharedAPI].deviceId ?: @"(none)");
    }
}
