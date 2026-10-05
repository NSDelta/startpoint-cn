# 新增 CDN 补丁的固定工序

> 状态：工序已按 1.4.55 / 1.4.56 两个补丁包的实际投放与验收整理，命令与产物形状都是现成可复制的。契约本身见 [`patch-overlay.md`](./patch-overlay.md)，机器可读清单见 [`patch-manifest.schema.json`](./patch-manifest.schema.json)。

本页把"再加一个 CDN 补丁"拆成五个阶段：准备、内容层、iOS 壳层、校验、投放。每个阶段都有单条命令和明确的通过标准；任何一步不过，都不要进入下一步。

## 0. 一次说清楚的最小流程

```text
1) 出内容：改 converter / 重打 archive-common-diff（内容层是真正承载 mod 的那层）
2) 建目录：CDN_DIR/patches/<targetVersion>/{archive-common-diff,archive-medium-diff,archive-android-diff}
3) 写清单：patch-manifest.json（schema / baseVersion / targetVersion / compatibleClient / archives）
4) 补 iOS 壳：node tools/attach_ios_layer_to_patch.cjs --patches <patches 根>
5) 过门禁：npm run cdn:patch:check   →   status: valid
6) 打成交付：node tools/pack_ios_patch_delivery.cjs --patches <patches 根> --out _out
7) 投放验收：重启受支持入口 + 用真实 device 头各取一次 get_path
```

一共只有 4 条命令需要记（第 4、5、6 步）；第 1 步是内容作者自己的事，第 7 步是验收。

## 1. 准备：确认你在加哪条版本边

一条补丁 = 一条版本边 `<baseVersion> -> <targetVersion>`，对应一个 `CDN_DIR/patches/<targetVersion>/` 目录。先确认三件事：

- **版本边还没下发过。** 已经下发给客户端的边不能静默改名、覆盖或压缩，否则停留在中间版本的客户端会失去唯一升级路径（见 `patch-overlay.md` 的"内层 ZIP 是升级图的唯一来源"）。
- **目标版本可达。** 新边接在现有链尾：`... -> <baseVersion> -> <targetVersion>`。插入中间版本要求同时重建后续差分，否则升级图出现第二末端或断点，受支持入口会拒绝启动。
- **归档内层文件名符合形状。** 差分归档必须匹配

  ```text
  pinball-<fromVersion>-<toVersion>-<index>-<token>.zip
  ```

  其中 `<fromVersion>` / `<toVersion>` 是两段三段号，`<index>` 从 1 起连续，`<token>` 是发布方派生值（8 位十六进制即可）。服务端只从文件名解析版本边与 order，**不解释 token，也不要求 token 等于文件 SHA-256 前 8 位**。

## 2. 内容层：三层（Android 视角）

`patches/<targetVersion>/` 下必须有这三层，每层至少一个 inner ZIP，且每层 order 从 1 起连续：

| 目录 | manifest `layer` | 作用 |
|---|---|---|
| `archive-common-diff/` | `common` | 真正承载 mod 内容；Android 与 iOS 都从这里取 |
| `archive-medium-diff/` | `medium` | Catalog `quality` 层，中画质资源清单 |
| `archive-android-diff/` | `android` | Android platform 层；官方发布里通常就是空壳 |

平台层为空是正常的：`archive-medium-diff/` 与 `archive-android-diff/` 里常见的就是 22 B 的空 ZIP（`50 4b 05 06` + 18 个 0）。服务端不解析归档内容，只校验 manifest 声明的**字节数**与**完整 SHA-256**，所以空壳照样合法。

写清单时每个文件都要算全 SHA-256：

```json
{
  "schema": 1,
  "baseVersion": "1.4.55",
  "targetVersion": "1.4.56",
  "compatibleClient": "CN 1.8.1",
  "archives": [
    {
      "relativePath": "archive-common-diff/pinball-1.4.55-1.4.56-1-5f083b4d.zip",
      "layer": "common",
      "order": 1,
      "bytes": 8499,
      "sha256": "0a3b406b9c1fd040ef183e2ee04dda39094874b7f0ab45b3baf883f4f792bca4"
    }
  ]
}
```

清单键名是 `schema`（不是 `schemaVersion`），`compatibleClient` 必须是 `CN 1.8.1`，`baseVersion` 省略表示无依赖；目录名必须等于 `targetVersion`。

## 3. iOS 壳层：一条命令

iOS 那一层只做占位：官方发布的 iOS 差分本来就是 **111 B、单条目 `.empty` 的 ZIP**（本地头 30 B + 名 6 B + 数据 1 B + 中央目录 46 B + 名 6 B + EOCD 22 B）。mod 的真实内容全在 `common` 层，所以 iOS 层不需要承载任何字节，只要让 iOS 视图在对应版本边上拿得到一条合法归档。

```bash
# 幂等：已经有合法 iOS 层就报 unchanged，不会重复写入
node tools/attach_ios_layer_to_patch.cjs --patches <patches 根>
```

工具做四件事：

1. 在 `<patches 根>/<targetVersion>/archive-ios-diff/` 生成（或复用）该边的 111 B 空壳，文件名按 `pinball-<baseVersion>-<targetVersion>-1-<token>.zip` 推导；
2. 把 `layer: "ios"` 条目追加进 `patch-manifest.json`，`order` 取文件名里的 `<index>`；
3. **`bytes` / `sha256` 从磁盘真实文件反填**——iOS 层不在 Overlay 扫描范围内，启动期 SHA 校验不覆盖它，所以清单必须由工具回填而不是手敲；
4. 复跑时逐条比对 bytes/sha256，一致就只打印 `unchanged`。

常用开关：

```bash
node tools/attach_ios_layer_to_patch.cjs --patches <patches 根> --dry-run      # 只报告不落盘
node tools/attach_ios_layer_to_patch.cjs --patches <patches 根> --stubs <空壳目录>
```

`--stubs` 只在需要复用别处生成好的空壳时用。空壳由 `tools/make_ios_stub_archives.cjs` 生成，同一对版本边永远产出同一份字节（每条边一个确定性的 MS-DOS 时间戳，所以各边的 SHA-256 互不相同）：

```bash
# 只给新边出壳（工具会自行推导文件名；不写 --stubs 也能装）
node tools/make_ios_stub_archives.cjs --out _out/ios-stubs --cdn <CDN_DIR>/cn \
  --edges "1.4.55-1.4.56"

# 把基线里缺 iOS 归档的版本边一次补齐（只读基线，不修改 cn）
node tools/make_ios_stub_archives.cjs --out _out/ios-stubs --cdn <CDN_DIR>/cn --fill-baseline
```

## 4. 校验：发布门禁

```bash
npm run cdn:patch:check
```

期望输出形如：

```json
{"schemaVersion":1,"status":"valid","baselineVersion":"1.4.54","targetVersion":"1.4.56",
 "patchCount":2,"patchArchiveCount":6,"patchBytes":2370954}
```

摘要里的 `patchArchiveCount` **只数进 Android Catalog 的层（common/medium/android）**，不含 iOS 层——安装两个补丁、每个补丁四层时它仍然报 6，这是预期而不是漏算。

这条命令做只读校验：目录名、manifest 结构、四层归档存在性、每层 order 连续性、版本图可达性、字节数与完整 SHA-256。它不会取得 Content Sync 锁、不转换 orderedmap、不写对象，也不激活 Content Release。

再补两条按清单做过的事情：

- `patch-manifest.json` 能被 [`patch-manifest.schema.json`](./patch-manifest.schema.json) 接受；
- `archive-ios-diff/` 里的文件与清单条目一一对应（不多不少）。

## 5. 打成交付 ZIP

```bash
node tools/pack_ios_patch_delivery.cjs --patches <patches 根> --out _out
```

产物是 `<版本>.zip`，顶层就是 `<版本>/`，其下直接是 `patch-manifest.json` 与四个 `archive-*-diff/` 目录——与"安装 CDN 增量补丁"一节的口径一致。打包前工具做双向覆盖校验（磁盘上有未声明的文件、或清单声明了磁盘上没有的文件，都直接拒绝）。

投放方拿到的操作是：

1. 保持现有 `CDN_DIR/cn` 不动；
2. 手动建 `CDN_DIR/patches/<版本>/`；
3. 把 ZIP 里的内容解压进这个目录（解压后 `patch-manifest.json` 直接位于版本目录内）；
4. 重启受支持入口（启动前 Content Sync 完成发现与校验）。

外层 ZIP 和未知 ZIP 不会被服务端扫描，服务端只读 manifest 明确声明的 inner ZIP。

## 6. 验收：按真实 device 头各取一次

```bash
# device 必须走请求头，body 里的 device 字段会被忽略
curl -H 'device: ios'     -H 'res_ver: 1.4.55' <base>/api/index.php/asset/get_path
curl -H 'device: android' -H 'res_ver: 1.4.55' <base>/api/index.php/asset/get_path
```

通过标准：

- `device: ios` 的对应版本边 `band` 里是 `common + medium + archive-ios-diff/<file>.zip` 三类，其中 iOS 件来自 `patches/<版本>/`；
- `device: android` 同一条边第三件是 `archive-android-diff/`，**不出现任何 `archive-ios-diff/`**；
- 每个 `band` 条目的 `location` 都能直接 GET 到 200，且字节数与 manifest 一致；
- **同一条边同一种 iOS 归档只出现一次**（补丁覆盖基线，不是两条并列下发）。

`device` 取值：`ios` 或 `1` 走 iOS 视图；`android`、`2` 或缺省走 Android 计划。

## 7. 别再踩的坑

- **token 不是哈希。** 内层文件名末尾的 8 位十六进制与文件 SHA-256 无关；服务端只按 `<from>-<to>-<index>` 槽位判定重复，所以同一条边的基线与补丁条目同名同字节是**正常**的，会去重成一条。
- **`schemaVersion` 不是清单键名。** 清单顶层用 `schema: 1`，写成 `schemaVersion` 会直接被拒。
- **iOS 层不在启动期 SHA 校验范围内。** 它是被过滤进 `ignoredPaths` 的，清单里的 bytes/sha256 必须由 `attach_ios_layer_to_patch.cjs` 从磁盘回填；手敲一个对不上的值不会在启动时报错，但会让 iOS 侧下载校验失败。
- **只加 `archive-ios-diff/` 不改 manifest 等于没加。** 服务端不按扩展名递归发现补丁文件，只认清单声明的条目。
- **`patches/` 里不要留 README 之类的额外文件。** 版本目录的覆盖校验按文件逐一比对，多余文件会让交付打包拒绝执行。
- **补丁目录必须是普通目录。** 用 junction / 符号链接指向别处的 CDN 根会在启动时报 `archive source root is not a regular directory`；复制时用 `robocopy /E`，不要用 `mklink /J`。
