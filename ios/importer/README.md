# iOS CDN 导入器（非越狱线）

把自建 CDN（`D:\wfcnmod\cdn`）里的 634 个归档**在设备本机**解压导入到游戏的沙盒资源目录，
让客户端启动时认为「资源已下载完成」，从而跳过官方 CDN 的 10.7GB 下载。

- 目标目录：`<容器>/Library/Application Support/com.leiting.wf/Local Store/asset/asset_download/dummy/`
  （`download/**` 放解压出来的资源，`info.json` 描述版本与规模）
- 交付形态：**一支注入游戏进程的 dylib**（`CdnImporter.dylib`）。非越狱设备上没有第二个进程能写进游戏的
  `Application Support`，所以导入器必须运行在游戏进程内；dylib 通过往 IPA 主二进制追加一条
  `LC_LOAD_DYLIB` + 重签侧载进入设备。
- 数据来源：**iOS 文件 App**（`UIDocumentPickerViewController`）。用户在文件 App 里选「文件夹」或「多个文件」，
  导入器拿到 security-scoped URL 后读取，归档本身留在 SMB / iCloud Drive / On My iPhone 原地，不占容器空间。

> 目录内容：ObjC 源码（`*.h` / `*.m`）+ 三个 Node 工具（`tools/`）+ 计划清单与生成表 + 非越狱注入器。
> 越狱注入线在 `ios/tweak/`，与本线互不依赖（本线**不使用** MobileSubstrate / Theos）。

## 1. 数据契约（634 归档 → 137,820 文件）

| 项目 | 值 |
| --- | --- |
| 基线段版本 | `1.4.0`（`full.archive[]`，`/asset/get_path` 快照） |
| 目标版本 | `1.4.54`（沿 `original_version → version` 逐级叠加 54 步 diff） |
| 归档数 | 634 = common 401（322 full + 79 diff）/ medium 218（164 + 54）/ ios 15（5 + 10） |
| 压缩态合计 | 10,748,428,364 字节 |
| 解压终态 | **137,820 个文件 / 10,191,161,030 字节**（= `info.json.totalSize`） |
| 解压顺序 | 严格按 `full.archive[]` 数组序 + diff 链顺序；**后解压的同名文件覆盖先解压的** |
| 跳过规则 | 条目名以 `/` 结尾（目录）、`.empty`、`.hash` 结尾的条目不解压 |
| 单条目校验 | 逐块累计 CRC32 与 zip 中央目录比对 |
| 归档校验 | 来源字节数必须等于计划字节数；可选深度 sha256（base64，与计划表比对） |

`info.json` 写入内容（客户端只读其中 `version` / `assetRecoveryInfo` / `totalSize` / `assetSizeKind` / `baseUrl`）：

```json
{
  "version": "1.4.54",
  "assetRecoveryInfo": [],
  "totalSize": 10191161030,
  "assetSizeKind": "fulfill",
  "baseUrl": "http://<自建服务器>/patch/cn/",
  "latestModifiedTimeOfArchive": "Sat, 09 Aug 2025 09:35:28 GMT"
}
```

导入成功后会删除 4 个标记文件：`<dummy>/{partial_downloaded.json,partial_downloaded.platform,partial_downloaded_android_thread.json}`
与 `<Local Store>/partial_downloaded.json`（客户端用它们判断「正在下载中」，留着会一票否决本地资源）。

## 2. 构建（Windows 上编不了，必须 macOS）

### 2.1 走 CI（推荐）

`.github/workflows/ios-importer.yml`：`workflow_dispatch` 手动派发，或向 `ios/importer/**` push 时自动跑。

- `test` 作业：ObjC 静态自检 + `quick:ios-importer` 测试组（计划一致性、注入器断言、lint 自身）。
- `build` 作业：用 iPhoneOS SDK 编译 `CdnImporter.dylib` → ad-hoc 签名 → 合成迷你 IPA 端到端冒烟注入 →
  产物上传 artifact（`CdnImporter-dylib` / `clang-log` / `injection-smoke`），同时把日志与产物推到
  `ci-diag/<run_id>` 一次性分支，编译失败时把 clang 错误按 `::error` 注解贴到运行页。
- 派发时可传 `patch_base`（写进 `info.json` 的 `baseUrl`；默认是 hygiene 占位地址 `http://192.168.1.10:8001/patch/cn/`，
  真实局域网地址只在派发参数里传，不要写进仓库文件）。

### 2.2 本地 Mac 手编

```bash
SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
xcrun -sdk iphoneos clang -arch arm64 -dynamiclib \
  -isysroot "$SDK" -miphoneos-version-min=14.0 -fobjc-arc -O2 -Wall \
  -install_name @executable_path/Frameworks/CdnImporter.dylib \
  ios/importer/*.m \
  -framework UIKit -framework Foundation -framework UniformTypeIdentifiers -lz \
  -o CdnImporter.dylib
codesign --force --sign - CdnImporter.dylib
```

## 3. 部署到设备（三步）

```bash
# ① 服务器改址（可选但常用）：把官方域名改写到自建服务器。它自带硬断言「ncmds/sizeofcmds 不变」，
#    所以必须在注入之前跑。
node client-patch/build/patch-ipa.mjs --ipa <官方 iOS-1.8.4.ipa> --host <自建服务器> --out step1.ipa

# ② 注入导入器：追加 LC_LOAD_DYLIB + 把 dylib 放进 Payload/<App>.app/Frameworks/
node ios/importer/tools/inject-dylib.mjs --ipa step1.ipa --dylib CdnImporter.dylib --out step2.ipa
#    加 --dry-run 可只做断言不落盘（推荐先干跑一次看 16 条断言）

# ③ 侧载：Sideloadly（Windows 可用）拖入 step2.ipa，用你自己的 Apple ID 重签并安装。
#    它会连带重签嵌套 dylib。免费账号签名 7 天到期，重签是原地覆盖安装，游戏数据容器保留，
#    已导入的 10.19GB 资源**不需要重做**。
```

注入器做了什么、保证了什么（`tools/inject-dylib.mjs`，纯 Node，Windows 可跑）：

- 定位主二进制（`Payload/<App>.app/<App>`，找不到时读 `Info.plist` 的 `CFBundleExecutable` 兜底）。
- 在**命令区末尾**（`32 + sizeofcmds`）写入一条 `LC_LOAD_DYLIB`（`cmdsize` 8 字节对齐，34 字符 install name → 72 字节），
  `ncmds+1`、`sizeofcmds+72`；段与所有 section 的文件偏移/尺寸**一个都不动**。
- dylib 条目写入 `Payload/<App>.app/Frameworks/<dylib>`，mode `0755`，紧跟主二进制条目。
- 落盘前 16 条断言（任一条失败就抛错、不写文件），关键几条：主二进制 `cryptid=0`、头部余量足够、
  **待写入的 72 字节原本全为 0**、文件长度不变、原有 load command 逐字节不变、所有 section 偏移不变、
  回读主二进制与 dylib 与内存一致、其余条目内容不变。报告写到 `<out>.build-report.json`。
- 幂等：对已注入过的 IPA 再跑一次不会重复写命令、不会重复加条目。

## 4. 在设备上使用

1. 先把 634 个归档准备好并送到设备可访问的位置（见第 5 节）。
2. 进游戏（导入器随进程加载，屏幕边缘会出现一个蓝色悬浮球「CDN」；拖动可换位置，位置记在 `NSUserDefaults`）。
3. 点球打开面板 → **选文件夹**（推荐，一次授权整棵子树）或**选文件**（可多选）。
4. 点**预检**：只做索引与匹配，不动任何文件；会列出「识别到的归档数 / 缺失清单 / 目标目录现状 / 可用空间」。
   面板另有 **深度校验(开/关)**（切到「开」后每个归档会整包比一遍 sha256，导入时间约翻倍，见第 6 节）
   与 **导出日志**（弹分享面板，可 AirDrop / 存到文件 App，见第 7 节）两个按钮。
5. 确认无误后点**开始导入**并保持游戏在前台（面板会自动禁用息屏）。进度条显示归档进度、已写文件数、
   压缩态已读字节与预估剩余时间；导入期间可**取消**（取消保留 partial 标记，游戏下次会自己走下载流）。
6. 完成后面板显示终态统计。若显示 `137820 个文件 / 10191161030 字节` 即与权威终态完全一致；
   随后**重启游戏**（本工具不 hook 客户端启动逻辑，重启后客户端读 `info.json` 判定资源已就绪）。

## 5. 怎么把资源送到设备

| 途径 | 做法 | 备注 |
| --- | --- | --- |
| SMB / NAS（推荐） | 文件 App → 连接服务器 → 挂载共享，把 `D:\wfcnmod\cdn` 的归档目录共享出去 | 归档原地读取，容器只占解压后的 10.19GB |
| iCloud Drive | 把归档拖进 iCloud Drive（需 10.7GB 云空间，或只拷一部分） | 逐卷传输，可分批导入 |
| On My iPhone | 用「文件」App 从电脑拷进设备本地 | 设备本地要腾出 10.7GB + 10.19GB |
| tar 分卷 | `node ios/importer/tools/build-tar.mjs --cdn D:\wfcnmod\cdn --out E:\wf-tar --volume-bytes 2000000000` | 把 634 个 zip 打成分卷 tar，传输时只需几个文件；导入器支持 `.tar` 与 `.tar.part.NN` |
| 整包 zip | 把若干归档再套一层 zip | 导入器会把内层 zip 当输入（stored 直接取窗口，deflate 先物化到临时文件） |

导入器按**基名**认领归档，所以归档放在哪个子目录、外层包了几层都不影响；
基名不命中时会尝试「按字节数唯一命中」的兜底认领，并在日志里记明。

若手上已有 Android 的 `cn-cdn.tar.part.00…05`（约 10.88GB，677 个归档），它包含 common + medium 层，
可覆盖本计划的 619/634 个归档；缺的 15 个 ios 层归档（96,492,743 字节）可另行单独导入，导入器允许
「缺包也继续」（缺的归档中若含后来被覆盖的文件，终态校验会给出提示）。

## 6. 失败与校验

- **空间预检**：要求可用空间 ≥ `10,191,161,030 + 1GB`，不足直接拒绝，不动任何文件。
- **缺归档**：默认严格模式 —— 有任一归档未识别就不动目标目录，只报出缺失清单（错误码 `MissingArchives`，
  `NSError.userInfo` 里带最多 50 条明细）。可在面板上改用「允许缺包继续」。
- **顺序覆盖**：始终按计划顺序解压（不是按用户选择顺序），保证「后覆盖先」的语义正确。
- **覆盖统计**：内部按「相对路径 → 已写字节」记账，覆盖同名文件时用 `新 - 旧` 修正终态总量，
  因此 `totalsMatch` 能真实反映终态是否等于权威值。
- **条目级校验**：每个条目解压时逐块累计 CRC32，与 zip 中央目录比对；不符即中止且**不写 `info.json`**。
- **深度校验**（面板开关 / `NSUserDefaults` 键 `CdnImporterDeepVerify`）：额外把整个归档文件的
  sha256（base64）与计划表比对，代价是每个归档多读一遍（10.7GB）。
- **zip-slip 防护**：条目名净化，拒绝绝对路径、`..`、`:`，写盘路径必须落在 `<dummy>/download/` 之内。
- **半成品清理**：解压失败会删掉失败条目的半成品文件；成功的归档则保留（可断点重来）。

## 7. 日志与排查

- 日志文件：`<容器>/Library/Application Support/CdnImporter/CdnImporter.log`（同一份内容也走 `NSLog`，
  可用 `idevicesyslog` 或 Xcode 看）。超过 4MB 轮转为 `.log.1`。
- 面板右侧就是实时日志，可点**导出日志**（弹系统分享面板：AirDrop 到 Mac、或存进「文件」App）取回
  `<容器>/Library/Application Support/CdnImporter/CdnImporter.log`。
- 常见问题：
  - 「没识别到任何归档」：确认选的是**文件夹**（不要选到只有外层压缩包的父目录）或直接多选 zip/tar 文件；
    若归档被重命名过，看日志里是否有「按字节数认领」记录。
  - 「识别到的归档数少于 634」：预检里会列出缺失基名，补齐后重新预检。
  - 导入中断后游戏开始下载：说明 partial 标记还在（取消是合法的），删掉 4 个 partial 或重新完成一次导入。
  - 悬浮球不出现：确认 dylib 注入成功（`otool -l worldflipper | grep -A2 LC_LOAD_DYLIB` 应能看到
    `@executable_path/Frameworks/CdnImporter.dylib`）且已被重签。

## 8. 自检与测试

```bash
node ios/importer/tools/lint-objc.mjs --stats      # ObjC 静态自检（括号/@interface↔@end 配对/声明↔实现）
node ios/importer/tools/verify-plan.mjs --sha256   # 计划 vs 本地 CDN 全量核对（缺失/字节数/sha256/实体表对账）
node ios/importer/tools/verify-plan.mjs --emit     # 重新生成 CdnImportPlan.generated.{h,m} 与 wanted-archives-ios.txt
node tools/test-workflow/run.cjs --group quick:ios-importer
```

`verify-plan.mjs` 支持 `--cdn <归档目录>` / `--snapshot <path 快照>` / `--entities <csv>`；
本机（`D:\wfcnmod\cdn`）当前核对结果：缺失 0 / 字节数不符 0 / sha256 不符 0 / 实体表对账 0 差异。
**改了 `tools/plan-lib.mjs` 之后必须重跑 `--emit`**，否则生成表与工具会漂移（`ios_importer_plan.test.cjs` 会拦住）。

## 9. 已知限制

- 不 hook 客户端原生/AS3 的下载流程（`AssetDownloadAne`、`GlobalLoading`）：本工具只负责「把文件铺好 + 写
  `info.json` + 清 partial」，导入完成后需要**重启游戏**让客户端重新判定。
- 导入必须前台执行（10.19GB 写入，后台会被系统挂起）。
- 免费开发者账号 7 天重签一次；重签不丢数据。
- 目标目录名 `dummy` 是从 Android 参考实现与 `docs/cdn/client-flow.md` 得到的；若设备上已存在
  `<...>/asset_download/<其他名>/`（含 `info.json` 或 `download/`），导入器会优先采用它并记日志，
  也可用 `NSUserDefaults` 键 `CdnImporterStorageRoot` 覆写。
- 越狱机不需要本线（用 `ios/tweak/` 的 MobileSubstrate 线即可）。

## 10. 文件清单

| 文件 | 作用 |
| --- | --- |
| `CdnImporterConfig.{h,m}` | 构建期宏、NSUserDefaults 键、错误与错误码、日志、路径解析、JSON 读写、条目名净化 |
| `CdnArchiveSource.{h,m}` | 随机访问抽象（文件 / 内存 / 多源拼接 / 子窗口）+ 定长读 + sha256(base64) |
| `CdnZipArchive.{h,m}` | zip 中央目录解析（含 ZIP64）、流式 inflate + CRC32、条目物化 |
| `CdnTarIndex.{h,m}` | tar / tar 分卷成员索引（只读头，不解压；支持 GNU 长名与 pax） |
| `CdnImportPlan.{h,m}` + `CdnImportPlan.generated.{h,m}` | 634 条计划表（编译进 dylib）、按基名/字节数检索、权威终态常量 |
| `CdnArchiveIndex.{h,m}` | 把用户选择的输入识别成「计划基名 → 归档句柄」（散装 zip / tar 成员 / 整包 zip 成员） |
| `CdnImportEngine.{h,m}` | 四阶段导入：索引 → 缺包检查 → 按计划顺序解压 → 写 `info.json` + 清 partial |
| `CdnImporterOverlay.{h,m}` | 穿透式覆盖窗口 + 可拖动悬浮球 + 保活看门狗 |
| `CdnImporterPanelViewController.{h,m}` | 面板 UI：选文件夹/选文件/预检/开始/取消/关闭/深度校验开关/导出日志 |
| `CdnImporterEntry.m` | `__attribute__((constructor))` 入口（非越狱线没有 MobileSubstrate 的 `%ctor`） |
| `tools/verify-plan.mjs` + `tools/plan-lib.mjs` | 计划推导/核对/生成（Node，跨平台） |
| `tools/inject-dylib.mjs` | 非越狱注入器（LC_LOAD_DYLIB + dylib 入 bundle，16 条断言） |
| `tools/make-mini-ipa.mjs` | 合成迷你 IPA（CI 冒烟与测试用，不依赖官方包） |
| `tools/build-tar.mjs` | 把归档打成分卷 tar（便于传输），自带回读校验 |
| `tools/lint-objc.mjs` | ObjC 静态自检 |
| `assets/wanted-archives-ios.txt` | 634 行计划清单（人读用；设备侧读的是编译进 dylib 的 C 表） |
