//
//  CdnImporterConfig.h
//  CdnImporter —— iOS CDN 归档导入器（非越狱线：独立 dylib，经 LC_LOAD_DYLIB 注入 app 进程，
//  重签后侧载；不依赖 MobileSubstrate，不做任何 hook）
//
//  职责：构建期常量、沙盒路径解析、日志、通用小工具。
//  设计约束见 ios/importer/README.md。
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// info.json 的 baseUrl。客户端只把它当 Recovery 直链前缀（base_url + file.hash），而服务端
/// files_list 恒为空的 recovery/empty.csv ⇒ 该字段近乎惰性。构建期用 -DCDN_IMPORT_PATCH_BASE
/// 覆盖（Makefile 传 CDN_IMPORT_PATCH_BASE_HOST），运行期可用 plist 键覆写。
#ifndef CDN_IMPORT_PATCH_BASE
#define CDN_IMPORT_PATCH_BASE @"http://192.168.1.10:8001/patch/cn/"
#endif

/// info.json 的 latestModifiedTimeOfArchive。客户端只把它抄进 info.json / partial_downloaded.json，
/// 没有任何比较逻辑 ⇒ 写一个固定字符串即可。
#ifndef CDN_IMPORT_ARCHIVE_TIME
#define CDN_IMPORT_ARCHIVE_TIME @"Sat, 09 Aug 2025 09:35:28 GMT"
#endif

/// plist / NSUserDefaults 覆写键（与 SpLoginConfig 同套路：plist 优先于编译期常量）。
extern NSString *const CdnImporterPatchBaseKey;      ///< NSString，覆盖 baseUrl
extern NSString *const CdnImporterStorageRootKey;    ///< NSString，覆盖 Local Store 根（只该用于调试）
extern NSString *const CdnImporterDeepVerifyKey;     ///< BOOL，逐归档校验 sha256（慢，默认 NO）
extern NSString *const CdnImporterBallXKey;          ///< double，悬浮球位置
extern NSString *const CdnImporterBallYKey;          ///< double，悬浮球位置

#pragma mark - 错误

extern NSString *const CdnImporterErrorDomain;

typedef NS_ENUM(NSInteger, CdnImporterErrorCode) {
    CdnImporterErrorIO = 1,
    CdnImporterErrorFormat,
    CdnImporterErrorPlan,
    CdnImporterErrorCancelled,
    CdnImporterErrorMissingArchives,
};

/// userInfo 里附「逐条明细」的键（如缺归档清单）；面板会把它逐行打印出来。
extern NSString *const CdnImporterDetailsKey;

NSError *CdnError(CdnImporterErrorCode code, NSString *format, ...) NS_FORMAT_FUNCTION(2, 3);
NSError *CdnErrorWithDetails(CdnImporterErrorCode code, NSArray<NSString *> * _Nullable details,
                             NSString *format, ...) NS_FORMAT_FUNCTION(3, 4);

#pragma mark - 日志

/// NSLog + 追加写容器内日志文件（沙盒内一定可写；越狱机的 /var/mobile/Library/Logs 对
/// 沙盒进程通常不可写，因此不作为主路径）。
void CdnImporterLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

/// 日志文件路径（容器内 Library/Application Support/CdnImporter/CdnImporter.log）。
NSString *CdnImporterLogPath(void);

/// 读日志尾部（面板展示用）；maxLines <= 0 表示不限制行数。
NSString *CdnImporterLogTail(NSUInteger maxLines);

#pragma mark - 目标目录（app 沙盒内）

/// 解析 Local Store 根：优先「已存在的 <Application Support>/<某 id>/Local Store」，
/// 否则按 bundle id 拼（并创建）。AIR 的 File.applicationStorageDirectory 就落在这里。
NSString *CdnImporterStorageRoot(void);

/// <Local Store>/asset/asset_download/dummy
NSString *CdnImporterAssetDummyDir(void);

/// <dummy>/download —— 解压落盘根（与参考 APK 的 new File(fileResolveStorageDir, "download") 一致）
NSString *CdnImporterAssetDownloadDir(void);

/// <dummy>/info.json
NSString *CdnImporterInfoJsonPath(void);

/// partial_downloaded.json / partial_downloaded.platform / partial_downloaded_android_thread.json
NSArray<NSString *> *CdnImporterPartialFilePaths(void);

/// 生效的 baseUrl（plist 覆写 > 编译期常量）
NSString *CdnImporterEffectivePatchBase(void);

/// 是否开启逐归档 sha256 深度校验
BOOL CdnImporterDeepVerifyEnabled(void);

#pragma mark - 小工具

BOOL CdnImporterEnsureDirectory(NSString *path, NSError **error);
BOOL CdnImporterRemoveItem(NSString *path);
NSString *CdnImporterHumanBytes(uint64_t bytes);
NSString *CdnImporterHumanCount(uint64_t count);

/// ZIP 条目名 → 相对落盘路径：拒绝绝对路径与 `..`，去掉前导 `./`；非法返回 nil。
NSString * _Nullable CdnImporterSanitizeEntryPath(NSString *name);

NSString *CdnImporterTempDirectory(void);
NSDate *CdnImporterNow(void);

NSDictionary<NSString *, id> * _Nullable CdnImporterJSONFromFile(NSString *path, NSError **error);
BOOL CdnImporterWriteJSONAtomically(NSDictionary<NSString *, id> *object, NSString *path, NSError **error);

NS_ASSUME_NONNULL_END
