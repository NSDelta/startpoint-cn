//
//  dylib.x —— 非越狱侧入口
//
//  与 tweak/Tweak.x 的唯一区别：**没有 substrate**。
//
//  非越狱的 App 进程里不存在 libsubstrate / ellekit，所以：
//    · 不能用 %hook / %orig（logos 会展开成 MSHookMessageEx，链接期找不到符号）
//    · 不能用 %ctor（虽然它其实只是 __attribute__((constructor))，但既然不能
//      用 logos，就一并用 C 属性写清楚）
//    · 不能用 MSHookFunction
//
//  替代品是每个 ObjC 运行时都有的 method_exchangeImplementations，
//  以及 libobjc 的 class_addMethod。这两个在系统库里有真实符号，侧载重签后可用。
//
//  ⚠️ 另一条硬约束：**不要 include rootless.h**。非越狱侧没有 /var/jb 前缀，
//     所有路径都是沙盒内的（见 AMRuntime +discoverScripts 的三个搜索位置）。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

#import "AMRuntime.h"
#import "AMControlPanel.h"
#import "AMConfig.h"
#import "AMCapture.h"
#import "AMTouch.h"

#pragma mark - 目标进程判定

static BOOL AMIsTargetProcess(void)
{
    NSString *bid = [NSBundle mainBundle].bundleIdentifier;
    if (bid.length == 0) return NO;
    if ([bid isEqualToString:@"com.leiting.wf"]) return YES;

    /* dylib 是我们自己注进去的，正常情况下根本不会跑到别的进程里去。
       但"重签名后的包被拿去做别的用途"不是没可能，多一层判断不花钱。 */
    const NSStringCompareOptions co = NSCaseInsensitiveSearch;
    if ([bid rangeOfString:@"worldflipper" options:co].location != NSNotFound) return YES;
    if ([bid rangeOfString:@"leiting"      options:co].location != NSNotFound) return YES;
    return NO;
}

#pragma mark - lifecycle hook（method_exchangeImplementations 版）

/*
 * 我们要在 applicationDidFinishLaunching: 之后启动，
 * 理由与越狱版完全一样（见 tweak/Tweak.x）：
 * %ctor / +load 跑得太早，那时 UIApplication 还没起来、
 * AMTouch 的 -resolve 会拿到 None 后端并缓存住。
 *
 * 用关联对象把"原始 IMP"绑在类上，比维护一个全局函数指针表稳 ——
 * 只有一处 exchange，写在 dispatch_once 里，重复调用无害。
 */
static void AMExchangeInstanceMethod(Class cls, SEL original, SEL replacement)
{
    if (!cls) return;
    Method m0 = class_getInstanceMethod(cls, original);
    Method m1 = class_getInstanceMethod(cls, replacement);
    if (!m0 || !m1) {
        NSLog(@"[AMAutoClick] 交换失败：%@ / %@ 有一个不存在",
              NSStringFromSelector(original), NSStringFromSelector(replacement));
        return;
    }
    method_exchangeImplementations(m0, m1);
}

@interface UIApplication (AMAutoClickLifecycle)
- (void)am_autoClick_applicationDidFinishLaunching:(UIApplication *)application;
@end

@implementation UIApplication (AMAutoClickLifecycle)

- (void)am_autoClick_applicationDidFinishLaunching:(UIApplication *)application
{
    /* 交换之后 self 的 -am_autoClick_... 指向**原来的** IMP，
       所以这一行就是调原实现，不是递归。 */
    [self am_autoClick_applicationDidFinishLaunching:application];

    if (!AMIsTargetProcess()) return;

    /* 注意：这里**不能**假设自己在主线程以外 —— didFinishLaunching
       本来就在主线程上，UI 可以直接建。 */
    [[AMControlPanel shared] install];   /* 内部会读 panelVisibleAtLaunch 决定显不显示 */
    [[AMRuntime shared] autoStartIfConfigured];

    NSLog(@"[AMAutoClick] dylib 已就绪：%@", [[AMRuntime shared] environmentSummary]);
}

@end

#pragma mark - 注入

__attribute__((constructor))
static void AMAutoClickInit(void)
{
    @autoreleasepool {
        /* 取帧 hook 要尽早 —— 游戏的第一个画面可能早于 didFinishLaunching 里的
           任何代码（AIR 有自己的启动线程）。 */
        [[AMCapture shared] install];

        static dispatch_once_t once;
        dispatch_once(&once, ^{
            AMExchangeInstanceMethod([UIApplication class],
                                     @selector(applicationDidFinishLaunching:),
                                     @selector(am_autoClick_applicationDidFinishLaunching:));
        });
    }
}
