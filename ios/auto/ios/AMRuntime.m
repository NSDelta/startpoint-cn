//
//  AMRuntime.m —— 引擎 ↔ iOS 平台层
//
//  ── 帧从哪来、点到哪去：一条坐标链，任何一环错了都点不中 ──────────────────
//
//      GL 默认 framebuffer            1242 x 2208 像素（iPhone 7 Plus 的"逻辑分辨率"）
//        │  AMCapture -latestGrayInto:width:height:   （快照，最近邻降采样）
//        ▼
//      引擎帧（8 位灰度，行距 = 宽）   **与 framebuffer 同尺寸**
//        │  am_engine 在【当前屏幕像素空间】里算出点击点
//        ▼
//      点击点 (px, py) 单位 = 帧像素
//        │  AMTouch -windowPointFromScreenPixels:  = 除以 (帧宽 / 窗口点宽)
//        ▼
//      窗口点 (pt) → UITouch
//
//  关键：**引擎的 width/height 必须等于 framebuffer 的尺寸**，不是窗口点宽高。
//  脚本坐标被 core/auto_script.c 适配到"当前屏幕"，那个"当前屏幕"就是引擎尺寸。
//  如果这里填错（比如填了 414x736 的点尺寸），搜到的是 1/3 缩放的图，
//  点击点再被除以 3 ⇒ 落点偏到屏幕左上角三分之一处。
//
//  同理 density 也不能乱填，见 AMRuntime.h 的说明。
//

#import "AMRuntime.h"
#import "AMCapture.h"
#import "AMTouch.h"
#import "AMConfig.h"

#import <UIKit/UIKit.h>
#import <os/lock.h>
#include <stdarg.h>

#include "auto_engine.h"
#include "auto_script.h"

#pragma mark - 引擎线程上下文

@interface AMRuntime ()
{
    am_script  *_script;         /* 堆分配，350 KB —— 绝不能放栈上 */
    am_engine  *_engine;

    volatile int _wantStop;
    volatile int _threadUp;
    NSThread    *_thread;

    int    _frameW, _frameH;
    double _density;
    int    _rounds;
    int    _unsupported;
    BOOL   _screenLocked;        /* 帧尺寸/密度已定，之后不许再变 */
    int    _scene;               /* 引擎线程写、其它线程读 —— 用 _stateLock 护住 */

    NSMutableArray<NSString *> *_tapLog;

    os_unfair_lock _stateLock;   /* 护 _tapLog 与 _scene */
}

/* 这三个在 AMRuntime.h 里是 readonly，实现里要往它们赋值，所以必须在 class extension
 * 里「升级」成 readwrite —— clang 允许这种升级，而且只有 extension 能看见 setter。
 *   ★ 但**修饰符必须与头里逐字一致**，多一个少一个都会报：
 *        error: illegal redeclaration of 'readwrite' property in class extension 'AMRuntime'
 *     `scriptPath` / `scriptName` 头里写的是 `readonly, nullable`（**没有 copy**），
 *     所以这里也不能写 copy；`lastError` 头里有 copy，这里就得有 copy。
 *   ★ `paused` **不在这里**：它在头里已经是 readwrite，重复声明同一个修饰符同样触发
 *     上面这条错误（第一次真实 iOS 编译时报的就是 paused 那一行）。 */
@property (nonatomic, readwrite) AMRuntimeState state;
@property (nonatomic, readwrite, copy, nullable) NSString *lastError;
@property (nonatomic, readwrite, nullable) NSString *scriptPath;
@property (nonatomic, readwrite, nullable) NSString *scriptName;
@end

@implementation AMRuntime

+ (instancetype)shared
{
    static AMRuntime *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[AMRuntime alloc] init]; });
    return s;
}

- (instancetype)init
{
    if ((self = [super init])) {
        _stateLock = OS_UNFAIR_LOCK_INIT;
        _state = AMRuntimeStateIdle;
        _screenLocked = NO;
        _tapLog = [NSMutableArray arrayWithCapacity:AM_MAX_TAPS];
        /* 尽早把取帧 hook 装上：游戏的第一个画面可能早于面板出现。 */
        [[AMCapture shared] install];
    }
    return self;
}

#pragma mark - 脚本发现

+ (NSArray<NSString *> *)discoverScripts
{
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableArray<NSString *> *dirs = [NSMutableArray array];

    /* 1. Documents/AutoClick —— 用户通过 iTunes 文件共享 / Files.app 放进去的。
          放在最前面：这是用户能自己往里丢脚本的地方，应当优先。 */
    NSArray<NSString *> *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    if (docs.count > 0) {
        [dirs addObject:[docs[0] stringByAppendingPathComponent:@"AutoClick"]];
    }

    /* 2. Library/Application Support/AutoClick —— 程序自己解包/下载脚本时写这里。 */
    NSArray<NSString *> *appsup = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    if (appsup.count > 0) {
        [dirs addObject:[appsup[0] stringByAppendingPathComponent:@"AutoClick"]];
    }

    /* 3. main bundle —— 注入 dylib 时可以把脚本一起塞进 app 包里当默认脚本。 */
    NSString *bundle = [NSBundle mainBundle].bundlePath;
    if (bundle.length > 0) [dirs addObject:bundle];

    NSMutableArray<NSString *> *found = [NSMutableArray array];
    for (NSString *dir in dirs) {
        BOOL isDir = NO;
        if (![fm fileExistsAtPath:dir isDirectory:&isDir] || !isDir) continue;
        NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:dir error:NULL];
        for (NSString *name in [names sortedArrayUsingSelector:@selector(compare:)]) {
            if (![[name pathExtension].lowercaseString isEqualToString:@"auto"]) continue;
            [found addObject:[dir stringByAppendingPathComponent:name]];
        }
    }
    return found;
}

#pragma mark - 屏幕参数

- (void)log:(NSString *)fmt, ...
{
    va_list ap;
    va_start(ap, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    NSLog(@"[AMRuntime] %@", msg);
}

/// 合成 densityDpi。见头文件：必须是 nativeScale*160，不是 scale*160。
+ (double)syntheticDensityForScale:(double)scale
{
    if (scale <= 0) scale = 1.0;
    return scale * 160.0;
}

/// 当前帧缓冲像素 → 点 的除数。优先用 AMTouch 的现算值（帧宽/窗口点宽）。
- (double)currentPixelScale
{
    CGFloat s = [[AMTouch shared] pixelToPointScaleInWindow:nil];
    if (s > 0) return (double)s;
    /* 还没抓到帧时，AMTouch 会退回 screen.nativeScale；再不行就当 1.0。 */
    return 1.0;
}

#pragma mark - 加载

- (void)teardownEngine
{
    /* 线程必须先停：它会读 _engine。 */
    [self stop];

    if (_engine) { am_engine_free(_engine); free(_engine); _engine = NULL; }
    if (_script) { am_script_free(_script); free(_script); _script = NULL; }
    _rounds = 0;
    _unsupported = 0;
    _screenLocked = NO;
    _frameW = _frameH = 0;
    _density = 0;
    os_unfair_lock_lock(&_stateLock);
    [_tapLog removeAllObjects];
    _scene = -1;
    os_unfair_lock_unlock(&_stateLock);
    self.scriptName = nil;
}

- (BOOL)loadScriptAtPath:(NSString *)path
{
    if (path.length == 0) {
        self.lastError = @"脚本路径为空";
        self.state = AMRuntimeStateFailed;
        return NO;
    }
    [self teardownEngine];
    self.state = AMRuntimeStateLoading;
    self.lastError = nil;

    am_script *s = (am_script *)calloc(1u, sizeof(am_script));
    if (!s) {
        self.lastError = @"am_script 分配失败（需要 350 KB）";
        self.state = AMRuntimeStateFailed;
        return NO;
    }
    /* 路径版加载：am_script_load_auto 自己开 ZIP、读 script.json、
       把模板 PNG 解出来（模板的**像素**是惰性渲染的，见 am_script_template）。 */
    am_script_init(s, NULL);

    am_screen screen;
    if (_screenLocked) {
        /* 已经抓过帧：直接用已知的屏幕参数，省掉一次 set_screen 的缓存失效。 */
        am_screen_make(&screen, _frameW, _frameH, (int)(_density + 0.5));
    } else {
        /* 还不知道帧尺寸：先用一个占位，start 时 prepareScreenLocked 会重设。
           注意这里**不能**用 0（会除零），am_screen_make 会 clamp 到 1。 */
        am_screen_make(&screen, 1, 1, (int)([AMRuntime syntheticDensityForScale:[self currentPixelScale]] + 0.5));
    }

    if (am_script_load_auto(s, path.fileSystemRepresentation, &screen) != 0) {
        self.lastError = [NSString stringWithFormat:@"解析脚本失败：%s", s->error];
        am_script_free(s);
        free(s);
        self.state = AMRuntimeStateFailed;
        return NO;
    }

    _script = s;
    self.scriptPath = path;
    self.scriptName = [NSString stringWithUTF8String:s->header.name].length > 0
                    ? [NSString stringWithUTF8String:s->header.name]
                    : path.lastPathComponent;

    /* 空间不够时 core 只记账不崩：这里必须报出来，不能当没发生。 */
    if (am_script_overflowed(s)) {
        [self log:@"警告：脚本超出容量上限，部分内容被丢弃（模板组/变体/变量/场景/事件/条件/动作）"];
    }

    /* 「录制屏幕」取自模板组/裁切各自的 screen_info —— **不是** script.header，
       也不是 script.screen：
         · am_script_header 里根本没有 screen 字段（写 header.screen 是编译错误）；
         · am_script.screen 是**当前**屏幕（am_script_load_auto 传进去的那个），
           am_script_set_screen 会直接覆盖它，所以它永远不是录制值。
       录制信息在 am_template_variant::screen / am_crop::screen 里（am_screen_info）。
       一个模板组都没有时就不打这一段 —— 宁可不打，也不要打一个错的数字。 */
    if (s->template_group_count > 0) {
        const am_screen_info *rec = &s->groups[0].variants[0].screen;
        [self log:@"已加载 %@：%d 个模板组 / %d 个变量 / %d 个场景，loop_interval=%.0fms（录制于 %dx%d @%.0f，取自模板组 0）",
              self.scriptName, s->template_group_count, s->var_count, s->scene_count,
              s->header.loop_interval * 1000.0,
              rec->width, rec->height, rec->density];
    } else {
        [self log:@"已加载 %@：0 个模板组 / %d 个变量 / %d 个场景，loop_interval=%.0fms",
              self.scriptName, s->var_count, s->scene_count, s->header.loop_interval * 1000.0];
    }

    /* 等第一帧来定屏幕参数；在那之前不算 Running。 */
    self.state = AMRuntimeStateWaitingFrame;
    return YES;
}

#pragma mark - 启动

- (BOOL)prepareScreenLockedWithTimeout:(NSTimeInterval)timeout
{
    if (_screenLocked) return YES;
    if (!_script) { self.lastError = @"还没有加载脚本"; return NO; }

    /* 等第一帧。AMCapture 的 hook 在自己的线程上跑，这里只是轮询尺寸。 */
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:MAX(0.0, timeout)];
    CGSize fs = CGSizeZero;
    while (1) {
        if ([[AMCapture shared] latestSize:&fs] && fs.width > 0 && fs.height > 0) break;
        if ([deadline timeIntervalSinceNow] <= 0) break;
        [NSThread sleepForTimeInterval:0.02];
    }
    if (fs.width <= 0 || fs.height <= 0) {
        /* 到这儿说明既没等到帧、也没有人事先调 overrideScreenWidth:height:density:
           （那条路会在开头就把 _screenLocked 置上并直接返回 YES）。 */
        if ([[AMCapture shared] hasFrame]) {
            self.lastError = @"第一帧尺寸非法";
        } else {
            self.lastError = @"等不到第一帧：游戏还没渲染，或后端不是 OpenGL（drawViewHierarchy 兜底也没装上）";
        }
        return NO;
    }

    _frameW = (int)fs.width;
    _frameH = (int)fs.height;
    _density = [AMRuntime syntheticDensityForScale:[self currentPixelScale]];
    _screenLocked = YES;

    /* ★ 必须在这里设：脚本坐标的适配基准就是这两个数。 */
    am_screen cur;
    am_screen_make(&cur, _frameW, _frameH, (int)(_density + 0.5));
    am_script_set_screen(_script, &cur);

    /* 这一行打的是**当前**屏幕（_frameW/_frameH/_density 就是刚算出来的），录制屏幕
       另取模板组里的 screen_info —— script.header 没有 screen 字段，script.screen
       又刚被 am_script_set_screen 覆盖成当前值（见上面的注释）。 */
    if (_script->template_group_count > 0) {
        const am_screen_info *rec = &_script->groups[0].variants[0].screen;
        [self log:@"屏幕参数：%dx%d 像素，合成 density=%.1f（脚本录制于 %dx%d @%.0f）",
              _frameW, _frameH, _density, rec->width, rec->height, rec->density];
    } else {
        [self log:@"屏幕参数：%dx%d 像素，合成 density=%.1f（脚本没有模板组，取不到录制分辨率）",
              _frameW, _frameH, _density];
    }
    return YES;
}

- (BOOL)overrideScreenWidth:(int)w height:(int)h density:(double)density
{
    if (_script && _screenLocked) {
        self.lastError = @"屏幕参数已经锁定，不能再改（改了坐标系就变了）";
        return NO;
    }
    if (!_script) { self.lastError = @"还没有加载脚本"; return NO; }
    if (w <= 0 || h <= 0) { self.lastError = @"尺寸非法"; return NO; }
    if (density <= 0) density = [AMRuntime syntheticDensityForScale:[self currentPixelScale]];
    _frameW = w; _frameH = h; _density = density; _screenLocked = YES;
    am_screen cur;
    am_screen_make(&cur, w, h, (int)(density + 0.5));
    am_script_set_screen(_script, &cur);
    return YES;
}

#pragma mark - host 回调（都在引擎线程上跑）

/*
 * capture 的契约是"返回非零 = 这一轮没帧"。但 am_engine_step 连续 50 次拿不到帧
 * 就把脚本停掉 —— 对游戏来说这太脆：切后台、别的 context 抢走 present、
 * 加载画面暂时不渲染 GL，都可能让 present 停几十毫秒。
 *
 * 所以这里的策略是：**拿不到新帧就复用上一帧**（AMCapture 的快照本来就不消费），
 * 只有连"曾经有过一帧"都不成立时才报失败。
 * 后果要说清：画面静止时用旧帧匹配，位置是准的；画面在动时用旧帧可能匹配到
 * 上一帧的按钮位置 —— 比"整轮不做事"更接近 Android 的行为（Android 的
 * 每帧缓存也是按帧号复用同一张截图）。
 */
static int am_rt_capture(void *ctx, unsigned char *dst, int w, int h, int stride)
{
    (void)ctx;                   /* 取帧走 AMCapture 单例，不需要 ctx */
    if (stride <= 0) stride = w;
    if (stride != w) return 1;   /* AMCapture 只交付"行距 = 宽" */
    if ([[AMCapture shared] latestGrayInto:dst width:w height:h]) return 0;
    return 1;
}

static int am_rt_touch(void *ctx, int x, int y, int press_ms)
{
    AMRuntime *rt = (__bridge AMRuntime *)ctx;
    (void)rt;

    /* 「让游戏能正常玩」开关。关掉之后脚本照跑照匹配，只是不点 ——
       这样用户可以随时接管，而不用把脚本停掉再重新找准时机启动。 */
    if (![AMConfig shared].touchEnabled) return 1;

    /* ★ 必须在主线程：hitTest: 与 view 层级不是线程安全的。 */
    __block BOOL ok = NO;
    if ([NSThread isMainThread]) {
        ok = [[AMTouch shared] tapAtScreenPixel:CGPointMake(x, y) pressMs:press_ms];
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            ok = [[AMTouch shared] tapAtScreenPixel:CGPointMake(x, y) pressMs:press_ms];
        });
    }
    return ok ? 0 : 1;
}

static void am_rt_sleep(void *ctx, int ms)
{
    (void)ctx;
    if (ms <= 0) return;
    [NSThread sleepForTimeInterval:(NSTimeInterval)ms / 1000.0];
}

static long long am_rt_now_ms(void *ctx)
{
    (void)ctx;
    return (long long)([NSProcessInfo processInfo].systemUptime * 1000.0);
}

static void am_rt_trace(void *ctx, const char *msg)
{
    if (!msg) return;
    NSLog(@"[AMEngine] %s", msg);
}

#pragma mark - 引擎线程

- (void)engineThreadMain:(id)ignored
{
    (void)ignored;
    @autoreleasepool {
        _threadUp = 1;
        [NSThread currentThread].name = @"AMRuntime.engine";

        while (!_wantStop) {
            if (self.paused) {
                [NSThread sleepForTimeInterval:0.05];
                continue;
            }

            const int rc = am_engine_step(_engine);
            if (rc <= 0) {
                /* 0 = 脚本自己停了（stop 动作）或一直拿不到帧；-1 = 编程错误。 */
                if (rc == 0 && !_wantStop) {
                    self.state = AMRuntimeStateStopped;
                    [self log:@"脚本停止：%s", am_engine_last_error(_engine)];
                } else if (rc < 0) {
                    self.state = AMRuntimeStateFailed;
                    self.lastError = [NSString stringWithFormat:@"引擎错误：%s",
                                      am_engine_last_error(_engine)];
                    [self log:@"%@", self.lastError];
                }
                break;
            }

            _rounds = _rounds + 1;
            os_unfair_lock_lock(&_stateLock);
            _scene = _engine->current_scene;
            os_unfair_lock_unlock(&_stateLock);

            /* 收集这一轮产生的点击，喂给面板。am_engine_step 内部已经 sleep 过
               loop_interval，所以这里不再补睡 —— 补睡会让实际周期变成 2 倍。 */
            if (self.paused == NO && _rounds % 15 == 0) {
                [self harvestTaps];
            }
        }

        /* 退出前把剩下的点击收干净。 */
        [self harvestTaps];
        _threadUp = 0;
    }
}

- (void)harvestTaps
{
    int n = 0;
    const am_tap_record *taps = am_engine_taps(_engine, &n);
    if (n <= 0) { am_engine_clear_taps(_engine); return; }

    os_unfair_lock_lock(&_stateLock);
    for (int i = 0; i < n; i++) {
        const am_tap_record *t = &taps[i];
        const char *tn = am_action_type_name(t->type);
        NSString *line = [NSString stringWithFormat:@"#%d [%d/%d/%d] %s (%d,%d) %dms peak=%.3f",
                          t->frame, t->scene, t->event, t->action,
                          tn ? tn : "?", t->x, t->y, t->press_ms, t->peak];
        [_tapLog addObject:line];
        while (_tapLog.count > (NSUInteger)AM_MAX_TAPS) [_tapLog removeObjectAtIndex:0];
    }
    os_unfair_lock_unlock(&_stateLock);
    am_engine_clear_taps(_engine);
}

- (BOOL)startWithFrameTimeout:(NSTimeInterval)timeout
{
    if (_engine && self.state == AMRuntimeStateRunning) return YES;
    if (!_script) { self.lastError = @"还没有加载脚本"; self.state = AMRuntimeStateFailed; return NO; }

    if (![self prepareScreenLockedWithTimeout:timeout]) {
        self.state = AMRuntimeStateFailed;
        return NO;
    }

    if (!_engine) {
        _engine = (am_engine *)calloc(1u, sizeof(am_engine));
        if (!_engine) { self.lastError = @"am_engine 分配失败"; self.state = AMRuntimeStateFailed; return NO; }

        am_engine_host host;
        memset(&host, 0, sizeof(host));
        host.ctx      = (__bridge void *)self;
        host.capture  = am_rt_capture;
        host.touch    = am_rt_touch;
        host.sleep_ms = am_rt_sleep;
        host.now_ms   = am_rt_now_ms;
        host.trace    = am_rt_trace;

        if (am_engine_init(_engine, _script, &host, _frameW, _frameH) != 0) {
            self.lastError = @"引擎初始化失败";
            free(_engine); _engine = NULL;
            self.state = AMRuntimeStateFailed;
            return NO;
        }
        /* 每次运行用不同的 PRNG 种子：点击点应当在命中矩形内随机分布，
           固定种子会让每次运行的落点序列完全一样（容易被游戏的重复点击
           检测看出来，也让"随机点"这条规则失去意义）。 */
        _engine->rng = (unsigned int)([NSProcessInfo processInfo].systemUptime * 1000000.0)
                     ^ (unsigned int)arc4random();

        _unsupported = am_engine_check_supported(_engine);
        if (_unsupported > 0) {
            [self log:@"注意：有 %d 个条件本端口不会求值（颜色/文字/节点），它们一律按「不成立」处理",
                  _unsupported];
        }
    } else {
        am_engine_reset(_engine);
    }

    if (![AMTouch shared].available) {
        /* 不是致命错误：脚本可能只做取色/等待。但要明确告诉用户点了也没用。 */
        [self log:@"警告：触摸注入不可用（%@）—— 脚本会跑，但点了不会有效果",
              [AMTouch shared].lastFailure ?: @"原因未知"];
    }

    _wantStop = 0;
    self.paused = NO;
    self.state = AMRuntimeStateRunning;

    _thread = [[NSThread alloc] initWithTarget:self selector:@selector(engineThreadMain:) object:nil];
    _thread.qualityOfService = NSQualityOfServiceUserInteractive;
    _thread.stackSize = 512 * 1024;   /* 引擎的栈用量很小；默认 512KB 够，主线程之外别指望 1MB */
    [_thread start];

    [self log:@"启动：%@ / %@ / %dx%d", self.scriptName,
          [[AMCapture shared] backendName], _frameW, _frameH];
    return YES;
}

- (BOOL)autoStartIfConfigured
{
    AMConfig *cfg = [AMConfig shared];
    if (!cfg.autoStart) return NO;

    /* ① 挑脚本。配置里给了名字就按名字找，否则用第一个。 */
    NSArray<NSString *> *cands = [AMRuntime discoverScripts];
    if (cands.count == 0) {
        self.lastError = @"autoStart 已开启，但没有找到任何 .auto 脚本";
        [self log:@"%@", self.lastError];
        return NO;
    }

    NSString *want = cfg.preferredScriptName;
    NSString *pick = cands[0];
    if (want.length > 0) {
        NSString *hit = nil;
        for (NSString *p in cands) {
            if ([[p lastPathComponent] isEqualToString:want]) { hit = p; break; }
        }
        /* 没写扩展名也认（配置里写"幻想连战"比写"幻想连战.auto"更自然）。 */
        if (!hit) {
            for (NSString *p in cands) {
                if ([[p lastPathComponent].stringByDeletingPathExtension isEqualToString:want]) {
                    hit = p;
                    break;
                }
            }
        }
        if (hit) {
            pick = hit;
        } else {
            /* 配置里指名的脚本不在 —— 不能"随便挑一个"就开跑：用户很可能
               是想跑 A，结果 B 跑起来点了一堆不该点的地方。宁可不动。 */
            self.lastError = [NSString stringWithFormat:@"配置指定的脚本「%@」不在设备上（找到 %lu 个别的）",
                              want, (unsigned long)cands.count];
            [self log:@"%@", self.lastError];
            return NO;
        }
    }

    if (![self loadScriptAtPath:pick]) return NO;

    /* ② 之后台等第一帧再启动。
     *    调用点通常在 applicationDidFinishLaunching —— 那时 AIR 还没渲染过任何
     *    一帧，就地 startWithFrameTimeout: 会把启动画面卡住好几秒。 */
    __weak AMRuntime *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        AMRuntime *me = weakSelf;
        if (!me) return;

        /* 12 秒：AIR 冷启动 + 资源加载在 iPhone 7 Plus 上大约 3~6 秒，
           给一倍余量；等不到就是等不到（游戏没起来 / 渲染后端不是 GL）。 */
        if (![me startWithFrameTimeout:12.0]) {
            [me log:@"自动启动失败：%@", me.lastError ?: @"原因未知"];
        }
    });
    return YES;
}

- (void)stop
{
    _wantStop = 1;
    NSThread *t = _thread;
    _thread = nil;
    if (!t) return;

    /* 等它自己退出。最多 2 秒 —— 引擎一轮最多是 loop_interval + 一次匹配 + 一次点击，
       iPhone 上匹配是几十毫秒量级。超时就不再等（线程是 detached，不会卡住进程退出）。 */
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
    while (!((volatile int)_threadUp == 0) && [deadline timeIntervalSinceNow] > 0) {
        [NSThread sleepForTimeInterval:0.01];
    }
    if (self.state == AMRuntimeStateRunning) self.state = AMRuntimeStateIdle;
}

#pragma mark - 状态查询

- (AMRuntimeStatus)status
{
    AMRuntimeStatus st;
    memset(&st, 0, sizeof(st));
    st.state = self.state;
    st.rounds = _rounds;
    st.currentScene = -1;
    st.sceneCount = _script ? _script->scene_count : 0;
    os_unfair_lock_lock(&_stateLock);
    st.tapCount = (int)_tapLog.count;
    st.currentScene = _scene;
    os_unfair_lock_unlock(&_stateLock);
    st.lastPeak = 0;
    st.unsupportedConditions = _unsupported;
    st.frameWidth = _frameW;
    st.frameHeight = _frameH;
    st.density = _density;
    return st;
}

- (NSArray<NSString *> *)recentTapDescriptions
{
    os_unfair_lock_lock(&_stateLock);
    NSArray<NSString *> *copy = [_tapLog copy];
    os_unfair_lock_unlock(&_stateLock);
    return copy;
}

- (NSString *)environmentSummary
{
    const AMRuntimeStatus st = [self status];
    const AMCaptureStats cs = [[AMCapture shared] stats];
    const AMTouchStats   ts = [[AMTouch shared] stats];
    // 取帧的三个计数各自回答一个不同的问题，缺一个就会把原因猜错：
    //   frames      —— 真的读到多少帧
    //   dropped     —— 读到了但没人取走（渲染快于消费；不是错误）
    //   readSkips   —— 被时间节流跳过（见 AMCapture.minReadIntervalMs）
    // presentCalls 与 frames 的差值 = 「present 了但一帧都没读」，
    // 那是真的出问题了（视口取不到、realloc 失败、GL 上下文不对）。
    // glReadPixels 那一段会阻塞渲染线程，所以它必须单独报出来。
    NSString *cap = [NSString stringWithFormat:
            @"%@（present %llu / 读 %llu / 丢 %llu / 节流跳过 %llu；读 %.1f ms 其中 glReadPixels %.1f ms，峰值 %.1f ms）",
            [[AMCapture shared] backendName],
            [[AMCapture shared] presentCalls], cs.frames, cs.dropped, cs.readSkips,
            cs.lastReadMs, cs.lastGLReadMs, cs.maxReadMs];
    return [NSString stringWithFormat:
            @"取帧：%@\n触摸：%@（发 %llu / 失败 %llu / 被拒 %llu）\n帧：%dx%d @ density %.1f\n状态：%ld  轮数：%d  场景：%d/%d  点击：%d%@",
            cap,
            [[AMTouch shared] backendName], ts.sent, ts.failed, ts.refused,
            st.frameWidth, st.frameHeight, st.density,
            (long)st.state, st.rounds, st.currentScene, st.sceneCount, st.tapCount,
            st.unsupportedConditions > 0
                ? [NSString stringWithFormat:@"\n⚠️ %d 个条件不支持（颜色/文字/节点）",
                   st.unsupportedConditions]
                : @""];
}

- (NSString *)captureBackendName { return [[AMCapture shared] backendName]; }
- (NSString *)touchBackendName   { return [[AMTouch shared] backendName]; }
- (nullable UIImage *)previewImage { return [[AMCapture shared] previewImage]; }

- (nullable NSString *)describeHitAtScreenPixel:(CGPoint)px
{
    return [[AMTouch shared] describeHitAtScreenPixels:px];
}

#pragma mark - 测试

- (BOOL)acceptTestFrame:(const unsigned char *)gray width:(int)w height:(int)h
{
    if (!gray || w <= 0 || h <= 0) return NO;
    if (_screenLocked && (w != _frameW || h != _frameH)) return NO;
    if (!_screenLocked) {
        if (![self overrideScreenWidth:w height:h density:0]) return NO;
    }
    [[AMCapture shared] acceptForeignFrame:gray width:w height:h];
    return YES;
}

@end
