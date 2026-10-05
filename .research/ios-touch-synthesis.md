# iOS 进程内合成触摸（Tap / Swipe）实现调研与可直接编译源码

目标：在**第三方 App 自己的进程内**合成 tap / swipe。宿主是 Adobe AIR / OpenGL ES 游戏。
目标平台：(a) iOS 15.8.3 越狱（palera1n **rootless** + ElleKit）；(b) 当前 iOS（17/18/26）**非越狱 sideload**。

**证据标签约定**
- `[源码]` = 我实际逐行读过该文件（本地已下载副本，路径见 §8）
- `[文档]` = README / 官方注释 / 项目文档
- `[社区]` = GitHub issue / 维护者回复（含日期与链接）
- `[自写]` = 本报告原创代码，**不来自任何仓库**（已按源语义推导并标注推导依据）
- `[未找到]` = 未能证实，**不要**基于它做设计

---

## §0 TL;DR（先看这个）

1. **任务书里的两个前提都不成立，已纠正**：
   - `lyft/Hammer` **没有任何 Objective-C 源码**，全是 Swift；`Hammer/EventGenerator*.m`、`HMTouch*.m`、`Hammer.m` **不存在**。`IOHIDEvent+KIF.{h,m}` 在 **KIF** 里，不在 Hammer。`[源码]`
   - KIF 里 **没有** `KIF_findViewAtPoint:withEvent:`；`Sources/KIF/Additions/UIWindow-KIFAdditions.m` 整个文件是注释掉的。KIF 也**从不调用** `_enqueueHIDEvent:`，它走公开的 `-[UIApplication sendEvent:]`。`[源码]`
2. **最重要的单条证据（决定选型）**：`KQAR/Reticle#281`（2026-08，iPhone 13 Pro Max / **iOS 26** 实测）：
   > "The digitizer `IOHIDEvent` this repo builds for the simulator **can** be constructed in-process on a device — IOKit's constructors resolve and `UIApplication` answers both `_enqueueHIDEvent:` and `_handleHIDEvent:` — and it is **accepted and routed nowhere**. All 16 combinations of sink, sender id, display-integrated flag and coordinate space dispatched **without error and did nothing**."
   同一 issue：改用「伪造 `UITouch` → 塞进 `UIApplication._touchesEvent` → `-sendEvent:`」后，**hit-testing / gesture recognizer / scroll view / 惯性滑动全部正常**。`[社区]`
3. 更早的同向结论：`google/EarlGrey#293`，EarlGrey 维护者 khandpur（2016）：
   > "doesn't work for all the supported platform versions. Also, **it doesn't work on devices due to entitlement issues**. And … there doesn't seem to be a reliable way to wait for the touch to be processed by the Application after it's been enqueued in the system. All of this makes it infeasible for EarlGrey." `[社区]`
4. 但 **Apple 自己的 WebKit 测试框架至今（`main` 分支）仍然只用** `BKSHIDEventSetDigitizerInfo` + `[UIApplication _enqueueHIDEvent:]`，且**没有任何版本分支/回退**；`_contextId`、`_enqueueHIDEvent:`、`_handleHIDEvent:` 在 iOS 26 上仍 `respondsToSelector:`。`[源码]`+`[社区]`
5. **结论**：HID 事件路径的可用性 **不是「iOS 版本」问题，而是「进程身份 / 沙箱 / entitlement」问题**。WebKit 能跑是因为 WebKitTestRunner 是 Apple 内部工具；越狱环境（tweak 注入 + 去沙箱）是第三方唯一有正面证据的场合。

---

## §1 选型裁决

### (a) 越狱 deb（iOS 15.8.3, palera1n rootless + ElleKit）

**首选：HID 事件路径（§2），并把 §3 的 `sendEvent:` 路径作为运行时回退。**

理由（按证据强度排序）：
1. 越狱环境下有**直接正面证据**：`ignuslabs/TouchSimulator-iOS16` 是「注入到目标 App 内的 tweak dylib」，README 明写 *"Synthesize touch events on iOS 14–16 **from inside an injected tweak dylib**"*、*"updated for iOS 15/16 rootless jailbreaks (palera1n, Dopamine)"*、*"Only works on jailbroken devices."*（iOS 15/16 rootless 正是你的目标）。`[文档]`
2. 同一 PR 记录：*"Reference: WebKit/main HIDEventGenerator.mm confirms `BKSHIDEventSetDigitizerInfo`, `_enqueueHIDEvent:`, `_contextId` remain stable on iOS 16+."* `[社区]`
3. HID 路径给的是**真 HID 事件**：UIKit 的窗口 hit-test、`UIGestureEnvironment`、系统级手势（长按选择、边缘手势）都按真实手指处理，而不是「往 responder 链里塞事件」。
4. 越狱才有 `IOHIDEventSystemClientDispatchEvent` 的系统级选项（§2.4）；非越狱基本无望（§5-Q2）。

**但必须**：启动时做 §2.5 的探针；探针失败立刻切 §3。理由见 §0-2 —— 同一个 API 在非越狱 App 内被证实「静默无效」，静态 `respondsToSelector:` 通过 ≠ 事件被路由。

### (b) 非越狱 sideload（iOS 17/18/26）

**只能用：`UITouch` + `UIApplication._touchesEvent` + `-[UIApplication sendEvent:]`（§3）。**

理由：
1. `KQAR/Reticle#281` 的 iOS 26 实测：HID digitizer 事件在**设备上进程内**「routed nowhere」，16 种组合全静默失败；而 `sendEvent:` 路可行且有量化结果（`act scroll-to` 需 4 次 swipe 成功、gesture recognizer 行被点中）。`[社区]`
2. `google/EarlGrey#293`：HID 路 on-device 有 entitlement 问题（2016 起就如此）。`[社区]`
3. `xuanxt/PTFakeTouch`（698★）的 README 标题就是 *"Simulate touch events for iOS ［**User mode**］"*、*"Just build it and add this framework to your project."* —— 用户态、不越狱、不碰 IOHID，纯 `initAtPoint:inWindow:` + `sendEvent:`。`[文档]`
4. KIF（生产级 UI 测试框架，10 年+）全部点按/拖拽都走 `sendEvent:`；`dragPointsAlongPaths:` 能驱动 `UIScrollView` 平移，说明**真 `UIEvent`+`UITouch` 对象足以喂饱 gesture recognizer**。`[源码]`

> 注意：`sendEvent:` 路仍然**用** IOHID 构造函数，但只用来给每个 `UITouch` 打一个内部 `_setHidEvent:`（iOS 9 起必需）。构造函数来自 IOKit，**非越狱也可 dlsym 到**（Hammer/WebKit/Reticle 都证实构造函数在设备上可解析）；被系统丢弃的是「把 IOHID 事件当输入提交」这件事。

### 不要做的事
- 不要用 `IOHIDEventSystemClientDispatchEvent` 作为**非越狱** App 内的主路径（§5-Q2）。
- 不要指望 `hitTest:withEvent:` 能命中原生 view 若游戏把 `userInteractionEnabled` 设成 `NO`（§5-Q4）。
- 不要只靠 `sendActionsForControlEvents:` 之外的花招去点 `UIButton`（§4.3）。

---

## §2 方案 A：真实 HID 事件路径（drop-in 源码）

### 2.1 文件清单

```
tweak/
├─ Makefile
├─ Tweak.xm
├─ IOSTouchHID.h          # 唯一对外头文件
├─ IOSTouchHID.m          # 全部实现（dlsym 私有符号，无需私有头文件）
└─ IOSPrivateHID.h        # （可选）常量/结构集中声明，也可并入 .m
```

Theos `Makefile`（rootless 由 `THEOS_PACKAGE_SCHEME=rootless` 切换，`ignuslabs` 的 `build.sh` 就是这么做的 `[源码]`）：

```make
ARCHS = arm64 arm64e
TARGET = iphone:clang:latest:15.0
TWEAK_NAME = MyTweak
MyTweak_FILES = Tweak.xm IOSTouchHID.m
MyTweak_FRAMEWORKS = UIKit Foundation
# 只有启用 §2.3 的 senderID 发现才需要下面这行；否则纯 dlopen/dlsym，无需链接私有库
MyTweak_LDFLAGS = -framework IOKit
include $(THEOS)/makefiles/common.mk
include $(THEOS)/makefiles/tweak.mk
```
rootless 打包：`unset THEOS_PACKAGE_SCHEME; export THEOS_PACKAGE_SCHEME=rootless; make clean package FINALPACKAGE=1` → 产物 `*_iphoneos-arm64.deb`。`[源码]`

### 2.2 `IOSTouchHID.h`

```objc
#ifndef IOSTOUCH_HID_H
#define IOSTOUCH_HID_H

#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

/// 运行时静态自检：_contextId / _enqueueHIDEvent: / BKSHIDEventSetDigitizerInfo 是否都存在。
/// 注意：返回 YES 只代表「符号在」，不代表事件会被路由（见 §5-Q1/Q2）。
BOOL IOSTouchHIDEnvironmentOK(void);

/// 端到端探针：注入一个 vendor-defined marker 事件并等待它从 UIApplication._handleHIDEvent: 回来。
/// 返回 YES 才说明 HID 事件真的进了 UIKit 的 HID 管线。内部会临时 swizzle _handleHIDEvent:。
BOOL IOSTouchHIDProbe(NSTimeInterval timeout);

/// 是否同时走系统级 IOHIDEventSystemClientDispatchEvent（默认 NO，只在 enqueue 路径不可用时自动启用）。
void IOSTouchHIDSetUseSystemDispatch(BOOL useSystemDispatch);

/// 入口：在屏幕坐标（UIWindow 坐标 / points，与 UITouch.locationInView:window 同坐标系）点一下
void simulated_tap(CGPoint p, NSTimeInterval pressDuration);

/// 入口：从 from 滑到 to，总时长 duration
void simulated_swipe(CGPoint from, CGPoint to, NSTimeInterval duration);

/// 入口：沿给定折线滑动
void simulated_swipe_path(const CGPoint *points, NSUInteger count, NSTimeInterval duration);

/// 入口：长按
void simulated_long_press(CGPoint p, NSTimeInterval holdDuration);

/// 清手：发一个「零触点」hand 事件，冲掉内核触摸跟踪器里的残留手指
/// （手势被打断/异常退出后必须调用，否则后续事件会被当成多指）
void simulated_hand_reset(void);

#ifdef __cplusplus
}
#endif
#endif /* IOSTOUCH_HID_H */
```

### 2.3 `IOSTouchHID.m` —— 私有符号声明（全部来自源码，逐字）

```objc
#import "IOSTouchHID.h"
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/runtime.h>
#import <objc/message.h>
#if __has_include(<IOKit/IOKitLib.h>)
#import <IOKit/IOKitLib.h>
#define IOSTOUCH_HAVE_IOKIT 1
#endif

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
typedef double IOHIDFloat;

/* ---- 事件类型 / 字段 ---- */
/* 字段编码规则：IOHIDEventFieldBase(type) = type << 16（KIF 原样定义） */
#define IOHID_FIELD_BASE(type) ((uint32_t)(type) << 16)
#define kHIDTypeVendorDefined   1u
#define kHIDTypeDigitizer      11u
#define kHIDTypeSwipe          16u

/* 序号取自 KIF 的 kIOHIDEventFieldDigitizer* 枚举顺序；
   X / Y / MajorRadius / MinorRadius / IsDisplayIntegrated 已用 Hammer 的硬编码值交叉校验 */
#define kHIDFieldDigitizerX                  (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 0)  /* 0xB0000 */
#define kHIDFieldDigitizerY                  (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 1)  /* 0xB0001 */
#define kHIDFieldDigitizerButtonMask         (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 3)
#define kHIDFieldDigitizerType               (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 4)
#define kHIDFieldDigitizerIndex              (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 5)
#define kHIDFieldDigitizerIdentity           (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 6)
#define kHIDFieldDigitizerEventMask          (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 7)  /* 0xB0007 */
#define kHIDFieldDigitizerRange              (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 8)  /* 0xB0008 */
#define kHIDFieldDigitizerTouch              (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 9)  /* 0xB0009 */
#define kHIDFieldDigitizerPressure           (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 10)
#define kHIDFieldDigitizerMajorRadius        (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 20) /* 0xB0014 */
#define kHIDFieldDigitizerMinorRadius        (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 21) /* 0xB0015 */
#define kHIDFieldDigitizerQualityRadiiAccuracy (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 24)
#define kHIDFieldDigitizerIsDisplayIntegrated  (IOHID_FIELD_BASE(kHIDTypeDigitizer) + 25) /* 0xB0019 */
#define kHIDFieldVendorDefinedData           (IOHID_FIELD_BASE(kHIDTypeVendorDefined) + 4) /* 0x10004 */

/* ---- digitizer event mask（KIF 枚举 + SimulateTouch 注释校验：Range|Touch|Identity = 1+2+32 = 35）---- */
enum {
    kHIDDigitizerEventRange            = 1u << 0,
    kHIDDigitizerEventTouch            = 1u << 1,
    kHIDDigitizerEventPosition         = 1u << 2,
    kHIDDigitizerEventStop             = 1u << 3,
    kHIDDigitizerEventPeak             = 1u << 4,
    kHIDDigitizerEventIdentity         = 1u << 5,   /* 32 */
    kHIDDigitizerEventAttribute        = 1u << 6,
    kHIDDigitizerEventCancel           = 1u << 7,
    kHIDDigitizerEventStart            = 1u << 8,
    kHIDDigitizerEventResting          = 1u << 9,
    kHIDDigitizerEventEstimatedAltitude  = 1u << 28,
    kHIDDigitizerEventEstimatedAzimuth   = 1u << 29,
    kHIDDigitizerEventEstimatedPressure  = 1u << 30,
};
enum { kHIDDigitizerTransducerTypeStylus = 0, kHIDDigitizerTransducerTypePuck = 1,
       kHIDDigitizerTransducerTypeFinger = 2, kHIDDigitizerTransducerTypeHand = 3 };

typedef uint64_t AbsoluteTime;   /* 64 位下直接传 mach_absolute_time()，见 KIF / Hammer / SimulateTouch 三种写法 */

/* ---- IOKit 符号 ---- */
static IOHIDEventRef      (*pCreateDigitizerEvent)(CFAllocatorRef, AbsoluteTime, uint32_t, uint32_t, uint32_t,
                                                   uint32_t, uint32_t, IOHIDFloat, IOHIDFloat, IOHIDFloat,
                                                   IOHIDFloat, IOHIDFloat, Boolean, Boolean, uint32_t);
static IOHIDEventRef      (*pCreateDigitizerFingerEvent)(CFAllocatorRef, AbsoluteTime, uint32_t, uint32_t,
                                                         uint32_t, IOHIDFloat, IOHIDFloat, IOHIDFloat,
                                                         IOHIDFloat, IOHIDFloat, Boolean, Boolean, uint32_t);
static IOHIDEventRef      (*pCreateVendorDefinedEvent)(CFAllocatorRef, AbsoluteTime, uint32_t, uint32_t,
                                                       uint32_t, CFArrayRef, uint32_t, uint32_t);
static void               (*pAppendEvent)(IOHIDEventRef, IOHIDEventRef, uint32_t);
static void               (*pSetIntegerValue)(IOHIDEventRef, uint32_t, CFIndex);
static void               (*pSetFloatValue)(IOHIDEventRef, uint32_t, IOHIDFloat);
static CFIndex            (*pGetIntegerValue)(IOHIDEventRef, uint32_t);
static uint32_t           (*pGetType)(IOHIDEventRef);
static void               (*pSetSenderID)(IOHIDEventRef, uint64_t);
static IOHIDEventSystemClientRef (*pClientCreate)(CFAllocatorRef);
static void               (*pClientScheduleWithRunLoop)(IOHIDEventSystemClientRef, CFRunLoopRef, CFStringRef);
static void               (*pClientDispatchEvent)(IOHIDEventSystemClientRef, IOHIDEventRef);

/* ---- BackBoardServices 符号 ---- */
/* 签名逐字来自 WebKit main: Tools/WebKitTestRunner/ios/HIDEventGenerator.mm 的 SOFT_LINK 行，
   与 Hammer 的 typealias、ignuslabs 的 typedef 三者完全一致 */
typedef void (*BKSHIDEventSetDigitizerInfo_t)(IOHIDEventRef digitizerEvent,
                                              uint32_t    contextID,
                                              uint8_t     systemGestureIsPossible,
                                              uint8_t     isSystemGestureStateChangeEvent,
                                              CFStringRef displayUUID,
                                              CFTimeInterval initialTouchTimestamp,
                                              float       maxForce);
static BKSHIDEventSetDigitizerInfo_t pBKSSetDigitizerInfo;
static IOHIDEventSystemClientRef     gHIDClient;
static uint64_t                      gSenderID;
static BOOL                          gUseSystemDispatch = NO;
```

**`extern` 声明写法（若你更喜欢不用 dlsym、直接链接）** —— 这是 `ignuslabs/TouchSimulator-iOS16/TouchSimulator.h` 的逐字内容 `[源码]`：

```objc
#include "headers/IOHIDEvent.h"          /* 私有头，需要自带一份 */
#include "headers/IOHIDEventData.h"
#include "headers/IOHIDEventTypes.h"
#include "headers/IOHIDEventSystemClient.h"
#include "headers/IOHIDEventSystem.h"
#include <mach/mach_time.h>
#import <UIKit/UIKit.h>

@interface UIApplication()
-(void)_enqueueHIDEvent:(IOHIDEventRef)arg1;
@end

@interface UIWindow()
-(unsigned)_contextId;
@end
```
> `Ryu0118/TouchSimulator-iOS14#1` 的编译报错正好证明这两条声明是必需的、且**不能省 `#import <UIKit/UIKit.h>`**：
> `error: cannot find interface declaration for 'UIApplication'` / `error: property '_contextId' not found on object of type 'UIWindow *'` / `error: no visible @interface for 'UIApplication' declares the selector '_enqueueHIDEvent:'`。`[社区]`
> **不需要** `extern` 声明的是 `IOHIDEventSystemClientDispatchEvent` —— SimulateTouch 里那段是自带的（`// ============= from veency`）：
> ```objc
> extern "C" {
>     IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
>     void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef client, IOHIDEventRef event);
> }
> ```
> `[源码]`

**senderID 常量（三个仓库互相矛盾，全部列出）**
| 来源 | 值 | 备注 |
|---|---|---|
| KIF（`kif_IOHIDEventWithTouches`） | **根本不设** | `[源码]` |
| WebKit `HIDEventGenerator.mm` | **根本不设**（全文 grep 无 senderID） | `[源码]` |
| Hammer `EventGenerator.swift` | `public var senderId: UInt64 = 0x0000000123456789`，注释 `/// Can be any value except 0.` | `[源码]` |
| SimulateTouch（hand 事件） | `#define kIOHIDEventDigitizerSenderID 0x000000010000027F`，注释 *"It looks changing each time, but it doens't care. just don't use 0"* | `[源码]` |
| SimulateTouch（键盘/按键事件） | `IOHIDEventSetSenderID(event, 0xDEFACEDBEEFFECE5)` | `[源码]` |
| ignuslabs TouchSimulator-iOS16 | 从 IORegistry `AppleMultitouchDevice` 的 `"Multitouch ID"` 读，失败回退 `0xDEFACEDBEEFFECE5` | `[源码]` |

### 2.4 事件构造函数（逐字对照，不要改 arg 顺序）

```objc
/* 15 参数版本（hand / parent 事件）。KIF 逐字原型：
   IOHIDEventRef IOHIDEventCreateDigitizerEvent(CFAllocatorRef allocator, AbsoluteTime timeStamp,
       IOHIDDigitizerTransducerType type, uint32_t index, uint32_t identity, uint32_t eventMask,
       uint32_t buttonMask, IOHIDFloat x, IOHIDFloat y, IOHIDFloat z, IOHIDFloat tipPressure,
       IOHIDFloat barrelPressure, Boolean range, Boolean touch, IOOptionBits options);   [源码] */
static IOHIDEventRef IOSTouchCreateHand(BOOL isTouching, uint32_t eventMask) {
    uint64_t ts = mach_absolute_time();
    IOHIDEventRef hand = pCreateDigitizerEvent(kCFAllocatorDefault, ts,
                                               kHIDDigitizerTransducerTypeHand,
                                               0,          /* index    */
                                               0,          /* identity */
                                               eventMask,
                                               0,          /* buttonMask */
                                               0, 0, 0,    /* x y z    */
                                               0, 0,       /* tip / barrel pressure */
                                               0,          /* range  */
                                               isTouching, /* touch  */
                                               0);         /* options */
    if (hand)
        pSetIntegerValue(hand, kHIDFieldDigitizerIsDisplayIntegrated, 1);
    return hand;
}

/* 13 参数版本（finger 子事件）—— WebKit / ignuslabs / Hammer 都用这个；KIF 与 SimulateTouch 用 18 参数的
   "WithQuality" 版本：IOHIDEventCreateDigitizerFingerEventWithQuality(..., minorRadius, majorRadius,
   quality, density, irregularity, range, touch, options)。两者都可，但半径要么写在构造参数里，
   要么用 IOHIDEventSetFloatValue 补（WebKit / ignuslabs 是后者）。 */
static IOHIDEventRef IOSTouchCreateFinger(uint32_t index, uint32_t identity, uint32_t eventMask,
                                          CGFloat x, CGFloat y, BOOL isTouching) {
    uint64_t ts = mach_absolute_time();
    IOHIDEventRef finger = pCreateDigitizerFingerEvent(kCFAllocatorDefault, ts,
                                                       index, identity, eventMask,
                                                       (IOHIDFloat)x, (IOHIDFloat)y, 0.0,
                                                       0.0,   /* tipPressure */
                                                       0.0,   /* twist       */
                                                       isTouching, /* range */
                                                       isTouching, /* touch */
                                                       0);    /* options */
    if (finger) {
        /* WebKit 用 defaultMajorRadius = 5；ignuslabs 注释：5.0mm 才是真实接触面积，
           0.04 会被 OS 判为噪声 */
        pSetFloatValue(finger, kHIDFieldDigitizerMajorRadius, 5.0);
        pSetFloatValue(finger, kHIDFieldDigitizerMinorRadius, 5.0);
    }
    return finger;
}
```

**WebKit 的 mask 规则（权威，直接照抄即可）** `[源码]`：
- child（finger）：
  - `UITouchPhase` 不是 cancelled / began / ended / stationary → 加 `Position`
  - 是 began / ended / cancelled → 加 `Touch | Range`
  - 是 cancelled → 再加 `Cancel`
  - 有压力读数 → 加 `Attribute`
- parent（hand）：初始 `Touch`；moved 时 `&= ~Touch; |= Position; |= Attribute`；began/cancelled/lifted 时 `|= Identity`

**SimulateTouch 的等价做法** `[源码]`：child 用 `Position` 或 `Range|Touch`，hand 上加 `Position` 或 `Range|Touch|Identity`，并在事件上补 `EventMask / Range / Touch` 三个字段（`IOHIDEventSetIntegerValueWithOptions(..., -268435456)`）。

**坐标空间（极易踩坑）**
- `_enqueueHIDEvent:` 路：**UIWindow 坐标 / points**，`roundf()` 取整。WebKit 逐字：`point = CGPointMake(roundf(point.x), roundf(point.y));`，注释里参数名就是 `pointInWindowCoordinates:` `[源码]`。Hammer 的 `fingerTap(at:)` 文档也写 *"A CGPoint in **screen coordinates**"* `[文档]`。
- `IOHIDEventSystemClientDispatchEvent` 路：老 SimulateTouch 用的是 **0~1 归一化**坐标 —— `rX = x/width*factor; rY = y/height*factor;`（`factor` 按屏宽 1/2/3 猜），非常脏且只到 iOS 7。现代仓库（ignuslabs / ZXTouch）用绝对坐标。**不要抄归一化那套。** `[源码]`

### 2.5 发送 + 探针（失败检测）

```objc
/* _handleHIDEvent: 的 swizzle 探针 —— 思路来自 Hammer 的 AppleInternal+UIKit.swift
   （@objc(_handleHIDEvent:) swizzle）与 WebKit 的 sendMarkerHIDEvent 机制 [源码] */
static IMP  gOrigHandleHIDEvent;
static BOOL gMarkerSeen;
static uint32_t gMarkerID;

static void IOSTouchHandleHIDEventHook(id self, SEL _cmd, IOHIDEventRef event) {
    if (event && pGetType && pGetType(event) == kHIDTypeVendorDefined) {
        CFIndex v = pGetIntegerValue(event, kHIDFieldVendorDefinedData);
        if ((uint32_t)v == gMarkerID)
            gMarkerSeen = YES;
    }
    ((void (*)(id, SEL, IOHIDEventRef))gOrigHandleHIDEvent)(self, _cmd, event);
}

static UIWindow *IOSTouchKeyWindow(void) {
    UIApplication *app = [UIApplication sharedApplication];
    for (UIScene *scene in app.connectedScenes) {                 /* iOS 13+，替代废弃的 app.windows */
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        if (scene.activationState != UISceneActivationStateForegroundActive &&
            scene.activationState != UISceneActivationStateForegroundInactive) continue;
        UIWindowScene *ws = (UIWindowScene *)scene;
        for (UIWindow *w in ws.windows)
            if (w.isKeyWindow) return w;
        if (ws.windows.count > 0) return ws.windows.firstObject;
    }
    return nil;
}

BOOL IOSTouchHIDEnvironmentOK(void) {
    UIApplication *app = [UIApplication sharedApplication];
    UIWindow *w = IOSTouchKeyWindow();
    BOOL ok = [app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")]
           && (w != nil) && [w respondsToSelector:NSSelectorFromString(@"_contextId")]
           && (pBKSSetDigitizerInfo != NULL)
           && (pCreateDigitizerEvent != NULL) && (pCreateDigitizerFingerEvent != NULL);
    NSLog(@"[IOSTouchHID] env: enqueue=%d ctx=%d bks=%d ctors=%d",
          [app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")],
          [w respondsToSelector:NSSelectorFromString(@"_contextId")],
          pBKSSetDigitizerInfo != NULL, pCreateDigitizerEvent != NULL);
    return ok;
}

static void IOSTouchSend(IOHIDEventRef event) {
    if (!event) return;
    UIWindow *w = IOSTouchKeyWindow();
    BOOL didEnqueue = NO;

    /* ---- 路线 1：BKSHIDEventSetDigitizerInfo + _enqueueHIDEvent:（WebKit / Hammer / ignuslabs 同款） ---- */
    if (w && pBKSSetDigitizerInfo &&
        [w respondsToSelector:NSSelectorFromString(@"_contextId")] &&
        [[UIApplication sharedApplication] respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")]) {
        uint32_t ctx = ((uint32_t (*)(id, SEL))objc_msgSend)(w, NSSelectorFromString(@"_contextId"));
        if (ctx) {
            pBKSSetDigitizerInfo(event, ctx, 0, 0, NULL, 0, 0);   /* 7 参数，WebKit/Hammer 逐字同款 */
            ((void (*)(id, SEL, IOHIDEventRef))objc_msgSend)(
                [UIApplication sharedApplication], NSSelectorFromString(@"_enqueueHIDEvent:"), event);
            didEnqueue = YES;
        }
    }

    /* ---- 路线 2：系统级派发（越狱 / 系统进程） ---- */
    if (gHIDClient && (gUseSystemDispatch || !didEnqueue)) {
        pSetSenderID(event, gSenderID);
        pClientDispatchEvent(gHIDClient, event);
    }
}

BOOL IOSTouchHIDProbe(NSTimeInterval timeout) {
    if (!pCreateVendorDefinedEvent || !pGetIntegerValue) return NO;
    static dispatch_once_t once; static BOOL hookInstalled = NO;
    dispatch_once(&once, ^{
        Method m = class_getInstanceMethod([UIApplication class], NSSelectorFromString(@"_handleHIDEvent:"));
        if (m) { gOrigHandleHIDEvent = method_getImplementation(m);
                 method_setImplementation(m, (IMP)IOSTouchHandleHIDEventHook); hookInstalled = YES; }
    });
    if (!hookInstalled) return NO;

    gMarkerID = (uint32_t)arc4random();
    gMarkerSeen = NO;
    NSData *idData = [NSData dataWithBytes:&gMarkerID length:sizeof(gMarkerID)];
    uint64_t ts = mach_absolute_time();
    /* WebKit 用 kHIDPage_VendorDefinedStart + 100 作为 usagePage；Hammer 用 0xFF00 + 100 */
    IOHIDEventRef marker = pCreateVendorDefinedEvent(kCFAllocatorDefault, ts,
                                                     0xFF00 + 100, 0, 1,
                                                     (__bridge CFArrayRef)@[idData],
                                                     (uint32_t)idData.length, 0);
    if (!marker) return NO;
    pSetIntegerValue(marker, kHIDFieldVendorDefinedData, (CFIndex)gMarkerID); /* Hammer 的 workaround */
    IOSTouchSend(marker);
    CFRelease(marker);

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!gMarkerSeen && [deadline timeIntervalSinceNow] > 0)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    NSLog(@"[IOSTouchHID] probe: %@", gMarkerSeen ? @"DELIVERED" : @"DROPPED (静默丢弃，请回退到 §3)");
    return gMarkerSeen;
}
```

> **为什么必须有探针**：`_enqueueHIDEvent:` 在 iOS 26 上**存在且调用无异常、但事件被路由到任何地方都没有**（Reticle 16 组合实测）。`respondsToSelector:` / `dlsym` 全 YES。唯一可靠的判定就是「事件回到 `_handleHIDEvent:`」。

### 2.6 手势实现 + `simulated_tap` / `simulated_swipe`

```objc
/* 时序常量：WebKit HIDEventGenerator.mm 逐字 [源码]
   fingerLiftDelay = 0.05; multiTapInterval = 0.15; fingerMoveInterval = 0.016; longPressHoldDelay = 2.0;
   Hammer: fingerLiftDelay = 0.05, longPressHoldDelay = 2.0, multiTapInterval = 0.15, fingerMoveInterval = 1/60 */
#define kIOSTouchFingerLiftDelay   0.05
#define kIOSTouchFingerMoveInterval 0.016
#define kIOSTouchMultiTapInterval  0.15

/* 阻塞式等待，但保持主 runloop 转动 —— WebKit 的 _waitFor: 就是这么写的 [源码] */
static void IOSTouchWait(NSTimeInterval delay) {
    if (delay <= 0) return;
    __block BOOL done = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ done = YES; });
    while (!done)
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate distantFuture]];
}

static uint32_t gFingerIdentifier = 2;   /* WebKit 的 fingerIdentifiers[] = {2,3,4,5,1}；KIF 也用 identity=2 */

static void IOSTouchEmit(uint32_t eventMask, uint32_t identity, uint32_t index,
                         CGFloat x, CGFloat y, BOOL touching, BOOL liftUp) {
    uint32_t handMask = kHIDDigitizerEventTouch;
    if (eventMask & kHIDDigitizerEventPosition) handMask |= kHIDDigitizerEventPosition | kHIDDigitizerEventAttribute;
    if (liftUp && !touching)                     handMask |= kHIDDigitizerEventIdentity;
    IOHIDEventRef hand = IOSTouchCreateHand(touching, handMask);
    if (!hand) return;
    IOHIDEventRef finger = IOSTouchCreateFinger(index, identity, eventMask, x, y, touching);
    if (finger) { pAppendEvent(hand, finger, 0); CFRelease(finger); }
    IOSTouchSend(hand);
    CFRelease(hand);
}

void simulated_hand_reset(void) {
    /* ignuslabs: 零触点 hand 事件，冲掉内核触摸跟踪器里的残留手指 [源码] */
    IOHIDEventRef reset = IOSTouchCreateHand(NO, kHIDDigitizerEventTouch | kHIDDigitizerEventRange);
    if (!reset) return;
    IOSTouchSend(reset);
    CFRelease(reset);
    IOSTouchWait(kIOSTouchFingerLiftDelay);
}

void simulated_tap(CGPoint p, NSTimeInterval pressDuration) {
    if (pressDuration <= 0) pressDuration = kIOSTouchFingerLiftDelay;   /* 默认 50ms */
    uint32_t id = gFingerIdentifier;
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, p.x, p.y, YES, NO);                      /* fingerDown  */
    IOSTouchWait(pressDuration);
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, p.x, p.y, NO, YES);                      /* fingerUp    */
    IOSTouchWait(kIOSTouchFingerLiftDelay);
}

void simulated_swipe(CGPoint from, CGPoint to, NSTimeInterval duration) {
    CGPoint pts[2] = { from, to };
    simulated_swipe_path(pts, 2, duration);
}

void simulated_swipe_path(const CGPoint *points, NSUInteger count, NSTimeInterval duration) {
    if (count < 2 || duration <= 0) return;
    uint32_t id = gFingerIdentifier;
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, points[0].x, points[0].y, YES, NO);
    IOSTouchWait(kIOSTouchFingerLiftDelay);

    /* 逐段插值，每 kIOSTouchFingerMoveInterval 发一个 Position 事件（≈62.5Hz，WebKit 实测可用） */
    for (NSUInteger seg = 0; seg + 1 < count; ++seg) {
        CGPoint a = points[seg], b = points[seg + 1];
        NSUInteger steps = MAX(1, (NSUInteger)(duration / (NSTimeInterval)(count - 1) / kIOSTouchFingerMoveInterval));
        for (NSUInteger i = 1; i <= steps; ++i) {
            CGFloat t = (CGFloat)i / (CGFloat)steps;
            IOSTouchEmit(kHIDDigitizerEventPosition, id, 0,
                         a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, YES, NO);
            IOSTouchWait(kIOSTouchFingerMoveInterval);
        }
    }
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, points[count - 1].x, points[count - 1].y, NO, YES);
    IOSTouchWait(kIOSTouchFingerLiftDelay);
}

void simulated_long_press(CGPoint p, NSTimeInterval holdDuration) {
    uint32_t id = gFingerIdentifier;
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, p.x, p.y, YES, NO);
    NSTimeInterval elapsed = 0;
    while (elapsed < holdDuration) {                       /* stationary 心跳，KIF longPress 同思路 */
        IOSTouchEmit(kHIDDigitizerEventPosition, id, 0, p.x, p.y, YES, NO);
        IOSTouchWait(kIOSTouchFingerMoveInterval);
        elapsed += kIOSTouchFingerMoveInterval;
    }
    IOSTouchEmit(kHIDDigitizerEventTouch | kHIDDigitizerEventRange | kHIDDigitizerEventIdentity,
                 id, 0, p.x, p.y, NO, YES);
}

void IOSTouchHIDSetUseSystemDispatch(BOOL useSystemDispatch) { gUseSystemDispatch = useSystemDispatch; }

__attribute__((constructor))
static void IOSTouchHIDInit(void) {
    void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
    if (iokit) {
        pCreateDigitizerEvent       = dlsym(iokit, "IOHIDEventCreateDigitizerEvent");
        pCreateDigitizerFingerEvent = dlsym(iokit, "IOHIDEventCreateDigitizerFingerEvent");
        pCreateVendorDefinedEvent   = dlsym(iokit, "IOHIDEventCreateVendorDefinedEvent");
        pAppendEvent                = dlsym(iokit, "IOHIDEventAppendEvent");
        pSetIntegerValue            = dlsym(iokit, "IOHIDEventSetIntegerValue");
        pSetFloatValue              = dlsym(iokit, "IOHIDEventSetFloatValue");
        pGetIntegerValue            = dlsym(iokit, "IOHIDEventGetIntegerValue");
        pGetType                    = dlsym(iokit, "IOHIDEventGetType");
        pSetSenderID                = dlsym(iokit, "IOHIDEventSetSenderID");
        pClientCreate               = dlsym(iokit, "IOHIDEventSystemClientCreate");
        pClientScheduleWithRunLoop  = dlsym(iokit, "IOHIDEventSystemClientScheduleWithRunLoop");
        pClientDispatchEvent        = dlsym(iokit, "IOHIDEventSystemClientDispatchEvent");
    }
    void *bks = dlopen("/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices", RTLD_NOW);
    if (bks) pBKSSetDigitizerInfo = dlsym(bks, "BKSHIDEventSetDigitizerInfo");

    if (pClientCreate) {
        gHIDClient = pClientCreate(kCFAllocatorDefault);
        /* ignuslabs 逐字注释："Must schedule on the run loop — without this the Mach port source is
           never registered and IOHIDEventSystemClientDispatchEvent silently fails to deliver events
           on iOS 15+." [源码] */
        if (gHIDClient && pClientScheduleWithRunLoop)
            pClientScheduleWithRunLoop(gHIDClient, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
    }
    gSenderID = 0xDEFACEDBEEFFECE5ULL;   /* 可选：见 §5-Q2 的 IORegistry 读法 */
}
```

---

## §3 方案 B：`UITouch` + `sendEvent:` 路径（drop-in 源码）

血统：KIF `UITouch-KIFAdditions.m` / `UIEvent-KIFAdditions.m` / `UIApplication-KIFAdditions.m` → `xuanxt/PTFakeTouch`（去掉 KIF 依赖、user mode）。

### 3.1 `IOSTouchSynth.h`

```objc
#ifndef IOSTOUCH_SYNTH_H
#define IOSTOUCH_SYNTH_H
#import <UIKit/UIKit.h>
#ifdef __cplusplus
extern "C" {
#endif
BOOL IOSTouchSynthAvailable(void);
void simulated_tap(CGPoint p, NSTimeInterval pressDuration);
void simulated_double_tap(CGPoint p, NSTimeInterval pressDuration, NSTimeInterval interTapDelay);
void simulated_swipe(CGPoint from, CGPoint to, NSTimeInterval duration);
void simulated_long_press(CGPoint p, NSTimeInterval holdDuration);
/// 多指：同时按下、移动、抬起（pts 长度 = 手指数）
void simulated_multi_touch(const CGPoint *pts, NSUInteger count,
                           CGPoint *targets, NSTimeInterval duration);
#ifdef __cplusplus
}
#endif
#endif
```

### 3.2 `IOSTouchSynth.m` —— 私有 selector 全清单（逐字来自 KIF / PTFakeTouch）

```objc
#import "IOSTouchSynth.h"
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach/mach_time.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef IOHIDEventRef (*CreateFingerWithQuality_t)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                                   double, double, double, double, double,
                                                   double, double, double, double, double,
                                                   Boolean, Boolean, uint32_t);
typedef IOHIDEventRef (*CreateDigitizer_t)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                           uint32_t, uint32_t, double, double, double, double, double,
                                           Boolean, Boolean, uint32_t);
typedef void (*AppendEvent_t)(IOHIDEventRef, IOHIDEventRef, uint32_t);
typedef void (*SetInt_t)(IOHIDEventRef, uint32_t, CFIndex);
static CreateFingerWithQuality_t pFingerWithQuality;
static CreateDigitizer_t        pDigitizer;
static AppendEvent_t            pAppend;
static SetInt_t                 pSetInt;
#define kHIDTypeDigitizer 11u
#define kHIDFieldDigitizerIdentity      ((kHIDTypeDigitizer << 16) + 6)
#define kHIDFieldDigitizerEventMask     ((kHIDTypeDigitizer << 16) + 7)
#define kHIDFieldDigitizerIsDisplayIntegrated ((kHIDTypeDigitizer << 16) + 25)
#define kHIDEvtRange 1u
#define kHIDEvtTouch 2u
#define kHIDEvtPosition 4u

/* ---------- UITouch 私有方法（KIF/PTFakeTouch 逐字） ---------- */
@interface UITouch (IOSTouchSynth)
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setIsTap:(BOOL)isTap;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setPhase:(UITouchPhase)phase;
- (void)setGestureView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)firstTouchForView;
- (void)_setIsTapToClick:(BOOL)isTapToClick;
- (void)_setHidEvent:(IOHIDEventRef)event;
@end

/* ---------- UIApplication / UIEvent 私有方法 ---------- */
@interface UIApplication (IOSTouchSynth)
- (UIEvent *)_touchesEvent;
@end

@interface UIEvent (IOSTouchSynth)
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_setHIDEvent:(IOHIDEventRef)event;      /* iOS 8+ 路径；KIF 在 <8 时改走 _setGSEvent: */
- (void)_setTimestamp:(NSTimeInterval)timestamp;
@end
```

**构造一个 `UITouch`（顺序不能改）**

```objc
static UIWindow *IOSTouchSynthKeyWindow(void) {
    UIApplication *app = [UIApplication sharedApplication];
    for (UIScene *s in app.connectedScenes) {                    /* KIF windowsWithKeyWindow 同思路 */
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *w in ((UIWindowScene *)s).windows)
            if (w.isKeyWindow) return w;
    }
    return app.windows.firstObject;                              /* 兜底 */
}

static IOHIDEventRef IOSTouchSynthHIDEventForTouches(NSArray<UITouch *> *touches) {
    if (!pDigitizer || !pFingerWithQuality) return NULL;
    uint64_t abTime = mach_absolute_time();
    IOHIDEventRef hand = pDigitizer(kCFAllocatorDefault, abTime,
                                    /*hand*/3, 0, 0,
                                    kHIDEvtTouch, 0,
                                    0, 0, 0, 0, 0,
                                    0 /*range*/, true /*touch*/, 0);
    if (hand) pSetInt(hand, kHIDFieldDigitizerIsDisplayIntegrated, 1);
    NSUInteger i = 0;
    for (UITouch *t in touches) {
        uint32_t mask = (t.phase == UITouchPhaseMoved) ? kHIDEvtPosition : (kHIDEvtRange | kHIDEvtTouch);
        uint32_t touching = (t.phase == UITouchPhaseEnded) ? 0 : 1;
        CGPoint loc = [t locationInView:t.window];
        IOHIDEventRef f = pFingerWithQuality(kCFAllocatorDefault, abTime,
                                             (uint32_t)(i + 1),   /* index    */
                                             2,                   /* identity —— KIF 固定 2 */
                                             mask, loc.x, loc.y, 0.0,
                                             0, 0,                /* tipPressure, twist */
                                             5.0, 5.0,            /* minorRadius, majorRadius */
                                             1.0, 1.0, 1.0,       /* quality, density, irregularity */
                                             touching, touching, 0);
        if (f) { pSetInt(hand ? hand : f, kHIDFieldDigitizerIsDisplayIntegrated, 1);
                 if (hand) { pAppend(hand, f, 0); CFRelease(f); } }
        ++i;
    }
    return hand;
}

static UITouch *IOSTouchSynthMakeTouch(CGPoint pointInWindow, UIWindow *window,
                                       UITouchPhase phase, UITouch *reuse) {
    UITouch *touch = reuse ?: [[UITouch alloc] init];
    [touch setWindow:window];                       /* 必须最先 —— 注释: "Wipes out some values. Needs to be first." */
    [touch setTapCount:1];
    [touch _setLocationInWindow:pointInWindow resetPrevious:(reuse == nil)];
    UIView *hitTestView = [window hitTest:pointInWindow withEvent:nil];
    [touch setView:hitTestView];
    [touch setPhase:phase];
    if (@available(iOS 14.0, *)) {
        /* PTFakeTouch 的 iOS14 分支 [源码] */
        if ([touch respondsToSelector:@selector(_setIsTapToClick:)]) [touch _setIsTapToClick:NO];
    } else {
        if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) [touch _setIsFirstTouchForView:YES];
        if ([touch respondsToSelector:@selector(setIsTap:)]) [touch setIsTap:NO];
    }
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    if ([touch respondsToSelector:@selector(setGestureView:)]) [touch setGestureView:hitTestView];
    /* "Starting with iOS 9, internal IOHIDEvent must be set for UITouch object" —— KIF/PTFakeTouch 同注释 */
    IOHIDEventRef hid = IOSTouchSynthHIDEventForTouches(@[touch]);
    if (hid) { [touch _setHidEvent:hid]; CFRelease(hid); }
    return touch;
}

/* 组事件并发送。PTFakeTouch 的做法：每个事件里带上「所有活动触点」 [源码] */
static void IOSTouchSynthSend(NSArray<UITouch *> *allTouches) {
    UIApplication *app = [UIApplication sharedApplication];
    UIEvent *event = [app _touchesEvent];
    [event _clearTouches];
    IOHIDEventRef hid = IOSTouchSynthHIDEventForTouches(allTouches);
    if (hid) { [event _setHIDEvent:hid]; CFRelease(hid); }
    if (allTouches.count) [event _setTimestamp:allTouches.firstObject.timestamp];
    for (UITouch *t in allTouches) [event _addTouch:t forDelayedDelivery:NO];
    [app sendEvent:event];      /* 公开 API —— UIKit 自己的手指事件入口 [源码] */
}
```

**入口实现**

```objc
void simulated_tap(CGPoint p, NSTimeInterval pressDuration) {
    UIWindow *w = IOSTouchSynthKeyWindow();
    if (!w) return;
    UITouch *touch = IOSTouchSynthMakeTouch(p, w, UITouchPhaseBegan, nil);
    IOSTouchSynthSend(@[touch]);
    if (pressDuration > 0) [NSThread sleepForTimeInterval:pressDuration];
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    [touch setPhase:UITouchPhaseEnded];
    IOSTouchSynthSend(@[touch]);            /* 必须复用同一个 UITouch —— 身份/窗口/视图要一致 */
}

void simulated_double_tap(CGPoint p, NSTimeInterval pressDuration, NSTimeInterval interTapDelay) {
    simulated_tap(p, pressDuration);
    [NSThread sleepForTimeInterval:(interTapDelay > 0 ? interTapDelay : 0.15)];  /* WebKit multiTapInterval */
    simulated_tap(p, pressDuration);
}

void simulated_swipe(CGPoint from, CGPoint to, NSTimeInterval duration) {
    UIWindow *w = IOSTouchSynthKeyWindow();
    if (!w) return;
    UITouch *touch = IOSTouchSynthMakeTouch(from, w, UITouchPhaseBegan, nil);
    IOSTouchSynthSend(@[touch]);
    [NSThread sleepForTimeInterval:0.05];                       /* fingerLiftDelay */
    NSUInteger steps = MAX(2, (NSUInteger)(duration / 0.016));  /* fingerMoveInterval */
    for (NSUInteger i = 1; i <= steps; ++i) {
        CGFloat t = (CGFloat)i / (CGFloat)steps;
        CGPoint q = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
        [touch _setLocationInWindow:q resetPrevious:NO];
        [touch setPhase:UITouchPhaseMoved];
        IOSTouchSynthSend(@[touch]);
        [NSThread sleepForTimeInterval:0.016];
    }
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    [touch setPhase:UITouchPhaseEnded];
    IOSTouchSynthSend(@[touch]);
}

void simulated_long_press(CGPoint p, NSTimeInterval holdDuration) {
    UIWindow *w = IOSTouchSynthKeyWindow();
    if (!w) return;
    UITouch *touch = IOSTouchSynthMakeTouch(p, w, UITouchPhaseBegan, nil);
    IOSTouchSynthSend(@[touch]);
    NSTimeInterval e = 0;
    while (e < holdDuration) {                                  /* stationary 心跳 */
        [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
        [touch setPhase:UITouchPhaseStationary];
        IOSTouchSynthSend(@[touch]);
        [NSThread sleepForTimeInterval:0.01]; e += 0.01;
    }
    [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
    [touch setPhase:UITouchPhaseEnded];
    IOSTouchSynthSend(@[touch]);
}

BOOL IOSTouchSynthAvailable(void) {
    UIApplication *app = [UIApplication sharedApplication];
    return [app respondsToSelector:NSSelectorFromString(@"_touchesEvent")]
        && [UIEvent instancesRespondToSelector:NSSelectorFromString(@"_addTouch:forDelayedDelivery:")]
        && [UITouch instancesRespondToSelector:NSSelectorFromString(@"_setLocationInWindow:resetPrevious:")]
        && (IOSTouchSynthKeyWindow() != nil);
}

__attribute__((constructor))
static void IOSTouchSynthInit(void) {
    void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
    if (iokit) {
        pDigitizer        = dlsym(iokit, "IOHIDEventCreateDigitizerEvent");
        pFingerWithQuality= dlsym(iokit, "IOHIDEventCreateDigitizerFingerEventWithQuality");
        pAppend           = dlsym(iokit, "IOHIDEventAppendEvent");
        pSetInt           = dlsym(iokit, "IOHIDEventSetIntegerValue");
    }
}
```

### 3.3 统一门面（推荐这样接进 Tweak）

```objc
// IOSTouch.h
typedef NS_ENUM(NSInteger, IOSTouchBackend) { IOSTouchBackendAuto, IOSTouchBackendHID, IOSTouchBackendUITouch };
void IOSTouchSetBackend(IOSTouchBackend b);
void IOSTouchTap(CGPoint p, NSTimeInterval press);     // 内部按 backend 分发到 simulated_tap
void IOSTouchSwipe(CGPoint a, CGPoint b, NSTimeInterval d);

// IOSTouch.m（关键逻辑）
static IOSTouchBackend gBackend = IOSTouchBackendAuto;
static IOSTouchBackend IOSTouchResolve(void) {
    if (gBackend != IOSTouchBackendAuto) return gBackend;
    if (IOSTouchHIDEnvironmentOK() && IOSTouchHIDProbe(0.3)) return IOSTouchBackendHID;  // 只探一次并缓存
    NSLog(@"[IOSTouch] HID 路径不可用，回退 UITouch/sendEvent");
    return IOSTouchBackendUITouch;
}
```

---

## §4 方案 C：UIControl / responder 兜底（ACQUIRE-2）

### 4.1 「忽略 `userInteractionEnabled` / `alpha` / `hidden`」的强制命中

KIF 用的是**公开** `hitTest:withEvent:`（**会**受这三个属性影响）。所以下面这段**不是**任何仓库的代码，是我按 `hitTest:withEvent:` 语义手写、仅去掉三个 early-return 的版本 —— `[自写]`，风险自负：

```objc
/* UIView hitTest:withEvent: 的等价递归，但去掉 hidden / alpha<0.01 / userInteractionEnabled==NO 三个剪枝。
   语义依据：UIKit 的 hitTest 先做这三个判断，再逆序遍历 subviews、convertPoint 后递归。 [自写] */
static UIView *IOSTouchForceHitTest(UIView *view, CGPoint pointInView) {
    if (!CGRectContainsPoint(view.bounds, pointInView)) return nil;
    for (UIView *sub in [view.subviews reverseObjectEnumerator]) {   /* 逆序 = 后加的在上层 */
        if (sub.hidden == YES && NO) continue;                        /* 故意不剪枝 */
        CGPoint p = [view convertPoint:pointInView toView:sub];
        UIView *hit = IOSTouchForceHitTest(sub, p);
        if (hit) return hit;
    }
    return view;
}
static UIView *IOSTouchForceHitTestInWindow(UIWindow *window, CGPoint pointInWindow) {
    return IOSTouchForceHitTest(window, [window convertPoint:pointInWindow fromView:nil]);
}
```

**KIF 在 iOS 18 上加的 `_UIHitTestContext` 变体（逐字）** `[源码]` —— 用于 SwiftUI 层级：

```objc
// 注释逐字: "Beginning with iOS 18, there is `_UIHitTestContext` structure introduced for hit testing
//            SwiftUI views. This method tries to mimic that behaviour."
- (UIView *)kif_getHitTestViewInWindow:(UIWindow *)window atPoint:(CGPoint)point
{
    UIView *hitTestView = [window hitTest:point withEvent:nil];

    if (@available(iOS 18.0, *)) {
        static Class UIHitTestContextClass;
        static SEL contextWithPointAndRadiusSel;
        static BOOL canCreateContext = NO;
        static BOOL canHitTestWithContext = NO;
        static dispatch_once_t onceToken;
        dispatch_once(&onceToken, ^{
            UIHitTestContextClass = NSClassFromString(@"_UIHitTestContext");
            contextWithPointAndRadiusSel = NSSelectorFromString(@"contextWithPoint:radius:");
            canCreateContext = [UIHitTestContextClass respondsToSelector:contextWithPointAndRadiusSel];
            canHitTestWithContext = [[UIView class] instancesRespondToSelector:@selector(_hitTestWithContext:)];
        });

        if (canCreateContext && canHitTestWithContext) {
            id hitTestContext = ((id (*)(id, SEL, CGPoint, CGFloat))objc_msgSend)(
                UIHitTestContextClass, contextWithPointAndRadiusSel, point, 0);
            id foundResponder = NULL;
            UIView *currentView = hitTestView;
            while (foundResponder == NULL && currentView != NULL) {
                foundResponder = [currentView _hitTestWithContext:hitTestContext];
                currentView = [currentView superview];
            }
            return foundResponder ?: hitTestView;
        }
    }
    return hitTestView;
}
// 注释逐字: "From observation - this can be either of following types: - UIView type (e.g. when using
//   UIViewRepresentable inside SwiftUI), - specialized SwiftUI view compatible with UIView,
//   - newly introduced structure SwiftUI.UIKitGestureContainer implementing UIResponder interface.
//   What's important it seems it is compatible with setView:(UIView *) method."
```
> 相关 PR：`kif-framework/KIF#1323 "iOS 18 touch injection hit testing fix for SwiftUI view hierarchies"`（2025-02-06）。`[社区]`

### 4.2 让「点到了但没反应」变成「有反应」的三条路（按可靠性排序）

1. **`sendEvent:` 真事件（§3）** —— 唯一被证实能驱动 `UIGestureRecognizer` 的路。Reticle 在 iOS 26 上实测 *"Hit-testing, gesture recognizers, scroll views and momentum all behave as they do under one"*。`[社区]`
2. **`-[UIControl sendActionsForControlEvents:]`** —— 公开 API。`[文档]`
   ```objc
   if ([v isKindOfClass:[UIControl class]]) {
       UIControl *c = (UIControl *)v;
       if (c.isEnabled) {                                   // sendActions 不会帮你检查 isEnabled
           [c sendActionsForControlEvents:UIControlEventTouchDown];
           [c sendActionsForControlEvents:UIControlEventTouchUpInside];
       }
   }
   ```
   缺点：**不驱动 `UIButton` 的高亮**（`isHighlighted` 不会变），因为 UIControl 的 tracking 循环没跑；`UIControlEventTouchUpOutside` 语义也拿不到（没有坐标）。
3. **手动跑 tracking 循环** —— `[未找到]`：我**没有**任何源码证据表明 `beginTrackingWithTouch:withEvent:` + `endTrackingWithTouch:withEvent:` 手动调用就一定会触发 `UIButton` 的 action（这取决于 `UIButton` 的私有实现）。`UIControl` 的公开文档只说这三个方法「由 UIKit 在触点进入/移动/离开时调用」。**若要用，必须自己实验验证，并注意与 `sendActionsForControlEvents:` 二选一（同时用会双触发）。**

**明确不行的做法**（`[未找到]`/`[自写]` 推理）：
- 只 `[view touchesBegan:touches withEvent:event]` 直接调，绕过 `sendEvent:` → **hit-test 与 gesture recognizer 全不参与**；对 AIR 这类自己实现 `touchesBegan:` 的 view 可能有用，但 `UIButton` 一定不响应（它的 action 走 tracking，不走 `touchesBegan:`）。
- 只改 `UITouch` 的 `view`/`location` 而不 `[app sendEvent:]` → 什么都没发生。
- 对 `userInteractionEnabled == NO` 的 view 用 `hitTest:withEvent:` 再 `sendEvent:` → `hitTest` 返回 nil（或其祖先），`UITouch.view` 为空，事件被丢弃。必须用 §4.1 的强制命中 **并且** 你自己的 §4.2-2 分支。

---

## §5 五个指定问题的证据

### Q1. `-[UIApplication _enqueueHIDEvent:]` 在 iOS 18 上还存在吗？

**存在，且 Apple 自己在用；但「存在」≠「有效」。**
- `[源码]` **Apple WebKit `main` 分支至今**（`Tools/WebKitTestRunner/ios/HIDEventGenerator.mm:556`）：
  ```objc
  [[UIApplication sharedApplication] _enqueueHIDEvent:strongEvent.get()];
  ```
  同一文件 `:542` 用 `[UIApplication sharedApplication].keyWindow._contextId`，`:544` 用 `BKSHIDEventSetDigitizerInfo(...)`。**没有任何 `@available` 版本分支、没有回退**。
- `[社区]` `KQAR/Reticle#281`（2026-08，iPhone 13 Pro Max / iOS 26）：*"`UIApplication` answers both `_enqueueHIDEvent:` and `_handleHIDEvent:`"* —— 但同一路 **routed nowhere**。
- `[社区]` `ignuslabs/TouchSimulator-iOS16#1`：*"WebKit/main HIDEventGenerator.mm confirms `BKSHIDEventSetDigitizerInfo`, `_enqueueHIDEvent:`, `_contextId` remain stable on iOS 16+."*
- `[社区]` `google/EarlGrey#293`（khandpur，2016）：*"doesn't work for all the supported platform versions. Also, it doesn't work on devices due to entitlement issues."*
- `[未找到]`：任何声称「iOS 18 上 `_enqueueHIDEvent:` 被移除/改名」的证据。**没有**。

### Q2. `IOHIDEventSystemClientDispatchEvent` 能不能在**任意 App 进程内**（非越狱、无特殊 entitlement）用？

**越狱：有正面证据（但证据链薄）；非越狱：社区明确说不行。**
- `[源码]` `ignuslabs/TouchSimulator-iOS16/TouchSimulator.xm:166`，跑在**目标 App 进程内**的 tweak dylib 里：
  ```objc
  IOHIDEventSetSenderID(event, gSenderID);
  if (ioSystemClient) IOHIDEventSystemClientDispatchEvent(ioSystemClient, event);
  ```
  同一文件 `:125` 的注释：*"Must schedule on the run loop — without this the Mach port source is never registered and `IOHIDEventSystemClientDispatchEvent` **silently fails to deliver events on iOS 15+**."*
  同文件 `:12-24` 注释：*"Read real Multitouch ID from IORegistry so the kernel accepts the event as coming from the actual digitizer hardware. … **sandboxed processes such as PosterBoard and wallpaper extensions are denied by sandbox** … The placeholder is preserved … (2) sandboxed processes have no UIWindow, so the dispatch path falls through `getKeyWindow() == nil` and only fires the system-wide `IOHIDEventSystemClient` send — **where the kernel does not gate on senderID matching the digitizer service**."*（**这是仓库作者注释，我没有独立验证**）
- `[源码]` 反面证据：`iolate/SimulateTouch`（512★，最经典的 HID 注入）**整个实现跑在 SpringBoard 里**（`MSInitialize` + `CFMessagePortCreateLocal("kr.iolate.simulatetouch")` + rocketbootstrap），`MSHook(Boolean, IOHIDEventSystemOpen, ...)` 才拿到 `original_callback`；iOS 6 路甚至直接 `original_callback(NULL,NULL,NULL, handEvent)`。客户端是另一个进程，通过 Mach port 发消息。`extern "C" { ... }` 那段注释写着 `// ============= from veency`（Veency 同样是 SpringBoard 里的 VNC 服务）。→ **最经典的两条 HID 注入实现（SimulateTouch / Veency）都是系统进程实现，不是 App 进程内实现。**
- `[源码]` `IOS13-SimulateTouch`（ZXTouch，1407★）README：*"A **system wide** touch event simulation library for iOS 11.0 - 14."*；核心 `pccontrol/Touch.h` 暴露的是 `postIOHIDEvent(IOHIDEventRef)` + `initSenderId()` + `startSetSenderIDCallBack()`，真正的注入端（`zxtouchd`）只是往 SpringBoard 的 6000 端口发 socket（`main.mm`）。**同样是 SpringBoard 侧。**
- `[社区]` `cysp/IOHIDPlayground#1`（2014，open）：`kazzmir`：*"I am trying to do something similar to IOHIDPlayground, but it seems that sending events via `IOHIDEventSystemClientDispatchEvent` has no affect. I have experimented with creating events in a plethora of ways to no avail. I think that testmanagerd, the daemon XCTest uses to send events, internally uses the same IOHID* api and it can successfully be used to simulate touch events (see the WebDriverAgent project). Perhaps there is some unique attribute that must be applied to events for the IOHID subsystem to properly handle, otherwise they get **silently tossed out**."*
- `[未找到]`：`com.apple.private.hid.client.event-dispatch` 之类 entitlement 的**权威**清单。`IOS13-SimulateTouch/layout/entitlements.plist` 只给了宿主 App 用的三项（`platform-application` / `com.apple.private.skip-library-validation` / `com.apple.private.security.no-container`），**这是给容器 App 的，不是给注入用的**。

**结论**：非越狱 = 不要指望；越狱 = 可作第二条腿，但**必须**用 §2.5 的 marker 探针确认，且优先 `_enqueueHIDEvent:`。

### Q3. Adobe AIR / OpenGL ES 游戏：进程内合成触摸能不能进 AIR 自己的手势处理？

**`[未找到]` 直接证据。** 我做了这些搜索，全部无结果/无关：
- GitHub issue 搜索 `Adobe AIR iOS synthetic touch`（11 条，全无关）、`Adobe AIR iOS XCTest automation`（4 条，全无关）、`EAGLView touch injection iOS`（2 条，CodenameOne）、`repo:airsdk/Adobe-Runtime-Support XCTest`（0 条）、`repo:airsdk/Adobe-Runtime-Support UIAutomation`（0 条）、`repo:kif-framework/KIF Unity OpenGL`（0 条）。
- 唯一沾边：`[社区]` `airsdk/Adobe-Runtime-Support#3375 "iOS App running on Mac: TouchEvent.TOUCH_END events stop firing after right-click"` —— 说明 AIR 的 iOS 运行时把 UIKit 触摸转成 `flash.events.TouchEvent`，但这是 **Mac 上跑 iOS App** 的场景，不能外推。
- **可以确认的机制事实**（`[源码]`，来自 KIF 与 WebKit）：`-[UIApplication sendEvent:]` 就是 UIKit 自己投递手指事件的入口，`UITouch`/`UIEvent` 对象在 responder 链与 gesture recognizer 看来与真实手指同构。所以「AIR 是 UIView 子类、AIR 只通过 UIKit 拿触摸」这一点成立的话，§3 路就能到达 AIR；**但「AIR 只通过 UIKit 拿触摸」我没有源码证据**。
- **现场验证方案（建议先做，5 分钟）**：
  1. `NSLog` 打印 `[window hitTest:p withEvent:nil]` 与它的 `class` / `superview` 链 —— 确认命中链最底层是否就是 AIR 的 `UIView` 子类（AIR 的 iOS 根视图类名会直接暴露）。
  2. `swizzle -[UIApplication sendEvent:]` 打印真实手指时 `event.allTouches` / `touch.view` —— 确认真实手指到达的那一层和你合成时命中到的那一层是同一个。
  3. 若不一致：用 §4.1 强制命中 + §3 构造 `UITouch` 时把 `setView:` 手动设成那一层。

### Q4. `UITouch` / `sendEvent:` 路要求 `userInteractionEnabled == YES` 吗？

**要求。** 三条证据：
1. `[文档]` Hammer README 的 `HammerError` 说明逐字：*"…the view is in the hierarchy but is not currently visible on screen, so it's not possible to generate touches for it. Make sure the view is within visible bounds, not covered by other views, **not hidden, and with alpha greater than 0.01**."* 以及 *"…visible on screen but is not currently able to receive touches. Make sure the view **reponds to hit test in its center coordinate and user interaction is enabled**."*
2. `[源码]` KIF 专门写了 `isUserInteractionActuallyEnabled` 来绕这个坑，注释逐字：*"Somtimes views are inside a UIControl and don't have user interaction enabled. // Walk up the hierarchary evaluating the parent UIControl subclass and use that instead."* —— 即：KIF 自己也知道这不是它能改的，只能**向上找父控件**。
3. `[源码]` 两条路都靠 `hitTest:withEvent:` 决定 `UITouch.view`（KIF/PTFakeTouch 的 `initAtPoint:inWindow:`）或由 UIKit 内部做同一件事（`_enqueueHIDEvent:` 路）。
   **→ 只要 `hitTest:` 返回 nil 或其祖先，`UITouch.view` 就不是游戏视图，两条路一起失败。** 唯一解法是 §4.1 强制命中 + §4.2 的 `sendActionsForControlEvents:`。

### Q5. 30ms 连点的限流 / 合并（coalescing）问题

**没有找到「系统限流 30ms」的证据**；能找到的是各仓库的**实测节奏常量**，它们都在 30ms 以下工作：
- `[源码]` WebKit：`fingerMoveInterval = 0.016`（62.5 Hz，16ms）；`fingerLiftDelay = 0.05`（按下→抬起 50ms）；`multiTapInterval = 0.15`（双击间隔 150ms）；`longPressHoldDelay = 2.0`。节流实现是 `nanosleep`：
  ```objc
  double delay = (eventIndex * fingerMoveInterval) - elapsed;
  if (delay > 0) { struct timespec moveDelay = { 0, static_cast<long>(delay * nanosecondsPerSecond) }; nanosleep(&moveDelay, NULL); }
  ```
- `[源码]` Hammer：`fingerLiftDelay = 0.05`、`multiTapInterval = 0.15`、`fingerMoveInterval = 1/60`（16.7ms）、`longPressHoldDelay = 2.0`。
- `[源码]` KIF：`#define DRAG_TOUCH_DELAY 0.01`（10ms，`CFRunLoopRunInMode(UIApplicationCurrentRunMode, DRAG_TOUCH_DELAY, false)`）；`longPressAtPoint:` 期间按 `DRAG_TOUCH_DELAY` 发 `UITouchPhaseStationary` 心跳。
- `[源码]` WebKit 的 **marker/ack 机制**（`sendMarkerHIDEventWithCompletionBlock:`）说明 Apple 自己也不相信「发了就算送达」——他们用 vendor-defined 事件回来做栅栏。Hammer 抄了同一套（`waitForEvents()` / `sendMarkerEvent`）。**这本身就是「事件可能被合并/丢弃」的官方级证据。**
- **真正会咬人的是时间戳**（`[源码]` 推导）：事件时间戳是**构造时** `mach_absolute_time()` 取的，而 `_enqueueHIDEvent:` 可能被 `dispatch_async` 延后执行。WebKit 的 tap 就是：构造 down（ts=T）→ `dispatch_async` → `nanosleep(50ms)` → 构造 up（ts=T+50ms）→ `dispatch_async`；两个 block 可能在 runloop 恢复后**背靠背**执行。**按压时长由时间戳决定，不是由投递间隔决定。** 所以 `simulated_tap(p, 0.03)` 想要 30ms 按压，必须真的 sleep 30ms 再构造 up。
- `[未找到]`：iOS 对合成触摸的官方速率上限；`IOHIDEventSystemClient` 的队列深度限制；「30ms 连点被系统合并」的任何实证。

---

## §6 坑清单（每条带标签）

| # | 坑 | 后果 / 检测 | 标签 |
|---|---|---|---|
| 1 | HID 事件在非越狱 App 内**静默无效**：`respondsToSelector:` 与 `dlsym` 全 YES，调用无异常 | 完全没反应，无日志。**必须**用 §2.5 marker 探针 | `[社区]` |
| 2 | `_enqueueHIDEvent:` on-device 有 **entitlement 问题**（EarlGrey 结论） | 同上 | `[社区]` |
| 3 | `IOHIDEventSystemClientDispatchEvent` 在 iOS 15+ 若没 `IOHIDEventSystemClientScheduleWithRunLoop(client, CFRunLoopGetMain(), kCFRunLoopDefaultMode)` | **静默不投递** | `[源码]`（仓库注释） |
| 4 | `IOHIDEventSetSenderID` 用 0 | 被丢弃。Hammer: "Can be any value except 0" | `[源码]` |
| 5 | senderID 与真实 digitizer 不匹配 | 内核可能不认（ignuslabs 从 IORegistry 读 `AppleMultitouchDevice` 的 `"Multitouch ID"`；沙箱进程读不到会回退 `0xDEFACEDBEEFFECE5`） | `[源码]`+`[未验证]` |
| 6 | 坐标空间搞错（0~1 归一化 vs window points） | 戳到屏幕外或左上角。`_enqueueHIDEvent:` 用 **window points**（WebKit `roundf`） | `[源码]` |
| 7 | finger 的 `MajorRadius/MinorRadius` 设成 0 或 0.04 | ignuslabs 注释：0.04 会被 OS 判为噪声；用 **5.0** | `[源码]` |
| 8 | `hand` 事件忘了 `kIOHIDEventFieldDigitizerIsDisplayIntegrated = 1` | 三个仓库**全部**都设了（KIF/WebKit/Hammer/ignuslabs），不设基本无效 | `[源码]` |
| 9 | 手势被打断后残留手指 | 内核触摸跟踪器卡在多指状态 → 后续事件被当成多指。用 `simulated_hand_reset()`（零触点 hand 事件） | `[源码]` |
| 10 | iOS 9 起 `UITouch` 必须设 `_setHidEvent:` | KIF/PTFakeTouch 同注释："Starting with iOS 9, internal IOHIDEvent must be set for UITouch object" | `[源码]` |
| 11 | iOS 14 起 flags 分支不同 | PTFakeTouch：`>= iOS 14` 用 `_setIsTapToClick:NO`；否则 `_setIsFirstTouchForView:YES` + `setIsTap:NO`（KIF master 还额外直接写 `_touchFlags` ivar 的 bit0，`char *flags = (__bridge void *)self + ivar_getOffset(flagsIvar); *flags |= 0x01;`） | `[源码]` |
| 12 | `setWindow:` 必须**第一个**调 | KIF 注释："Wipes out some values. Needs to be first." 顺序错了 location/view 被清空 | `[源码]` |
| 13 | 抬起事件必须复用**同一个** `UITouch` 对象 | 新建对象会丢 identity/窗口/视图，`sendEvent:` 路直接失效（PTFakeTouch 用 `touchAry` 缓存复用） | `[源码]` |
| 14 | 键盘是**另一个 window**（`UIRemoteKeyboardWindow` / `_UIRemoteKeyboardPlaceholderView`） | 点不到键盘。PTFakeTouch 有专门的键盘分支；KIF 有 iOS 16 的 `_fallbackView` workaround | `[源码]` |
| 15 | 目标 view 的 `userInteractionEnabled == NO` / `hidden` / `alpha < 0.01` | `hitTest:` 返回 nil → 两条路同时失效。检测：打印 `[window hitTest:p withEvent:nil]` | `[文档]`+`[源码]` |
| 16 | iOS 18 SwiftUI 层级 `hitTest:` 命中错误 | 用 KIF 的 `_UIHitTestContext` 走查（`contextWithPoint:radius:` + `_hitTestWithContext:`，从命中点向上遍历 superview） | `[源码]`+`[社区]` |
| 17 | iOS 16+ 需要 `BKSHIDEventDigitizerAttributes.activeModifiers` 才能模拟修饰键 | WebKit 注释逐字："As of iOS 16, this is necessary in order for sythesized gestures to properly simulate keyboard modifier state (for instance, when shift-tapping)." | `[源码]` |
| 18 | 不等「事件真的被 App 处理」就发下一条 | EarlGrey 明确说没有可靠等待手段 → 合成点击要么用 marker 栅栏，要么靠 `pressDuration` 真 sleep | `[社区]` |
| 19 | `sendActionsForControlEvents:` 不检查 `isEnabled`、不驱动高亮 | 需要自己判 `isEnabled`；`isHighlighted` 不会变 | `[文档]` |
| 20 | 同时用 `sendActionsForControlEvents:` 和 `beginTracking/endTracking` | 可能双触发 action | `[自写]` 推理 |
| 21 | rootless 打包：包架构必须是 `iphoneos-arm64`、`THEOS_PACKAGE_SCHEME=rootless` | 装错 `.deb` 会**静默**把文件放到错误前缀（ignuslabs 的 `postinst` 专门做了检测） | `[源码]` |
| 22 | AIR 是否会响应，取决于真实手指到达哪一层 | 见 §5-Q3 的三步现场验证 | `[未找到]` |

**失败检测清单（照抄进你的代码）**
```objc
NSLog(@"[IOSTouch] env: enqueue=%d ctx=%d bks=%d ctors=%d keyWindow=%@ hitTest=%@",
      [app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")],
      [w respondsToSelector:NSSelectorFromString(@"_contextId")],
      dlsym(RTLD_DEFAULT, "BKSHIDEventSetDigitizerInfo") != NULL,
      dlsym(RTLD_DEFAULT, "IOHIDEventCreateDigitizerEvent") != NULL,
      NSStringFromClass(w.class),
      NSStringFromClass([w hitTest:p withEvent:nil].class));
```
（`[源码]` ignuslabs 的 DEBUG 探针就是这四项 + `senderID`，只是它用 `respondsToSelector:`/`dlfound`。）

---

## §7 我**没能**确认的东西（不要建在这上面）

1. `[未找到]` **越狱 iOS 15.8.3 / palera1n rootless 上，进程内 HID 路的成功实证**。最接近的是 `ignuslabs/TouchSimulator-iOS16`（README/PR 声称 iOS 15/16 rootless 可用），但**我没有在真机上验证过它**，也没有第三方复现报告。
2. `[未找到]` `_enqueueHIDEvent:` 在设备上失败所需的**具体** entitlement 名称（EarlGrey 只说 "entitlement issues"）。
3. `[未找到]` `IOHIDEventSystemClientDispatchEvent` 在**越狱 App 进程内**（非 SpringBoard）的可靠成功率。
4. `[未找到]` Adobe AIR / OpenGL ES 对进程内合成触摸的**任何**直接证据（正反都没有）。§5-Q3 的机制分析是**推理**，不是证据。
5. `[未找到]` `UIButton` 的 action 到底在 `endTrackingWithTouch:withEvent:` 还是别处发出（因此 §4.2-3 那条路我标了「必须自己验证」）。
6. `[未找到]` iOS 对合成触摸事件的**速率上限 / 合并阈值**（30ms 连点的官方行为）。
7. `[未找到]` `lyft/Hammer` 的 ObjC 源码（**不存在**）；`KIF_findViewAtPoint:withEvent:`（**不存在**）。
8. `[未找到]` KIF 在 iOS 17/18 上 `_enqueueHIDEvent:` 相关的破坏性回归（KIF 根本不用它，所以查不到）。
9. `[未找到]` `zxcvbn/ZXTouch` 仓库本体（codeload 404）；我用的是 `xuan32546/IOS13-SimulateTouch`（README 自称同一血统、装成 `zxtouch.app`）。
10. `[未找到]` iOS 18/26 上 `_UIHitTestContext` 的**官方**语义（KIF 的注释自己写的是 "tries to mimic that behaviour"）。

---

## §8 引用的源文件 URL（全部可重新验证）

**Apple WebKit（权威参考实现，`main` 分支）**
- `https://raw.githubusercontent.com/WebKit/WebKit/main/Tools/WebKitTestRunner/ios/HIDEventGenerator.mm`（本地：`.research/_src/webkit/HIDEventGenerator.mm`，1272 行；关键行 `:43` SOFT_LINK 签名、`:137-148` 时序与 `fingerIdentifiers[]={2,3,4,5,1}`、`:353-426` `_createIOHIDEventWithInfo:`、`:428-531` `_createIOHIDEventType:`、`:533-559` `_sendHIDEvent:`、`:561-580` marker、`:703-730` `moveToPoints:`、`:818-830` `_waitFor:`、`:832-848` `sendTaps:`）
- `https://raw.githubusercontent.com/WebKit/WebKit/main/Tools/WebKitTestRunner/ios/HIDEventGenerator.h`（`HIDMaxTouchCount` 等）
- `Tools/WebKitTestRunner/ios/UIKitSPIForTesting.h`、`.../BackBoardServicesSPI.h` —— **本次抓取 404/429，未拿到**（WebKit 仓库太大，未下载整包）；`_enqueueHIDEvent:` 的权威声明请改看 `TouchSimulator.h`（下）

**KIF**
- `https://raw.githubusercontent.com/kif-framework/KIF/master/Sources/KIF/Classes/IOHIDEvent+KIF.m`（188 行，逐字原型 + `kif_IOHIDEventWithTouches`）
- `.../Sources/KIF/Include/IOHIDEvent+KIF.h`
- `.../Sources/KIF/Additions/UITouch-KIFAdditions.m`（184 行；`kif_getHitTestViewInWindow:atPoint:` 的 iOS 18 `_UIHitTestContext` 在 `:130-175` 附近）
- `.../Sources/KIF/Additions/UIEvent+KIFAdditions.m`（91 行，`_setGSEvent:`/`_setHIDEvent:`/`_setTimestamp:`）
- `.../Sources/KIF/Additions/UIApplication-KIFAdditions.m`（390 行，`kif_sendEvent:` = `[self sendEvent:event]`）
- `.../Sources/KIF/Additions/UIView-KIFAdditions.m`（1190 行，`tapAtPoint:` / `dragPointsAlongPaths:` / `isUserInteractionActuallyEnabled`）
- `.../Sources/KIF/Additions/UIWindow-KIFAdditions.m` —— **整个文件是注释**，`KIF_findViewAtPoint:withEvent:` 不存在
- PR：`https://github.com/kif-framework/KIF/pull/1323`（iOS 18 hit testing）

**Hammer（Swift！）**
- `https://raw.githubusercontent.com/lyft/Hammer/main/Sources/Hammer/AppleInternal/AppleInternal+IOHID.swift`
- `.../AppleInternal/AppleInternal+BackBoardServices.swift`（`CHIDEventSetDigitizerInfo` 的 7 参 typealias）
- `.../AppleInternal/AppleInternal+UIKit.swift`（`@objc(_enqueueHIDEvent:)` / `@objc(_contextId)` / `_handleHIDEvent:` swizzle）
- `.../EventGenerator/EventGenerator.swift`（`senderId = 0x0000000123456789`、`waitForEvents()`）
- `.../EventGenerator/EventGenerator+Hand/EventGenerator+Hand.swift`（588 行，`sendEvent(hand:)` 逐字）
- `.../EventGenerator/EventGenerator+Hand/HandInfo.swift`、`.../EventGenerator/EventGenerator+Marker.swift`、`.../Utilties/UIKit+Extensions.swift`
- `https://github.com/lyft/Hammer/blob/main/README.md`（"Swift 5.3 and iOS 11.0 or later"、`HammerError` 的两段说明）

**越狱 / user-mode 实现**
- `https://raw.githubusercontent.com/ignuslabs/TouchSimulator-iOS16/main/TouchSimulator.xm`（179 行，**本报告 §2 的主参考**：双路发送 + senderID 发现 + runloop 注释）
- `.../main/TouchSimulator.h`、`main/README.md`、`main/build.sh`
- `https://raw.githubusercontent.com/Ryu0118/TouchSimulator-iOS14/main/TouchSimulator.h`（`_enqueueHIDEvent:` / `_contextId` 声明）
- `https://github.com/Ryu0118/TouchSimulator-iOS14/issues/1`（编译错与正确声明）、`/issues/2`（`simulateTouch` + `postEvent` 全文）
- `https://raw.githubusercontent.com/iolate/SimulateTouch/master/SimulateTouch.mm`（385 行，`SendHIDEvent` / `SendTouchesEvent` / `MSInitialize` / `BKUserEventTimer`）
- `https://raw.githubusercontent.com/xuan32546/IOS13-SimulateTouch/master/pccontrol/Touch.h`（`postIOHIDEvent` / `initSenderId`）、`.../layout/entitlements.plist`、`.../zxtouch-binary/main.mm`、`.../README.md`
- `https://raw.githubusercontent.com/xuanxt/PTFakeTouch/master/PTFakeTouch/PTFakeMetaTouch.m`（96 行）+ `.../addition/UITouch-KIFAdditions.m`（176 行，含 iOS 9 / iOS 14 两个版本分支）

**Issue 证据**
- `https://github.com/KQAR/Reticle/issues/281`（2026-08，iOS 26 实测：HID 路 routed nowhere / `sendEvent:` 路可行）
- `https://github.com/google/EarlGrey/issues/293`（2016；"doesn't work on devices due to entitlement issues"）
- `https://github.com/ignuslabs/TouchSimulator-iOS16/issues/1`（iOS 15/16 rootless 双架构构建 + WebKit 引用）
- `https://github.com/cysp/IOHIDPlayground/issues/1`（2014：设备上 dispatch "silently tossed out"）
- `https://github.com/airsdk/Adobe-Runtime-Support/issues/3375`（AIR 的 `TouchEvent`，弱证据）

**本次抓取失败（如需重试）**：`raw.githubusercontent.com` 在连续请求下返回 429（需间隔 ≥5s）；`codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>` 稳定可用（推荐）；`api.github.com/search/issues?q=...` 未认证可用（约 10 次/分钟）。
