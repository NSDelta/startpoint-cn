//
//  Tweak.x —— 越狱侧入口（rootless，iPhone 7 Plus / iOS 15.8.3）
//
//  这一份只做三件事：
//    ① 找出该挂的目标进程（worldflipper），别把整个 SpringBoard 都污染了；
//    ② 起 AMRuntime（引擎 + 取帧 + 触摸）；
//    ③ 决定面板要不要显示。
//
//  真正的逻辑全部在 ios/auto/ios/ 的平台层与 ios/auto/core/ 的引擎里 ——
//  越狱版与非越狱版共用同一套源码，区别只有"谁在什么时候调 AMRuntime"。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <substrate.h>

#import "AMRuntime.h"
#import "AMControlPanel.h"
#import "AMConfig.h"
#import "AMCapture.h"
#import "AMTouch.h"

#pragma mark - 目标进程判定

/*
 * 越狱版有两种挂载方式，这里都要照顾到：
 *   · 过滤器写的是 worldflipper（只注入游戏）—— 下面的判断恒真，无害；
 *   · 过滤器写的是 SpringBoard（某些越狱环境对 AIR 应用的过滤器不生效）——
 *     这时本 dylib 会被注入到每一个进程里，必须靠 bundle id 自己筛掉。
 *
 * 所以判断是"防御性"的，不是"必需"的。宁可多写十行，也不要在用户
 * 打开微信的时候把自动点击引擎挂上去。
 */
static BOOL AMIsTargetProcess(void)
{
    NSString *bid = [NSBundle mainBundle].bundleIdentifier;
    if (bid.length == 0) return NO;

    /* 主目标：世界弹射物语（雷霆国服）。这个值来自真机 IPA 的
       Payload/worldflipper.app 里的 CFBundleIdentifier，不是猜的
       （见 .research/ios-design.md §3 与 §9.2 的过滤器 plist 一行）。 */
    if ([bid isEqualToString:@"com.leiting.wf"]) return YES;

    /*
     * 兜底：bundle id 里带 worldflipper / leiting 的。
     * 不同区服、私服、重签名工具改成别的前缀时用得上 —— 静默失效比误注入难查得多。
     */
    const NSStringCompareOptions co = NSCaseInsensitiveSearch;
    if ([bid rangeOfString:@"worldflipper" options:co].location != NSNotFound) return YES;
    if ([bid rangeOfString:@"leiting"      options:co].location != NSNotFound) return YES;

    /* 系统进程一律不碰。 */
    if ([bid hasPrefix:@"com.apple."]) return NO;

    return NO;
}

#pragma mark - 生命周期

static void AMStart(void)
{
    @autoreleasepool {
        if (!AMIsTargetProcess()) return;

        NSLog(@"[AMAutoClick] 注入进 %@ (%@)",
              [NSBundle mainBundle].bundleIdentifier,
              [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);

        /* ① 取帧：尽早装 hook。游戏第一帧可能远早于 UIApplicationDidFinishLaunching。 */
        [[AMCapture shared] install];

        /* ② 触摸：这时只做能力探测，不发送任何事件。 */
        NSLog(@"[AMAutoClick] 触摸后端 = %@", [[AMTouch shared] backendName]);

        /* ③ 面板：必须在主线程建 UI。 */
        void (^ui)(void) = ^{
            if ([AMConfig shared].panelVisibleAtLaunch) {
                [[AMControlPanel shared] install];
            }
            if ([AMConfig shared].autoStart) {
                [[AMRuntime shared] autoStartIfConfigured];
            }
        };

        if ([NSThread isMainThread]) {
            ui();
        } else {
            dispatch_async(dispatch_get_main_queue(), ui);
        }
    }
}

#pragma mark - 注入点

/*
 * 选 UIApplication 的 -applicationDidFinishLaunching: 作为注入点，
 * 而不是 %ctor（构造器）。
 *
 * 原因：%ctor 跑在 dyld 的镜像加载阶段，此时 UIApplication.sharedApplication
 * 可能还是 nil、也没有 keyWindow —— AMTouch 的 resolve 会拿到 None 后端并
 * 缓存住，之后即使环境齐了也不会再探（见 AMTouch -resolve 的缓存注释）。
 * 等 didFinishLaunching 就都没问题了。
 */
%hook UIApplication

- (void)applicationDidFinishLaunching:(UIApplication *)application
{
    %orig;
    AMStart();
}

%end
