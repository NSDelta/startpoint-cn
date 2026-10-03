//
//  AMConfig.m
//

#import "AMConfig.h"

#import <UIKit/UIKit.h>

/* 面板状态文件。目录与 AMRuntime 的脚本搜索目录是同一个，
   用户只要会往那儿丢脚本，就能顺手看到这个 plist。 */
static NSString *AMConfigStatePath(void)
{
    NSArray<NSString *> *dirs =
        NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    if (dirs.count == 0) return nil;
    NSString *dir = [dirs[0] stringByAppendingPathComponent:@"AutoClick"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:NULL];
    return [dir stringByAppendingPathComponent:@"panel.plist"];
}

@interface AMConfig ()
{
    NSMutableDictionary *_state;
    NSDictionary        *_bundle;
    BOOL                 _dirty;
}
@end

@implementation AMConfig

+ (instancetype)shared
{
    static AMConfig *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[AMConfig alloc] init]; });
    return s;
}

- (instancetype)init
{
    if ((self = [super init])) {
        NSString *p = AMConfigStatePath();
        NSDictionary *loaded = p ? [NSDictionary dictionaryWithContentsOfFile:p] : nil;
        _state = loaded ? [loaded mutableCopy] : [NSMutableDictionary dictionary];

        NSString *bp = [[NSBundle mainBundle] pathForResource:@"AutoClick" ofType:@"plist"];
        _bundle = bp ? [NSDictionary dictionaryWithContentsOfFile:bp] : nil;

        /* 缺省值。ballCenter 用 (0,0) 当"还没摆过"的哨兵，
           AMControlPanel 看到它会把球放到右下角。 */
        if (_state[@"panelVisible"] == nil) _state[@"panelVisible"] = @(self.panelVisibleAtLaunch);
        if (_state[@"touchEnabled"] == nil) _state[@"touchEnabled"] = @YES;
    }
    return self;
}

#pragma mark - bundle 配置

- (nullable id)bundleValueForKey:(NSString *)key
{
    id v = _bundle[key];
    return v;
}

- (BOOL)autoStart
{
    id v = _bundle[@"autoStart"];
    return [v respondsToSelector:@selector(boolValue)] ? [v boolValue] : NO;
}

- (nullable NSString *)preferredScriptName
{
    id v = _bundle[@"script"];
    return [v isKindOfClass:[NSString class]] ? (NSString *)v : nil;
}

- (BOOL)panelVisibleAtLaunch
{
    id v = _bundle[@"panelVisibleAtLaunch"];
    /* 缺省 YES：越狱侧没有面板就没法操作；dylib 侧要"启动即跑不弹面板"
       就在 bundle 配置里写 panelVisibleAtLaunch = false。 */
    return [v respondsToSelector:@selector(boolValue)] ? [v boolValue] : YES;
}

#pragma mark - 可写状态

- (BOOL)panelVisible { return [_state[@"panelVisible"] boolValue]; }

- (void)setPanelVisible:(BOOL)v
{
    if ([_state[@"panelVisible"] boolValue] == v) return;
    _state[@"panelVisible"] = @(v);
    [self saveSoon];
}

- (CGPoint)ballCenter
{
    id v = _state[@"ballCenter"];
    if ([v isKindOfClass:[NSString class]]) {
        CGPoint p = CGPointZero;
        if (sscanf([(NSString *)v UTF8String], "%lf,%lf", &p.x, &p.y) == 2) return p;
    }
    return CGPointZero;
}

- (void)setBallCenter:(CGPoint)p
{
    _state[@"ballCenter"] = [NSString stringWithFormat:@"%.1f,%.1f", p.x, p.y];
    [self saveSoon];
}

- (nullable NSString *)lastScriptPath { return _state[@"lastScriptPath"]; }
- (void)setLastScriptPath:(nullable NSString *)p
{
    if (p) _state[@"lastScriptPath"] = p;
    else   [_state removeObjectForKey:@"lastScriptPath"];
    [self saveSoon];
}

- (BOOL)touchEnabled { return [_state[@"touchEnabled"] boolValue]; }
- (void)setTouchEnabled:(BOOL)v
{
    if ([_state[@"touchEnabled"] boolValue] == v) return;
    _state[@"touchEnabled"] = @(v);
    [self saveSoon];
}

#pragma mark - 落盘

- (void)saveSoon
{
    _dirty = YES;
    /* 面板上的开关可能连着被点好几下，合并成一次写。 */
    [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(flush) object:nil];
    [self performSelector:@selector(flush) withObject:nil afterDelay:0.5];
}

- (void)flush
{
    if (!_dirty) return;
    NSString *p = AMConfigStatePath();
    if (p) [_state writeToFile:p atomically:YES];
    _dirty = NO;
}

@end
