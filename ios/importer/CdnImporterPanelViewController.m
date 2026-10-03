//
//  CdnImporterPanelViewController.m
//

#import "CdnImporterPanelViewController.h"

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#import "CdnArchiveIndex.h"
#import "CdnImportEngine.h"
#import "CdnImporterConfig.h"

static const NSUInteger kCdnPanelMaxLogLines = 400;

@interface CdnImporterPanelViewController () <UIDocumentPickerDelegate>

@property (nonatomic, strong) UILabel *titleLabel;
@property (nonatomic, strong) UILabel *statusLabel;
@property (nonatomic, strong) UIProgressView *progressView;
@property (nonatomic, strong) UITextView *logView;
@property (nonatomic, strong) NSMutableArray<UIButton *> *actionButtons;
@property (nonatomic, strong) NSMutableArray<NSString *> *logLines;

@property (nonatomic, strong, nullable) NSArray<NSURL *> *inputURLs;
@property (nonatomic, strong, nullable) CdnImportEngine *engine;
@property (nonatomic, strong, nullable) CdnImportResult *lastResult;
@property (nonatomic, strong, nullable) NSString *lastStageText;
@property (nonatomic) BOOL busy;
@property (nonatomic) BOOL previousIdleTimerDisabled;
@property (nonatomic, strong) dispatch_queue_t workQueue;
@property (nonatomic, strong) NSDateFormatter *timeFormatter;

@end

@implementation CdnImporterPanelViewController

- (instancetype)init {
    self = [super init];
    if (self != nil) {
        _logLines = [NSMutableArray array];
        _actionButtons = [NSMutableArray array];
        _workQueue = dispatch_queue_create("com.starpoint.cdnimporter.work", DISPATCH_QUEUE_SERIAL);
        _timeFormatter = [[NSDateFormatter alloc] init];
        _timeFormatter.dateFormat = @"HH:mm:ss";
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];

    self.view.backgroundColor = [UIColor colorWithWhite:0.10 alpha:0.97];
    self.view.layer.cornerRadius = 14.0;
    self.view.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.18].CGColor;
    self.view.layer.borderWidth = 1.0;
    self.view.clipsToBounds = YES;

    _titleLabel = [[UILabel alloc] init];
    _titleLabel.text = @"CDN 本地导入器";
    _titleLabel.textColor = [UIColor whiteColor];
    _titleLabel.font = [UIFont boldSystemFontOfSize:15];

    _statusLabel = [[UILabel alloc] init];
    _statusLabel.textColor = [UIColor colorWithWhite:0.82 alpha:1.0];
    _statusLabel.font = [UIFont systemFontOfSize:11];
    _statusLabel.numberOfLines = 0;

    _progressView = [[UIProgressView alloc] initWithProgressViewStyle:UIProgressViewStyleDefault];
    _progressView.progressTintColor = [UIColor colorWithRed:0.24 green:0.62 blue:0.96 alpha:1.0];
    _progressView.trackTintColor = [UIColor colorWithWhite:0.28 alpha:1.0];
    _progressView.progress = 0.0;

    _logView = [[UITextView alloc] init];
    _logView.editable = NO;
    _logView.backgroundColor = [UIColor colorWithWhite:0.04 alpha:1.0];
    _logView.textColor = [UIColor colorWithWhite:0.85 alpha:1.0];
    _logView.font = [UIFont monospacedSystemFontOfSize:9.5 weight:UIFontWeightRegular];
    _logView.layer.cornerRadius = 6.0;
    _logView.textContainerInset = UIEdgeInsetsMake(6, 5, 6, 5);

    [self.view addSubview:_titleLabel];
    [self.view addSubview:_statusLabel];
    [self.view addSubview:_progressView];
    [self.view addSubview:_logView];

    NSArray<NSArray *> *specs = @[
        @[@"选文件夹", @"handlePickFolder:"],
        @[@"选文件(可多选)", @"handlePickFiles:"],
        @[@"预检", @"handleDryRun:"],
        @[@"开始导入", @"handleImport:"],
        @[@"取消", @"handleCancel:"],
        @[@"关闭", @"handleClose:"],
    ];
    for (NSArray *spec in specs) {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
        [button setTitle:spec[0] forState:UIControlStateNormal];
        [button setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
        [button setTitleColor:[UIColor colorWithWhite:0.6 alpha:1.0] forState:UIControlStateDisabled];
        button.titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightMedium];
        button.backgroundColor = [UIColor colorWithWhite:0.30 alpha:1.0];
        button.layer.cornerRadius = 8.0;
        SEL action = NSSelectorFromString(spec[1]);
        [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
        [self.actionButtons addObject:button];
        [self.view addSubview:button];
    }
    // 「开始导入」用醒目色
    self.actionButtons[3].backgroundColor = [UIColor colorWithRed:0.15 green:0.47 blue:0.85 alpha:1.0];

    [self appendLog:[NSString stringWithFormat:@"导入计划：%@ → %@，%lu 个归档，压缩态 %@",
                     [CdnImportPlan sharedPlan].baselineVersion,
                     [CdnImportPlan sharedPlan].targetVersion,
                     (unsigned long)[CdnImportPlan sharedPlan].items.count,
                     CdnImporterHumanBytes([CdnImportPlan sharedPlan].totalCompressedBytes)]];
    [self appendLog:[NSString stringWithFormat:@"目标目录：%@", CdnImporterAssetDownloadDir()]];
    [self refreshFromDisk];
    [self updateButtons];
}

- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];

    CGFloat pad = 12.0;
    CGFloat width = self.view.bounds.size.width;
    CGFloat height = self.view.bounds.size.height;
    CGFloat contentWidth = width - 2 * pad;
    CGFloat y = pad;

    self.titleLabel.frame = CGRectMake(pad, y, contentWidth, 20.0);
    y += 24.0;
    self.statusLabel.frame = CGRectMake(pad, y, contentWidth, 50.0);
    y += 54.0;
    self.progressView.frame = CGRectMake(pad, y, contentWidth, 6.0);
    y += 14.0;

    CGFloat buttonHeight = 32.0;
    CGFloat gap = 8.0;
    CGFloat columnWidth = (contentWidth - gap) / 2.0;
    for (NSUInteger index = 0; index < self.actionButtons.count; index++) {
        NSUInteger row = index / 2;
        NSUInteger column = index % 2;
        self.actionButtons[index].frame = CGRectMake(pad + column * (columnWidth + gap),
                                                     y + row * (buttonHeight + gap),
                                                     columnWidth, buttonHeight);
    }
    y += 3 * (buttonHeight + gap) + 2.0;

    self.logView.frame = CGRectMake(pad, y, contentWidth, MAX(60.0, height - y - pad));
}

#pragma mark - 日志

- (void)appendLog:(NSString *)line {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self appendLog:line];
        });
        return;
    }
    NSString *stamp = [self.timeFormatter stringFromDate:[NSDate date]];
    [self.logLines addObject:[NSString stringWithFormat:@"%@ %@", stamp, line]];
    while (self.logLines.count > kCdnPanelMaxLogLines) {
        [self.logLines removeObjectAtIndex:0];
    }
    self.logView.text = [self.logLines componentsJoinedByString:@"\n"];
    if (self.logView.text.length > 0) {
        NSRange end = NSMakeRange(self.logView.text.length - 1, 1);
        [self.logView scrollRangeToVisible:end];
    }
}

#pragma mark - 状态刷新

- (void)refreshFromDisk {
    NSMutableString *text = [NSMutableString string];
    CdnImportPlan *plan = [CdnImportPlan sharedPlan];

    NSDictionary *info = CdnImporterJSONFromFile(CdnImporterInfoJsonPath(), NULL);
    if (info != nil) {
        [text appendFormat:@"已装 info.json：version=%@ totalSize=%@ recovery=%@\n",
                           info[@"version"] ?: @"?", info[@"totalSize"] ?: @"?",
                           [(NSArray *)info[@"assetRecoveryInfo"] count] == 0 ? @"[]" : @"非空"];
    } else {
        [text appendString:@"尚无 info.json（未导入过，或导入未完成）\n"];
    }

    NSString *dummyDir = CdnImporterAssetDummyDir();
    BOOL downloadExists = [[NSFileManager defaultManager] fileExistsAtPath:CdnImporterAssetDownloadDir()];
    [text appendFormat:@"download 目录：%@\n", downloadExists ? @"存在" : @"不存在（首次导入会创建）"];

    NSError *spaceError = nil;
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfFileSystemForPath:dummyDir error:&spaceError];
    if (attributes == nil) {
        attributes = [[NSFileManager defaultManager] attributesOfFileSystemForPath:NSHomeDirectory() error:&spaceError];
    }
    unsigned long long freeBytes = [attributes[NSFileSystemFreeSize] unsignedLongLongValue];
    [text appendFormat:@"可用空间：%@（需要 %@ + 1GB）\n",
                       CdnImporterHumanBytes(freeBytes),
                       CdnImporterHumanBytes(plan.expectedTotalBytes)];

    NSArray<NSString *> *partials = CdnImporterPartialFilePaths();
    NSUInteger existingPartials = 0;
    for (NSString *path in partials) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) existingPartials++;
    }
    [text appendFormat:@"残留 partial 文件：%lu / %lu\n", (unsigned long)existingPartials, (unsigned long)partials.count];
    [text appendFormat:@"已选输入：%lu 项", (unsigned long)self.inputURLs.count];
    if (self.inputURLs.count > 0) {
        [text appendFormat:@"（例如 %@）", self.inputURLs.firstObject.lastPathComponent];
    }

    self.statusLabel.text = text;
}

- (void)updateButtons {
    for (NSUInteger index = 0; index < self.actionButtons.count; index++) {
        BOOL enabled = YES;
        if (self.busy) {
            enabled = (index == 4);   // 只有「取消」在忙时可用
        } else {
            enabled = (index != 4);   // 不忙时「取消」不可用
        }
        if ((index == 2 || index == 3) && self.inputURLs.count == 0 && !self.busy) {
            enabled = NO;
        }
        self.actionButtons[index].enabled = enabled;
        self.actionButtons[index].alpha = enabled ? 1.0 : 0.45;
    }
}

- (void)updateProgress:(CdnImportProgress *)progress {
    NSString *stage = CdnImportStageName(progress.stage);
    if (progress.stage == CdnImportStageIdle || progress.stage == CdnImportStageFinished ||
        progress.stage == CdnImportStageFailed || progress.stage == CdnImportStageCancelled) {
        self.progressView.progress = (progress.stage == CdnImportStageFinished) ? 1.0 : 0.0;
    } else {
        self.progressView.progress = (float)MAX(0.0, MIN(1.0, progress.fraction));
    }

    NSMutableString *text = [NSMutableString string];
    [text appendFormat:@"%@ · %@\n", stage, progress.statusText ?: @""];
    [text appendFormat:@"归档 %lu/%lu · 压缩态 %@/%@\n",
                       (unsigned long)progress.archivesDone, (unsigned long)progress.archivesTotal,
                       CdnImporterHumanBytes(progress.compressedDone), CdnImporterHumanBytes(progress.compressedTotal)];
    [text appendFormat:@"已写文件 %lu", (unsigned long)progress.filesWritten];
    if (progress.elapsed > 0.5) {
        [text appendFormat:@" · 用时 %.0fs", progress.elapsed];
        if (progress.remaining >= 0.0) [text appendFormat:@" · 剩余约 %.0fs", progress.remaining];
    }
    self.statusLabel.text = text;
}

#pragma mark - 选择输入

- (void)handlePickFolder:(UIButton *)sender {
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeFolder] asCopy:NO];
    picker.allowsMultipleSelection = NO;
    picker.delegate = self;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)handlePickFiles:(UIButton *)sender {
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeData] asCopy:NO];
    picker.allowsMultipleSelection = YES;
    picker.delegate = self;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    self.inputURLs = urls;
    [self appendLog:[NSString stringWithFormat:@"已选择 %lu 项输入：", (unsigned long)urls.count]];
    for (NSURL *url in urls) {
        [self appendLog:[NSString stringWithFormat:@"  · %@", url.lastPathComponent]];
    }
    [self refreshFromDisk];
    [self updateButtons];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    [self appendLog:@"文件选择已取消"];
}

#pragma mark - 运行

- (void)handleDryRun:(UIButton *)sender {
    [self runWithDryRun:YES];
}

- (void)handleImport:(UIButton *)sender {
    if (self.busy) return;
    CdnImportPlan *plan = [CdnImportPlan sharedPlan];
    NSString *message = [NSString stringWithFormat:
        @"将先清空\n%@\n再按计划顺序解压 %lu 个归档（压缩态 %@，终态约 %@）。\n\n请保持本界面在前台、不要锁屏；中途可点「取消」。",
        CdnImporterAssetDownloadDir(), (unsigned long)plan.items.count,
        CdnImporterHumanBytes(plan.totalCompressedBytes), CdnImporterHumanBytes(plan.expectedTotalBytes)];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"开始导入？"
                                                                  message:message
                                                           preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"取消" style:UIAlertActionStyleCancel handler:nil]];
    __weak typeof(self) weakSelf = self;
    [alert addAction:[UIAlertAction actionWithTitle:@"开始导入" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *action) {
        [weakSelf runWithDryRun:NO];
    }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)handleCancel:(UIButton *)sender {
    if (self.engine == nil) return;
    [self appendLog:@"请求取消…"];
    [self.engine cancel];
}

- (void)handleClose:(UIButton *)sender {
    if (self.closeHandler != nil) self.closeHandler();
}

- (void)runWithDryRun:(BOOL)dryRun {
    if (self.busy) return;
    if (self.inputURLs.count == 0) {
        [self appendLog:@"还没有选择输入"];
        return;
    }

    self.busy = YES;
    self.lastResult = nil;
    [self updateButtons];

    if (!dryRun) {
        self.previousIdleTimerDisabled = [UIApplication sharedApplication].isIdleTimerDisabled;
        [UIApplication sharedApplication].idleTimerDisabled = YES;
    }

    CdnImportEngine *engine = [[CdnImportEngine alloc] init];
    engine.dryRun = dryRun;
    __weak typeof(self) weakSelf = self;
    engine.logHandler = ^(NSString *line) {
        [weakSelf appendLog:line];
    };
    engine.progressHandler = ^(CdnImportProgress *progress) {
        [weakSelf updateProgress:progress];
    };
    self.engine = engine;

    NSArray<NSURL *> *urls = self.inputURLs;
    dispatch_async(self.workQueue, ^{
        NSError *error = nil;
        CdnImportResult *result = [engine runWithInputURLs:urls error:&error];
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (strongSelf == nil) return;
            strongSelf.busy = NO;
            strongSelf.engine = nil;
            if (!dryRun) {
                [UIApplication sharedApplication].idleTimerDisabled = strongSelf.previousIdleTimerDisabled;
            }
            [strongSelf updateButtons];
            if (result == nil) {
                [strongSelf presentError:error];
            } else {
                strongSelf.lastResult = result;
                [strongSelf presentResult:result dryRun:dryRun];
            }
        });
    });
}

- (void)presentError:(NSError *)error {
    NSString *message = error.localizedDescription ?: @"未知错误";
    [self appendLog:[NSString stringWithFormat:@"失败：%@", message]];
    NSArray<NSString *> *details = error.userInfo[CdnImporterDetailsKey];
    for (NSString *line in details) {
        [self appendLog:[NSString stringWithFormat:@"  · %@", line]];
    }
    [self refreshFromDisk];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"导入未完成"
                                                                  message:message
                                                           preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"知道了" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)presentResult:(CdnImportResult *)result dryRun:(BOOL)dryRun {
    NSString *title = dryRun ? @"预检完成" : @"导入完成";
    NSString *message = result.summaryText ?: @"";
    [self appendLog:[NSString stringWithFormat:@"%@：%@", title, message]];
    for (NSString *warning in result.warnings) {
        [self appendLog:[NSString stringWithFormat:@"⚠️ %@", warning]];
    }
    for (NSString *problem in result.problems) {
        [self appendLog:[NSString stringWithFormat:@"❌ %@", problem]];
    }
    [self refreshFromDisk];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:title
                                                                  message:message
                                                           preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"好" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}

@end
