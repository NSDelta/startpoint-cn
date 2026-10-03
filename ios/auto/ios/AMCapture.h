//
//  AMCapture.h —— 取帧（iOS 平台层）
//
//  目标客户端 worldflipper 是 Adobe AIR + OpenGL ES2 + Stage3D 应用，所以真帧只能从
//  GL 的默认 framebuffer 读：hook -[EAGLContext presentRenderbuffer:]，在里面 glReadPixels。
//  drawViewHierarchyInRect: 对 GL 内容会给出黑帧，是**兜底**不是主路。
//
//  输出固定是 **8 位灰度、无补白、行距 = 宽**，正好可以直接喂 am_gray（core/auto_match.h）：
//
//      am_gray g = { buf, w, h, w };
//
//  取帧是**异步**的：hook 只能在自己的线程里被调用，而引擎在别的线程跑。
//  所以 AMCapture 维护「最新一帧」并用锁保护；-latestGrayInto: 是快照语义（不阻塞取帧线程）。
//
//  关于方向：.auto 的坐标活在**竖屏**像素空间里（游戏本身锁定竖屏）。本类不旋转、
//  不猜测，读到的 framebuffer 什么样就交付什么样，并把尺寸报给调用方 —— 由 AMRuntime
//  决定这块像素是否与脚本的录制朝向一致（不一致要显式记录，不要静默匹配）。
//

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// 只前向声明：本头文件不把 UIKit 拉进来，方便在纯 Foundation 环境（测试、命令行工具）里
// 也能 include 它做类型检查。实现文件（.m）自己 import UIKit。
@class UIImage;

NS_ASSUME_NONNULL_BEGIN

/// 取帧后端。runtime 用 -backendName 报告当前实际生效的那个。
typedef NS_ENUM(NSInteger, AMCaptureBackend) {
    AMCaptureBackendNone = 0,   ///< 还没成功抓到过一帧
    AMCaptureBackendGL,         ///< hook EAGLContext presentRenderbuffer + glReadPixels（期望值）
    AMCaptureBackendHierarchy,  ///< drawViewHierarchyInRect:（兜底；对 GL 内容可能黑帧）
};

/// 取帧统计。全部是只读快照，供面板与诊断用。
typedef struct {
    unsigned long long frames;       ///< 成功交付的帧数
    unsigned long long dropped;      ///< 因为「上一帧还没被取走」而丢掉的帧数
    double lastReadMs;               ///< 上一次 glReadPixels + 降采样的耗时（毫秒）
    double maxReadMs;                ///< 历史最大（判断会不会拖慢渲染线程）
    int width, height;               ///< 最近一帧的尺寸（像素）
} AMCaptureStats;

@interface AMCapture : NSObject

/// 单例。第一次取用时装 hook（+load 也调一次，确保每帧都被观察到）。
+ (instancetype)shared;

/// 装上 hook。幂等；重复调用无副作用。+load 会自动调它，
/// 显式调用只是为了让「什么时候开始观察」在日志里可见。
- (void)install;

/// 是否已经成功抓到过至少一帧（决定引擎能不能开跑）。
@property (nonatomic, readonly) BOOL hasFrame;

/// 当前生效的后端。
@property (nonatomic, readonly) AMCaptureBackend backend;
- (NSString *)backendName;

/// 最近一帧的尺寸；还没有帧时是 CGSizeZero。
@property (nonatomic, readonly) CGSize frameSize;

/// 只取尺寸（便宜，不拷贝像素）。
- (BOOL)latestSize:(out CGSize *)outSize;

/// 把「最新一帧」按最近邻降采样成 outW x outH 的 8 位灰度，写进 out（必须 >= outW*outH 字节）。
/// 返回 YES 表示写满了；NO 表示还没有帧、或尺寸非法、或 out 太小。
///
/// 语义是**快照**：拿的是调用瞬间的那一帧，之后取帧线程怎么写都不影响已经拷出来的内容。
/// 同一帧被取两次是允许的（引擎的帧号缓存会因此正确地复用匹配结果）。
- (BOOL)latestGrayInto:(unsigned char *)out width:(int)outW height:(int)outH;

/// 低分辨率预览（给面板显示用）。返回一张新解码的 UIImage，没有帧时返回 nil。
- (nullable UIImage *)previewImage;

/// 统计快照。
- (AMCaptureStats)stats;

/// 被 hook 的 presentRenderbuffer 调用计数。单调递增；用它判断「游戏还在渲染吗」。
@property (nonatomic, readonly) unsigned long long presentCalls;

/// 测试与诊断：手工喂一帧（不经过 GL）。用于在没有游戏的进程里验证下游链路。
- (void)acceptForeignFrame:(const unsigned char *)gray width:(int)w height:(int)h;

@end

NS_ASSUME_NONNULL_END
