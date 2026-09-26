# CLIENT-BUILD —— 安卓客户端「一条命令出包」产线

`client-patch/build/build-client.mjs`：把官方 APK 素材打成可安装产物的一条命令流水线。

```
基线 APK
  → 〔可选 AS3 层回编译钩子，默认不执行〕
  → 端点确保（把 API 基址常量改到 --host:--port）
  → 纯 Node 回封 zip
  → zipalign -p -f 4
  → apksigner sign（缺凭据则明确产出「未签名（缺凭据）」）
  → apksigner verify --verbose
  → <out>.build-report.json
```

设计口径来自服主：**换服务器地址 = 改一处 + 重构建**。所以地址不进配置文件、不进运行期参数，而是编译期常量，
由本脚本在打包时写进客户端。

---

## 1. 最快上手

```bash
# 只预览，不产生任何文件（推荐第一次先跑这个）
node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk \
  --host 192.168.1.10 --port 8001 \
  --out out/sp-cn.apk \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner" \
  --dry-run

# 真出包（未签名）
node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk \
  --host 192.168.1.10 --port 8001 \
  --out out/sp-cn.apk \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner"

# 真出包 + 签名（口令只从环境变量读）
SP_KS_PASS='...' node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk \
  --host 192.168.1.10 --port 8001 \
  --out out/sp-cn.apk \
  --ks ../../../keystore/sp-cn.keystore --ks-pass-env SP_KS_PASS \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner"
```

> 上面的 `192.168.1.10` 只是占位示例（仓库卫生脚本只放行这一个 192.168 地址）。
> 你自己局域网的地址**只经 `--host`/`--port` 传进来**，脚本与仓库里不存任何实例地址。

示例里 `$ANDROID_BUILD_TOOLS` 指 build-tools 目录（内含 `zipalign`、`apksigner`）。
不想设变量就写绝对路径，或见下面「工具定位顺序」。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--base <file>` | **必填**。基线素材。`.apk` 走本产线；`.ipa` 转交 `patch-ipa.mjs`（iOS 唯一补丁入口） |
| `--host <ip>` | **必填**。服务端地址。**缺了就拒绝执行**（退出码 1） |
| `--port <port>` | **必填**。1..65535 |
| `--out <file>` | **必填**。产物路径，不能与 `--base` 同路径 |
| `--ks <file>` | keystore。可缺省 ⇒ 产出未签名 APK |
| `--ks-pass-env <VAR>` | 口令所在的环境变量名，默认 `SP_KS_PASS` |
| `--ks-alias <name>` | key alias，默认 `spcn` |
| `--require-signature` | 没有有效签名就判 FAIL（CI 用；退出码 2） |
| `--as3-hook <file.mjs>` | 可选 AS3 层回编译钩子（默认不执行；见 §6） |
| `--ffdec <jar>` / `--java <exe>` | FFDec 与 java 位置（钩子需要；也用于版本留证） |
| `--allow-ffdec-version-mismatch` | 显式承担版本不一致的风险（降为警告） |
| `--zipalign` / `--apksigner` | 工具位置 |
| `--rename-package` / `--rename-to <pkg>` | 包名改写（P12 的能力，本脚本只透传；见 §7） |
| `--work <dir>` | 临时目录，默认系统 temp。**必须纯 ASCII**（FFDec 硬要求） |
| `--keep-work` | 保留临时目录（排查用） |
| `--dry-run` | 只打印完整命令序列，**不产生任何文件** |
| `--help` | 打印帮助 |

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功（**未签名不算失败**，除非加了 `--require-signature`） |
| `1` | 参数/前置条件错（缺 `--host`、`--port` 越界、`--out` 撞 `--base`、缺 P12 脚本……），**不落任何文件** |
| `2` | 运行期硬失败或**任何一条断言 FAIL**。报告照落，但产物**不要分发** |

---

## 2. 它到底改了什么

只有一处字节级改动：SWF 里 ABC 常量池的那对「scheme + host」。

```
官方常量对：  05 "https" + 1a "shijtswygamegf.leiting.com"   → 33 字节
替换为：      04 "http"  + 1b "00000000@<host>:<port>"        → 33 字节（等长守恒）
```

* 长度**必须**守恒 —— 常量池里长度前缀 `u30` 与后续偏移都依赖它，所以脚本会把「长度不变」当成断言而不是愿望。
* 官方 host 在 SWF 里出现次数**必须**是 1。不是 1 就直接拒绝执行：地址是编译期常量，改错一处就改坏整份 ABC。
* 这个能力复用 P10-A 的 `client-patch/build/lib/ios-abc.mjs`（纯 Buffer 函数，与平台无关）。
* **绝不能用字节 grep 判断补丁是否生效**：SWF 在 APK 里通常还是 Deflate 压缩的，直接搜原始字节必然搜不到。
  脚本一律先解压 entry 再比对，报告里的站点前后指纹也是这么来的。

实测过的两份基线（形态不同，产线都支持）：

| 基线 | 主 SWF 形态 | 常量对偏移 | 逻辑大小 |
| --- | --- | --- | --- |
| `apkipa/V1.8.1.apk` | **FWS**（未压缩） | `0xb9c231` | 29 052 839 B |
| `apkipa/安卓v15.2.apk` | **CWS**（Deflate） | `0xbaa988` | 29 209 315 B |

除了这 29 个字节，产线还会**摘掉基线自带的 v1 签名件**（`META-INF/MANIFEST.MF`、`META-INF/*.SF`、`META-INF/*.RSA`）：
主 SWF 已经改了，旧签名必然失效，留着只会让 `apksigner verify` 报错。
注意 `META-INF/com.android.tools.metadata/**`（Play/Oppo 的市场元数据）**不是**签名件，不会被摘。

回封用的是 `client-patch/build/lib/zip-ipa.mjs`（零依赖 ZIP 引擎），逐条保留
`method` / `versionMadeBy` / `externalAttr`（后者决定 unix 权限位）。**不需要 `jar`、不需要 apktool。**

---

## 3. 站点指纹与构建报告

每次出包都在 `<out>.build-report.json`（schema `sp-cn.client-build/v1`）留证，关键字段：

* `inputs.base.sha256` / `output.sha256` —— 素材与产物的字节级身份；
* `siteFingerprint.before|after` —— 常量对的偏移、出现次数、字节数、scheme/host 计数（**前后对照**）；
* `swf.sha256Before|after` —— 主 SWF 逻辑内容的哈希（两者必须不同，这是「补丁真的进去了」的硬证据）；
* `rewrite.diffRanges` —— 实际改动的字节范围；
* `zip.droppedV1Signatures` —— 摘掉了哪几条；
* `tools.ffdec.version|path` —— **实际用到的 FFDec 版本与路径**（版本会改变 ABC 重写结果）；
* `signing.*` —— 是否签名、keystore 文件名、口令**变量名**、verify 结果、签名证书 DN；
* `assertions.passed|failed|list` —— 逐条断言；
* `warnings` / `unverified` —— 降级警告与**未验证项**（真机安装、启动等）。

报告里**只记 keystore 的文件名，不记路径；口令的值永远不进报告**。

---

## 4. 签名与 keystore

### 生成自己的 keystore

```bash
keytool -genkeypair -v \
  -keystore sp-cn.keystore -alias spcn \
  -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12
```

口令**不要写进任何文件、不要提交仓库、不要写进脚本**。约定只经环境变量传递：

```bash
export SP_KS_PASS='...'      # 或任何自己起的变量名，配合 --ks-pass-env
```

脚本把它转成 apksigner 的 `env:` 语法（`--ks-pass env:SP_KS_PASS`），口令本身既不落盘也不进报告。
`keystore` 文件本身放在**仓库外**（例如 `D:\wfcnmod\keystore\`），仓库里只留路径示例。

### ⚠️ 自建 keystore 的后果：不能覆盖安装他人包

Android 只允许**签名一致**的包互相覆盖安装。用你自己生成的 keystore 签名后：

* **装不上**同包名的官方包/第三方包之上，官方包也盖不上你的；
* 想共存只能**改包名**（`android:package`，P12 的能力）——那会让系统把两者当成两个应用；
* 换 keystore 就等于换应用身份：老 key 签的存档/更新链全断。

另外 AIR 的 `SharedObject` 存档按包名隔离，所以改包名天然是一套干净的新存档（这正是 P12 的用途）。

### 缺凭据时的行为

没给 `--ks`，或者 `--ks-pass-env` 指向的环境变量为空时，产线**照样跑完**，并：

* 在 stdout 明确打 `[WARN] 未签名（缺凭据）：……`；
* 报告里 `signing.signed = false`、`signing.reason` 写明原因、`unverified` 里挂一条；
* 产出「已打好未签名」的 APK。

**它绝不会伪造一条签名成功。** 未签名包 Android 直接拒装，请把产物当成中间物。
CI 里想要「没签名就算失败」就加 `--require-signature`。

---

## 5. 工具定位顺序

`zipalign` / `apksigner` 依次在下列位置找，全找不到就**明确报错**（不会瞎猜一个然后跑出可疑产物）：

1. `--zipalign` / `--apksigner`；
2. 环境变量 `ZIPALIGN` / `APKSIGNER`；
3. 环境变量 `ANDROID_BUILD_TOOLS`（指向 build-tools 目录）；
4. `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `ANDROID_SDK` 下的 `build-tools/<最高版本>/`；
5. `PATH`。

`--work` **必须是纯 ASCII 路径**，否则脚本直接拒绝：FFDec 在非 ASCII 路径上会静默失败（已知坑），
而临时目录一旦踩坑，症状会出现在完全不相干的地方。

---

## 6. AS3 层回编译（默认关闭的可注入钩子）

默认路线（ABC 常量池成对等长改写）**完全不需要 FFDec**，93 MB 的包几秒钟出结果。
只有「还要改 AS3 逻辑本身」时才需要回编译，那是一条独立的、可选的路：

```bash
node client-patch/build/build-client.mjs ... \
  --as3-hook path/to/my-hook.mjs --ffdec /path/to/ffdec.jar
```

钩子模块导出：

```js
export async function transformSwf(ctx) {
    // ctx = { logicalSwf, swfPath, entry, host, port, hostPort,
    //         ffdecJar, javaExe, ffdecVersion, workDir, log }
    return { swf: patchedBuffer, notes: ["做了什么"] }
}
```

不传 `--as3-hook` 时这一阶段**完全不执行、不碰 FFDec**。执行钩子时会先探测 FFDec 版本：
与 README 要求的 **24.0.1** 不一致就拒绝执行（`--allow-ffdec-version-mismatch` 可强行降级为警告）。

FFDec 的已知坑（产线已经替你做掉一半，钩子里仍要注意）：

* APK/SWF 必须先落到**纯 ASCII 路径**（临时目录已由脚本强制）；
* 必须 `-Djava.awt.headless=true`；
* **单类 `-replace` 会让 FFDec 重写整份 ABC** ⇒ 任何 AS3 改动都要整类替换，
  且**绝不能用字节 grep 判断补丁是否生效**，要回读并校验类指纹；
* 禁用 `-importScript` 路径。

> **为什么默认不做 AS3 回编译**：AS3 整类回编译的可行性结论（P0）还没出，而且它对 FFDec 版本敏感 ——
> 版本不同，重写出来的 ABC 就不同。所以本产线把它做成钩子：等 P0 有结论再插进来，主线不受影响。

---

## 7. 包名改写（`--rename-package`）

`--rename-package` 默认**关闭**。打开时本脚本**只做透传**，改名的逻辑在 P12 交付的
`client-patch/tools/rename-package.mjs` 里（要同步改 AXML 的 `package`、`assets/META-INF/AIR/application.xml`
的 `<id>`、以及所有 `${applicationId}` 派生的 provider/authority/permission）。

该脚本**还没交付**时，本产线会明确报错并**不做事**：

```
ERROR --rename-package 需要 P12 交付的 client-patch/tools/rename-package.mjs，但该文件不存在（P12 未交付）
```

它**不会静默忽略**这个开关 —— 静默忽略会让人以为包名改了，装上去才发现盖掉了官方包。

---

## 8. 与旧脚本的关系

`client-patch/apply.sh` 是早先的 20 行 bash：假定你手工把 `.as` 文本改好、手工跑 FFDec、手工敲 apksigner。
它只覆盖「改源文本」这一小步，没有回读断言、没有站点指纹、没有构建报告，也不管工具定位。

本产线在**不改动** `apply.sh` 的前提下接管整条链路。两者可以并存：`apply.sh` 仍然描述
「哪两个源文件、改哪两处」，那仍然是 AS3 钩子要复现的语义。

---

## 9. 测试

```bash
node --test tools/build_client.test.cjs
```

19 条，全部用**合成夹具**（自造 SWF + 自造 APK + 假 zipalign/apksigner/java 桩），不碰 `apkipa/` 里的真素材。
覆盖：缺 `--host` 拒绝、报告结构、host/port 组装、`--rename-package` 缺 P12 报错、未签名路径的明确提示、
CWS 与 FWS 两种形态、签名链、FFDec 版本不匹配的拒绝与降级、`--dry-run` 不落任何文件。
