//
//  CdnImporterConfig.m
//

#import "CdnImporterConfig.h"

NSString *const CdnImporterPatchBaseKey = @"CdnImporterPatchBase";
NSString *const CdnImporterStorageRootKey = @"CdnImporterStorageRoot";
NSString *const CdnImporterDeepVerifyKey = @"CdnImporterDeepVerify";
NSString *const CdnImporterBallXKey = @"CdnImporterBallX";
NSString *const CdnImporterBallYKey = @"CdnImporterBallY";

NSString *const CdnImporterErrorDomain = @"com.starpoint.cdnimporter";
NSString *const CdnImporterDetailsKey = @"CdnImporterDetails";

NSError *CdnErrorWithDetails(CdnImporterErrorCode code, NSArray<NSString *> * _Nullable details, NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSMutableDictionary *userInfo = [NSMutableDictionary dictionaryWithCapacity:2];
    userInfo[NSLocalizedDescriptionKey] = message;
    if (details.count > 0) userInfo[CdnImporterDetailsKey] = details;
    return [NSError errorWithDomain:CdnImporterErrorDomain code:code userInfo:userInfo];
}

NSError *CdnError(CdnImporterErrorCode code, NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    return CdnErrorWithDetails(code, nil, @"%@", message);
}

#pragma mark - 日志

static dispatch_queue_t CdnImporterLogQueue(void) {
    static dispatch_queue_t queue = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("com.starpoint.cdnimporter.log", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

/// 日志文件路径：容器内 Library/Application Support/CdnImporter/CdnImporter.log
/// （注入进程带 app 沙盒，写容器一定成功；越狱机的 /var/mobile/Library/Logs 常被沙盒拒绝）。
NSString *CdnImporterLogPath(void) {
    NSString *directory = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/CdnImporter"];
    return [directory stringByAppendingPathComponent:@"CdnImporter.log"];
}

static void CdnImporterLogAppend(NSString *line) {
    NSString *path = CdnImporterLogPath();
    NSFileManager *manager = [NSFileManager defaultManager];
    NSString *directory = [path stringByDeletingLastPathComponent];
    if (![manager fileExistsAtPath:directory]) {
        [manager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    }
    // 超过 4MB 就轮转一次，避免长时间导入把日志写爆。
    NSDictionary<NSFileAttributeKey, id> *attributes = [manager attributesOfItemAtPath:path error:NULL];
    if (attributes != nil && [attributes fileSize] > 4 * 1024 * 1024) {
        NSString *rotated = [path stringByAppendingPathExtension:@"1"];
        [manager removeItemAtPath:rotated error:NULL];
        [manager moveItemAtPath:path toPath:rotated error:NULL];
    }
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    if (data == nil) return;
    if (![manager fileExistsAtPath:path]) {
        [manager createFileAtPath:path contents:data attributes:nil];
        return;
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
    if (handle == nil) return;
    @try {
        [handle seekToEndOfFile];
        [handle writeData:data];
    } @catch (NSException *exception) {
        NSLog(@"[CdnImporter] 日志写入失败: %@", exception.reason);
    } @finally {
        [handle closeFile];
    }
}

void CdnImporterLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);

    static NSDateFormatter *formatter = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"MM-dd HH:mm:ss.SSS";
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    });
    NSString *stamp = [formatter stringFromDate:[NSDate date]];
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", stamp, message];

    NSLog(@"[CdnImporter] %@", message);
    dispatch_async(CdnImporterLogQueue(), ^{
        CdnImporterLogAppend(line);
    });
}

NSString *CdnImporterLogTail(NSUInteger maxLines) {
    __block NSString *text = @"";
    dispatch_sync(CdnImporterLogQueue(), ^{
        NSString *path = CdnImporterLogPath();
        NSData *data = [NSData dataWithContentsOfFile:path];
        if (data == nil) {
            text = @"";
            return;
        }
        // 只读尾部 256KB，避免面板拉日志把内存顶爆。
        NSUInteger limit = 256 * 1024;
        if (data.length > limit) data = [data subdataWithRange:NSMakeRange(data.length - limit, limit)];
        NSString *chunk = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (chunk == nil) chunk = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        if (chunk == nil) {
            text = @"";
            return;
        }
        if (maxLines == 0) {
            text = chunk;
            return;
        }
        NSArray<NSString *> *lines = [chunk componentsSeparatedByString:@"\n"];
        if (lines.count <= maxLines) {
            text = chunk;
            return;
        }
        NSArray<NSString *> *tail = [lines subarrayWithRange:NSMakeRange(lines.count - maxLines, maxLines)];
        text = [tail componentsJoinedByString:@"\n"];
    });
    return text;
}

#pragma mark - 路径

static NSString *CdnImporterApplicationSupport(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"];
}

/// 找一个「已经存在的」Local Store：优先 bundle id 对应的目录，其次 Application Support 下任意
/// `*/Local Store`（防 bundle id 与 AIR 实际使用的 app-id 不一致）。找不到返回 nil。
static NSString * _Nullable CdnImporterExistingStorageRoot(void) {
    NSFileManager *manager = [NSFileManager defaultManager];
    NSString *appSupport = CdnImporterApplicationSupport();
    NSString *bundleID = [NSBundle mainBundle].bundleIdentifier;
    NSMutableArray<NSString *> *candidates = [NSMutableArray array];
    if (bundleID.length > 0) {
        [candidates addObject:[appSupport stringByAppendingPathComponent:bundleID]];
    }
    NSArray<NSString *> *entries = [manager contentsOfDirectoryAtPath:appSupport error:NULL];
    for (NSString *entry in entries) {
        NSString *candidate = [appSupport stringByAppendingPathComponent:entry];
        if (![candidates containsObject:candidate]) [candidates addObject:candidate];
    }
    BOOL isDirectory = NO;
    for (NSString *candidate in candidates) {
        NSString *localStore = [candidate stringByAppendingPathComponent:@"Local Store"];
        if ([manager fileExistsAtPath:localStore isDirectory:&isDirectory] && isDirectory) {
            return localStore;
        }
    }
    return nil;
}

NSString *CdnImporterStorageRoot(void) {
    NSString *override = [[NSUserDefaults standardUserDefaults] stringForKey:CdnImporterStorageRootKey];
    if (override.length > 0) return override;

    NSString *existing = CdnImporterExistingStorageRoot();
    if (existing != nil) return existing;

    NSString *bundleID = [NSBundle mainBundle].bundleIdentifier;
    if (bundleID.length == 0) bundleID = @"com.leiting.wf";
    return [[CdnImporterApplicationSupport() stringByAppendingPathComponent:bundleID]
            stringByAppendingPathComponent:@"Local Store"];
}

/// asset_download 下的实际子目录名。
/// 主二进制里只找到 `asset/asset_download` 常量（约 @94427513）与 AIR 的 `Local Store` 字面量，
/// 没有找到 `dummy` 的直接字面量，但参考 APK（cn.startpoint.importer，逐字面量反编译）与仓库
/// docs/cdn/client-flow.md 两处独立证据都写 `dummy` ⇒ 默认 dummy，同时做「证据优先」的探测：
/// 若 asset_download 下已有子目录同时带 info.json 或 download/，那才是客户端真正在用的那个。
static NSString *CdnImporterAssetSubdirectory(void) {
    // 进程内缓存：引擎一次运行里会多次调用（空间检查 / info.json / partial / 收尾），
    // 每次都重扫的话，若 asset_download 下有多个候选子目录，可能前半程与后半程解析到不同目录。
    static NSString *cached = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSFileManager *manager = [NSFileManager defaultManager];
        NSString *assetDownload = [CdnImporterStorageRoot() stringByAppendingPathComponent:@"asset/asset_download"];
        NSArray<NSString *> *entries = [manager contentsOfDirectoryAtPath:assetDownload error:NULL];
        for (NSString *entry in entries) {
            if ([entry hasPrefix:@"."]) continue;
            BOOL isDirectory = NO;
            NSString *candidate = [assetDownload stringByAppendingPathComponent:entry];
            if (![manager fileExistsAtPath:candidate isDirectory:&isDirectory] || !isDirectory) continue;
            BOOL hasInfo = [manager fileExistsAtPath:[candidate stringByAppendingPathComponent:@"info.json"]];
            BOOL hasDownload = [manager fileExistsAtPath:[candidate stringByAppendingPathComponent:@"download"]];
            if (hasInfo || hasDownload) {
                if (![entry isEqualToString:@"dummy"]) {
                    NSLog(@"[CdnImporter] asset_download 下发现客户端实际使用的目录：%@（不是 dummy）", entry);
                }
                cached = candidate;
                return;
            }
        }
        cached = [assetDownload stringByAppendingPathComponent:@"dummy"];
    });
    return cached;
}

NSString *CdnImporterAssetDummyDir(void) {
    return CdnImporterAssetSubdirectory();
}

NSString *CdnImporterAssetDownloadDir(void) {
    return [CdnImporterAssetDummyDir() stringByAppendingPathComponent:@"download"];
}

NSString *CdnImporterInfoJsonPath(void) {
    return [CdnImporterAssetDummyDir() stringByAppendingPathComponent:@"info.json"];
}

NSArray<NSString *> *CdnImporterPartialFilePaths(void) {
    NSString *dummy = CdnImporterAssetDummyDir();
    NSString *root = CdnImporterStorageRoot();
    return @[
        [dummy stringByAppendingPathComponent:@"partial_downloaded.json"],
        [dummy stringByAppendingPathComponent:@"partial_downloaded.platform"],
        [dummy stringByAppendingPathComponent:@"partial_downloaded_android_thread.json"],
        [root stringByAppendingPathComponent:@"partial_downloaded.json"],
    ];
}

NSString *CdnImporterEffectivePatchBase(void) {
    NSString *override = [[NSUserDefaults standardUserDefaults] stringForKey:CdnImporterPatchBaseKey];
    if (override.length > 0) return override;
    return CDN_IMPORT_PATCH_BASE;
}

BOOL CdnImporterDeepVerifyEnabled(void) {
    id value = [[NSUserDefaults standardUserDefaults] objectForKey:CdnImporterDeepVerifyKey];
    if (value == nil) return NO;
    return [value boolValue];
}

#pragma mark - 小工具

BOOL CdnImporterEnsureDirectory(NSString *path, NSError **error) {
    if (path.length == 0) {
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"空目录路径");
        return NO;
    }
    NSFileManager *manager = [NSFileManager defaultManager];
    BOOL isDirectory = NO;
    if ([manager fileExistsAtPath:path isDirectory:&isDirectory]) {
        if (isDirectory) return YES;
        if (error != NULL) *error = CdnError(CdnImporterErrorIO, @"路径已存在且不是目录: %@", path);
        return NO;
    }
    return [manager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:error];
}

BOOL CdnImporterRemoveItem(NSString *path) {
    return [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
}

NSString *CdnImporterHumanBytes(uint64_t bytes) {
    static NSArray<NSString *> *units = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        units = @[@"B", @"KB", @"MB", @"GB", @"TB"];
    });
    double value = (double)bytes;
    NSUInteger unit = 0;
    while (value >= 1024.0 && unit + 1 < units.count) {
        value /= 1024.0;
        unit++;
    }
    if (unit == 0) return [NSString stringWithFormat:@"%llu B", bytes];
    return [NSString stringWithFormat:@"%.2f %@", value, units[unit]];
}

NSString *CdnImporterHumanCount(uint64_t count) {
    static NSNumberFormatter *formatter = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSNumberFormatter alloc] init];
        formatter.numberStyle = NSNumberFormatterDecimalStyle;
        formatter.groupingSeparator = @",";
    });
    NSString *text = [formatter stringFromNumber:@(count)];
    return text != nil ? text : [NSString stringWithFormat:@"%llu", count];
}

NSString * _Nullable CdnImporterSanitizeEntryPath(NSString *name) {
    if (name.length == 0) return nil;
    if ([name hasPrefix:@"/"] || [name hasPrefix:@"~"]) return nil;
    if ([name rangeOfString:@"\0"].location != NSNotFound) return nil;
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *component in [name componentsSeparatedByString:@"/"]) {
        if (component.length == 0 || [component isEqualToString:@"."]) continue;
        if ([component isEqualToString:@".."]) return nil;
        if ([component rangeOfString:@":"].location != NSNotFound) return nil;   // 防 ADS / 盘符
        [parts addObject:component];
    }
    if (parts.count == 0) return nil;
    return [parts componentsJoinedByString:@"/"];
}

NSString *CdnImporterTempDirectory(void) {
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:@"CdnImporter"];
    CdnImporterEnsureDirectory(directory, NULL);
    return directory;
}

NSDate *CdnImporterNow(void) {
    return [NSDate date];
}

NSDictionary<NSString *, id> * _Nullable CdnImporterJSONFromFile(NSString *path, NSError **error) {
    NSData *data = [NSData dataWithContentsOfFile:path options:0 error:error];
    if (data == nil) return nil;
    if (data.length == 0) return @{};
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    if (![object isKindOfClass:[NSDictionary class]]) {
        if (error != NULL) *error = CdnError(CdnImporterErrorFormat, @"JSON 顶层不是对象: %@", path);
        return nil;
    }
    return (NSDictionary<NSString *, id> *)object;
}

BOOL CdnImporterWriteJSONAtomically(NSDictionary<NSString *, id> *object, NSString *path, NSError **error) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:error];
    if (data == nil) return NO;
    NSString *directory = [path stringByDeletingLastPathComponent];
    if (!CdnImporterEnsureDirectory(directory, error)) return NO;
    NSString *temporary = [path stringByAppendingPathExtension:@"tmp"];
    [NSFileManager.defaultManager removeItemAtPath:temporary error:NULL];
    if (![data writeToFile:temporary options:NSDataWritingAtomic error:error]) return NO;
    NSFileManager *manager = [NSFileManager defaultManager];
    if (![manager fileExistsAtPath:path]) {
        return [manager moveItemAtPath:temporary toPath:path error:error];
    }
    // 用 replaceItemAtURL 而不是「先删再移」：删与移之间崩溃会连旧的 info.json 一起丢。
    NSURL *result = nil;
    NSError *replaceError = nil;
    NSURL *destination = [NSURL fileURLWithPath:path];
    if ([manager replaceItemAtURL:destination
                    withItemAtURL:[NSURL fileURLWithPath:temporary]
                   backupItemName:nil
                          options:0
                 resultingItemURL:&result
                            error:&replaceError]) {
        return YES;
    }
    // 某些文件系统/容器不支持 replace，退化到删+移（此时至少临时文件已经写好）
    [manager removeItemAtPath:temporary error:NULL];
    if ([manager removeItemAtPath:path error:NULL] && [manager moveItemAtPath:temporary toPath:path error:error]) {
        return YES;
    }
    // replace 失败且临时文件已被上面清掉：写回一份，别让调用方拿到「文件不存在」
    if (![manager fileExistsAtPath:path]) {
        if (![data writeToFile:path options:NSDataWritingAtomic error:error]) return NO;
    }
    if (error != NULL && *error == nil) *error = replaceError;
    return [manager fileExistsAtPath:path];
}
