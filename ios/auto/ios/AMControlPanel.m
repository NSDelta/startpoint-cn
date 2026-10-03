//
//  AMControlPanel.m
//

#import "AMControlPanel.h"
#import "AMRuntime.h"
#import "AMCapture.h"
#import "AMConfig.h"

#pragma mark - 悬浮球

/*
 * 拖动用"位移阈值"判定点击还是拖拽：手指移动超过 8 点就算拖，否则算点。
 * 直接给球加 UITapGestureRecognizer 也能work，但手势识别与拖动会互相等待，
 * 手感发黏；自己判更干脆。
 */
@interface AMBall : UIView
@property (nonatomic, copy, nullable) void (^onTap)(void);
@property (nonatomic, copy, nullable) void (^onMove)(CGPoint center);
@end

@implementation AMBall
{
    CGPoint _grabOffset;
    BOOL    _dragging;
    CGPoint _startCenter;
}

- (instancetype)initWithFrame:(CGRect)frame
{
    if ((self = [super initWithFrame:frame])) {
        self.backgroundColor = [UIColor colorWithWhite:0.12 alpha:0.82];
        self.layer.cornerRadius = frame.size.width / 2.0;
        self.layer.borderWidth = 2.0;
        self.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.55].CGColor;

        UILabel *glyph = [[UILabel alloc] initWithFrame:self.bounds];
        glyph.text = @"点";
        glyph.textColor = [UIColor whiteColor];
        glyph.font = [UIFont boldSystemFontOfSize:20];
        glyph.textAlignment = NSTextAlignmentCenter;
        glyph.userInteractionEnabled = NO;
        [self addSubview:glyph];
    }
    return self;
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
    UITouch *t = touches.anyObject;
    _grabOffset = [t locationInView:self];
    _startCenter = self.center;
    _dragging = NO;
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
    UITouch *t = touches.anyObject;
    CGPoint p = [t locationInView:self.superview];
    CGPoint c = CGPointMake(p.x - _grabOffset.x + self.bounds.size.width / 2.0,
                            p.y - _grabOffset.y + self.bounds.size.height / 2.0);

    if (!_dragging) {
        const CGFloat dx = c.x - _startCenter.x, dy = c.y - _startCenter.y;
        if (dx * dx + dy * dy < 64.0) return;      /* 8 点以内还当是点击 */
        _dragging = YES;
    }

    /* 夹在父视图里，别拖出屏幕就找不回来了。 */
    const CGRect b = self.superview.bounds;
    const CGFloat r = self.bounds.size.width / 2.0;
    c.x = MAX(r, MIN(b.size.width - r, c.x));
    c.y = MAX(r, MIN(b.size.height - r, c.y));
    self.center = c;
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
    if (_dragging) {
        if (self.onMove) self.onMove(self.center);
    } else {
        if (self.onTap) self.onTap();
    }
    _dragging = NO;
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
    _dragging = NO;
}

@end

#pragma mark - 控制板

@interface AMControlPanel () <UITableViewDataSource, UITableViewDelegate>
@property (nonatomic, readwrite) BOOL visible;
@end

@implementation AMControlPanel
{
    UIWindow       *_window;
    AMBall         *_ball;
    UIView         *_board;

    UILabel        *_status;
    UITableView    *_scriptTable;
    UIButton       *_startButton;
    UIButton       *_touchButton;
    UITextView     *_log;

    NSArray<NSString *> *_scripts;
    NSTimer        *_refresh;
}

+ (instancetype)shared
{
    static AMControlPanel *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [[AMControlPanel alloc] init]; });
    return s;
}

#pragma mark - 装配

- (void)install
{
    [self buildWindow];

    /* panelVisibleAtLaunch 只在**第一次** install 时决定初始可见性。 */
    static BOOL configured = NO;
    if (!configured) {
        configured = YES;
        _visible = [AMConfig shared].panelVisibleAtLaunch;
    }
    [self updateVisibility];
    [self refresh];

    /* 0.5 秒刷一次状态：够看出"在跑没在跑"，又不至于把主线程点着。
       不用 CADisplayLink —— 那是给动画的，面板不需要 60Hz。 */
    if (!_refresh) {
        _refresh = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                    target:self
                                                  selector:@selector(refresh)
                                                  userInfo:nil
                                                   repeats:YES];
    }
}

- (void)buildWindow
{
    if (_window) return;

    UIWindow *w = nil;

    /* iOS 13+ 的窗口必须挂在某个 UIWindowScene 上，否则根本不会显示
       （也不会报错，只是静默不出现 —— 这个坑值得一条注释）。 */
    if (@available(iOS 13.0, *)) {
        UIWindowScene *scene = [self foregroundWindowScene];
        if (scene) {
            w = [[UIWindow alloc] initWithWindowScene:scene];
        }
    }
    if (!w) {
        w = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    }
    w.frame = [UIScreen mainScreen].bounds;
    w.windowLevel = UIWindowLevelAlert + 1.0;
    /* 透明背景：面板只画自己的两个子视图，其余地方让游戏露出来。 */
    w.backgroundColor = [UIColor clearColor];
    w.rootViewController = [[UIViewController alloc] init];
    w.rootViewController.view.backgroundColor = [UIColor clearColor];
    w.hidden = YES;
    _window = w;

    [self buildBall];
    [self buildBoard];
}

- (nullable UIWindowScene *)foregroundWindowScene API_AVAILABLE(ios(13.0))
{
    for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        if (s.activationState == UISceneActivationStateForegroundActive) {
            return (UIWindowScene *)s;
        }
    }
    /* 没有前台场景（注入得很早、UI 还没起来）时退回任意一个场景，
       总比拿不到强 —— 拿到之后 refresh 里会再试一次。 */
    for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]]) return (UIWindowScene *)s;
    }
    return nil;
}

- (void)buildBall
{
    const CGRect screen = [UIScreen mainScreen].bounds;
    const CGFloat d = 56.0;
    AMBall *ball = [[AMBall alloc] initWithFrame:CGRectMake(0, 0, d, d)];

    CGPoint c = [AMConfig shared].ballCenter;
    if (c.x <= 0 && c.y <= 0) {
        /* 没摆过的哨兵：默认右下角往上一截，避开游戏的"开始"按钮区。 */
        c = CGPointMake(screen.size.width - d / 2.0 - 6.0, screen.size.height - 140.0);
    }
    ball.center = c;

    __weak AMControlPanel *weakSelf = self;
    ball.onTap  = ^{ [weakSelf toggleBoard]; };
    ball.onMove = ^(CGPoint center) { [AMConfig shared].ballCenter = center; };

    [_window.rootViewController.view addSubview:ball];
    _ball = ball;
}

- (void)buildBoard
{
    const CGRect screen = [UIScreen mainScreen].bounds;
    const CGFloat inset = 10.0;
    const CGFloat boardW = MIN(340.0, screen.size.width - 2 * inset);
    const CGFloat boardH = MIN(460.0, screen.size.height - 2 * inset);

    UIView *board = [[UIView alloc] initWithFrame:CGRectMake(inset, inset, boardW, boardH)];
    board.backgroundColor = [UIColor colorWithWhite:0.08 alpha:0.94];
    board.layer.cornerRadius = 12.0;
    board.clipsToBounds = YES;
    board.hidden = YES;

    CGFloat y = 8.0;
    const CGFloat x = 10.0;
    const CGFloat innerW = boardW - 2 * x;

    /* 标题栏：左边"关闭"，右边可以将来放"最小化"。 */
    UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(x, y, innerW - 60.0, 24.0)];
    title.text = @"自动点击";
    title.textColor = [UIColor whiteColor];
    title.font = [UIFont boldSystemFontOfSize:16];
    [board addSubview:title];

    UIButton *close = [UIButton buttonWithType:UIButtonTypeSystem];
    close.frame = CGRectMake(boardW - 70.0, y - 4.0, 60.0, 32.0);
    [close setTitle:@"收起" forState:UIControlStateNormal];
    [close addTarget:self action:@selector(hideBoard) forControlEvents:UIControlEventTouchUpInside];
    [board addSubview:close];
    y += 30.0;

    /* 状态 */
    _status = [[UILabel alloc] initWithFrame:CGRectMake(x, y, innerW, 66.0)];
    _status.numberOfLines = 0;
    _status.textColor = [UIColor colorWithWhite:0.88 alpha:1.0];
    _status.font = [UIFont monospacedSystemFontOfSize:10 weight:UIFontWeightRegular];
    _status.text = @"…";
    [board addSubview:_status];
    y += 70.0;

    /* 开始 / 停止 */
    _startButton = [UIButton buttonWithType:UIButtonTypeSystem];
    _startButton.frame = CGRectMake(x, y, (innerW - 8.0) / 2.0, 38.0);
    _startButton.backgroundColor = [UIColor colorWithRed:0.18 green:0.52 blue:0.32 alpha:1.0];
    [_startButton setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    _startButton.layer.cornerRadius = 8.0;
    [_startButton addTarget:self action:@selector(toggleRun) forControlEvents:UIControlEventTouchUpInside];
    [board addSubview:_startButton];

    /* 「跟着玩」开关：关掉之后脚本照跑照匹配，只是不点。 */
    _touchButton = [UIButton buttonWithType:UIButtonTypeSystem];
    _touchButton.frame = CGRectMake(x + (innerW - 8.0) / 2.0 + 8.0, y, (innerW - 8.0) / 2.0, 38.0);
    _touchButton.layer.cornerRadius = 8.0;
    [_touchButton addTarget:self action:@selector(toggleTouch) forControlEvents:UIControlEventTouchUpInside];
    [board addSubview:_touchButton];
    y += 44.0;

    /* 脚本列表 */
    _scriptTable = [[UITableView alloc] initWithFrame:CGRectMake(x, y, innerW, 120.0)
                                                style:UITableViewStylePlain];
    _scriptTable.dataSource = self;
    _scriptTable.delegate = self;
    _scriptTable.backgroundColor = [UIColor colorWithWhite:0.14 alpha:1.0];
    _scriptTable.layer.cornerRadius = 8.0;
    _scriptTable.rowHeight = 32.0;
    [board addSubview:_scriptTable];
    y += 126.0;

    /* 日志 */
    const CGFloat logH = boardH - y - 10.0;
    _log = [[UITextView alloc] initWithFrame:CGRectMake(x, y, innerW, MAX(40.0, logH))];
    _log.backgroundColor = [UIColor colorWithWhite:0.04 alpha:1.0];
    _log.textColor = [UIColor colorWithWhite:0.78 alpha:1.0];
    _log.font = [UIFont monospacedSystemFontOfSize:9 weight:UIFontWeightRegular];
    _log.editable = NO;
    _log.layer.cornerRadius = 8.0;
    [board addSubview:_log];

    [_window.rootViewController.view addSubview:board];
    _board = board;

    [self reloadScripts];
}

#pragma mark - 可见性

- (void)setVisible:(BOOL)visible
{
    _visible = visible;
    [AMConfig shared].panelVisible = visible;
    [self updateVisibility];
}

- (void)updateVisibility
{
    if (!_window) return;

    /*
     * 兜底取帧后端（drawViewHierarchyInRect:）会把我们自己的窗口也拍进去，
     * 那样面板就成了"模板的一部分"——匹配会在面板的像素上比对，必然失效。
     * 所以那个后端一旦生效，面板必须硬隐藏（连悬浮球一起）。
     */
    const AMCaptureBackend backend = [AMCapture shared].backend;
    if (backend == AMCaptureBackendHierarchy && _visible) {
        _window.hidden = YES;
        return;
    }

    _window.hidden = !_visible;
    if (_visible) {
        /* 注入得很早时窗口可能没挂上场景；这里补挂一次。 */
        if (@available(iOS 13.0, *)) {
            if (!_window.windowScene) {
                UIWindowScene *scene = [self foregroundWindowScene];
                if (scene) {
#if TARGET_OS_IOS
                    _window.windowScene = scene;
#endif
                }
            }
        }
        [_window makeKeyAndVisible];
        /* makeKeyAndVisible 会把**游戏的**窗口从 key 位置上挤下来，那样
           hitTest 全落在我们的窗口里、引擎的触摸就打到面板上了。
           立刻把 key 还给原来的窗口。 */
        [self restoreGameKeyWindow];
    }
}

- (void)restoreGameKeyWindow
{
    UIApplication *app = [UIApplication sharedApplication];
    for (UIScene *s in app.connectedScenes) {
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene *scene = (UIWindowScene *)s;
        if (s.activationState != UISceneActivationStateForegroundActive) continue;
        for (UIWindow *w in scene.windows) {
            if (w == _window) continue;
            if (w.isKeyWindow) return;              /* 已经是它了 */
            if (w.hidden) continue;
            [w makeKeyWindow];
            return;
        }
    }
}

#pragma mark - 动作

- (void)toggleBoard
{
    _board.hidden = !_board.hidden;
    if (!_board.hidden) [self refresh];
}

- (void)hideBoard { _board.hidden = YES; }

- (void)toggleRun
{
    AMRuntime *rt = [AMRuntime shared];
    if (rt.state == AMRuntimeStateRunning) {
        [rt stop];
    } else {
        if (rt.scriptPath == nil) {
            /* 没选脚本就自动挑第一个，省一步操作。 */
            [self reloadScripts];
            if (_scripts.count > 0) [self selectScriptAtIndex:0];
        }
        if (![rt startWithFrameTimeout:5.0]) {
            [self appendLog:[NSString stringWithFormat:@"启动失败：%@", rt.lastError ?: @"原因未知"]];
        }
    }
    [self refresh];
}

- (void)toggleTouch
{
    AMConfig *cfg = [AMConfig shared];
    cfg.touchEnabled = !cfg.touchEnabled;
    [self refresh];
}

#pragma mark - 脚本

- (void)reloadScripts
{
    _scripts = [AMRuntime discoverScripts];
    [_scriptTable reloadData];
    [self appendLog:[NSString stringWithFormat:@"发现 %lu 个脚本", (unsigned long)_scripts.count]];
}

- (void)selectScriptAtIndex:(NSInteger)idx
{
    if (idx < 0 || idx >= (NSInteger)_scripts.count) return;
    NSString *path = _scripts[(NSUInteger)idx];
    AMRuntime *rt = [AMRuntime shared];
    if ([rt loadScriptAtPath:path]) {
        [AMConfig shared].lastScriptPath = path;
        [self appendLog:[NSString stringWithFormat:@"已选：%@", path.lastPathComponent]];
    } else {
        [self appendLog:[NSString stringWithFormat:@"加载失败：%@", rt.lastError ?: @"原因未知"]];
    }
    [_scriptTable reloadData];
}

#pragma mark - UITableView

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section
{
    return (NSInteger)MAX((NSUInteger)1, _scripts.count);
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath
{
    static NSString *reuse = @"am.script.cell";
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:reuse];
    if (!cell) {
        cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:reuse];
        cell.backgroundColor = [UIColor clearColor];
        cell.textLabel.textColor = [UIColor whiteColor];
        cell.textLabel.font = [UIFont systemFontOfSize:12];
        cell.detailTextLabel.textColor = [UIColor colorWithWhite:0.6 alpha:1.0];
        cell.detailTextLabel.font = [UIFont systemFontOfSize:9];
        cell.selectionStyle = UITableViewCellSelectionStyleDefault;
    }

    if (_scripts.count == 0) {
        cell.textLabel.text = @"没有找到 .auto 脚本";
        cell.detailTextLabel.text = @"放到 Documents/AutoClick/ 下";
        cell.userInteractionEnabled = NO;
        return cell;
    }

    NSString *path = _scripts[(NSUInteger)indexPath.row];
    cell.userInteractionEnabled = YES;
    cell.textLabel.text = path.lastPathComponent;
    cell.detailTextLabel.text = [path isEqualToString:[AMRuntime shared].scriptPath ?: @""]
                              ? @"● 当前脚本"
                              : path.stringByDeletingLastPathComponent;
    cell.accessoryType = [path isEqualToString:[AMRuntime shared].scriptPath ?: @""]
                       ? UITableViewCellAccessoryCheckmark
                       : UITableViewCellAccessoryNone;
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath
{
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    [self selectScriptAtIndex:indexPath.row];
}

#pragma mark - 刷新

- (void)refresh
{
    if (!_window) return;
    [self updateVisibility];
    if (_window.hidden || _board.hidden) return;

    AMRuntime *rt = [AMRuntime shared];
    const AMRuntimeStatus st = [rt status];

    static NSString *const stateName[] = {
        @"空闲", @"加载中", @"等第一帧", @"运行中", @"已停止", @"失败"
    };
    NSString *sn = (st.state >= 0 && st.state <= AMRuntimeStateFailed)
                 ? stateName[st.state] : @"?";

    _status.text = [NSString stringWithFormat:
        @"%@  %@\n"
        @"场景 %d/%d  轮数 %d  点击 %d\n"
        @"帧 %dx%d  取帧 %@\n"
        @"触摸 %@%@",
        sn,
        rt.scriptName ?: @"（未选脚本）",
        st.currentScene, st.sceneCount, st.rounds, st.tapCount,
        st.frameWidth, st.frameHeight,
        [rt captureBackendName],
        [AMConfig shared].touchEnabled ? [rt touchBackendName] : @"已关闭（跟着玩）",
        st.unsupportedConditions > 0
            ? [NSString stringWithFormat:@"\n⚠️ %d 个条件不支持", st.unsupportedConditions]
            : @""];

    [_startButton setTitle:(st.state == AMRuntimeStateRunning ? @"停止" : @"开始")
                  forState:UIControlStateNormal];

    _touchButton.backgroundColor = [AMConfig shared].touchEnabled
        ? [UIColor colorWithRed:0.20 green:0.42 blue:0.60 alpha:1.0]
        : [UIColor colorWithRed:0.45 green:0.28 blue:0.20 alpha:1.0];
    [_touchButton setTitle:([AMConfig shared].touchEnabled ? @"让游戏能玩：关" : @"让游戏能玩：开")
                  forState:UIControlStateNormal];
    [_touchButton setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];

    /* 日志只显示最后 12 行：面板小，而且引擎一秒能产生好几条。 */
    NSArray<NSString *> *lines = [rt recentTapDescriptions];
    const NSUInteger take = MIN((NSUInteger)12, lines.count);
    NSMutableString *tail = [NSMutableString string];
    for (NSUInteger i = lines.count - take; i < lines.count; i++) {
        [tail appendFormat:@"%@\n", lines[i]];
    }
    if (rt.lastError.length > 0) [tail appendFormat:@"❗️%@\n", rt.lastError];
    _log.text = tail.length > 0 ? tail : @"（还没有点击）";
    if (_log.text.length > 0) {
        [_log scrollRangeToVisible:NSMakeRange(_log.text.length - 1, 1)];
    }
}

- (void)appendLog:(NSString *)line
{
    if (!line) return;
    NSLog(@"[AMPanel] %@", line);
    _log.text = [NSString stringWithFormat:@"%@%@\n", _log.text ?: @"", line];
}

#pragma mark - 卸载

- (void)shutdown
{
    [_refresh invalidate];
    _refresh = nil;
    [_window setHidden:YES];
    _window = nil;
    _ball = nil;
    _board = nil;
    _status = nil;
    _scriptTable = nil;
    _startButton = nil;
    _touchButton = nil;
    _log = nil;
}

@end
