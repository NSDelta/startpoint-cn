# 客户端最小补丁(免登录 + 重定向)

让官方 CN 客户端连接本服务,仅需两处改动。补丁作用于 FFDec 反编译出的 AS3 源码。

## 前置要求(自备,均不随本目录分发)

- FFDec 24.0.1(SWF 反编译 / 回封;仅"注册验证码版"需要)
- 一份官方 CN 客户端 APK(源)
- 一个签名 keystore(重打包后签名)
- Android build-tools(`zipalign` / `apksigner`)

## 两处改动

1. **免登录** — `pinball/config/core/DevConfig.as`
   - `public static var sdkDummy:Boolean = false;`
   - → `public static var sdkDummy:Boolean = true;`
   - 效果:跳过雷霆 SDK 登录,使用假 userId;支付 / 推送 / 实名等真实 SDK 功能变 stub。
2. **重定向到本服** — `pinball/config/gbits/DevConfig_gf_android.as`
   - 域名 `shijtswygamegf.leiting.com` → `<你的服务器 host:port>`(如 `192.168.1.10:8001`)
   - 协议 `"https"` → `"http"`

## 应用步骤(手动)

1. 用 FFDec 把源 APK 内的主 SWF 反编译 / 导出为 AS3 脚本目录(记为 `EXPORT_DIR`)。
2. 运行 `bash apply.sh <EXPORT_DIR> <host:port>`(或按上文手动改两文件)。
3. 用 FFDec 把改后的 AS3 导回 SWF,替换进 APK,`zipalign` + `apksigner` 重签名。
4. 安装到设备。

## 一条命令的产线(推荐)

上面那套手工步骤现在有产线版本:`client-patch/build/build-client.mjs`
(完整参数、退出码、构建报告字段见 [`CLIENT-BUILD.md`](./CLIENT-BUILD.md))。

```bash
# 先预览(--dry-run 不落任何文件)
node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk --host 192.168.1.10 --port 8001 \
  --out out/sp-cn.apk \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner" \
  --dry-run

# 真出包 + 签名(口令只从环境变量读)
SP_KS_PASS='...' node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk --host 192.168.1.10 --port 8001 \
  --out out/sp-cn.apk \
  --ks ../../../keystore/sp-cn.keystore --ks-pass-env SP_KS_PASS \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner"
```

地址是**编译期常量**:脚本把 SWF 里 ABC 常量池的那对「scheme + host」等长改写
(`"https" + "shijtswygamegf.leiting.com"` → `"http" + "00000000@<host>:<port>"`,33 字节守恒),
官方 host 在 SWF 里必须恰好出现 1 次,否则直接拒绝执行。除了这 29 个字节,产线还会摘掉
基线自带的 v1 签名件(主 SWF 已改,旧签名必然失效)。每次出包在 `<out>.build-report.json`
留证(基座/产物 sha256、站点前后指纹、逐条断言)。**绝不能用字节 grep 判断补丁是否生效** ——
SWF 在 APK 里通常是 Deflate 压缩的,产线一律先解压再比对。

> ⚠ 产线目前**只做第二处改动**(地址重定向)。第一处 `sdkDummy` 是 AS3 逻辑改动,
> 产线默认不碰 AS3(见 [`CLIENT-BUILD.md`](./CLIENT-BUILD.md) §6):装了产线产物的机器
> 要跳过官方登录,得用基线里已经是 `sdkDummy = true` 的包,或先按上面「应用步骤(手动)」
> 打好这一处,或走 `--as3-hook`(需要 FFDec)。

## 与他人客户端同机共存:改包名

官方安装身份是 `com.leiting.wf`,与他人服务器的客户端同值但签名不同 ⇒ 不卸载对方的就装不上我们的。
用 `client-patch/tools/rename-package.mjs` 改成**等长**的自有包名即可共存,且 AIR 存档按应用 id
隔离(新包 = 全新存档):

```bash
# 只读侦察:打印官方包名与所有需要改的位置
node client-patch/tools/rename-package.mjs --in out/sp-cn.apk --inspect

# 出共存包(--package 必须与原名等长,除非显式 --allow-unequal-length)
node client-patch/tools/rename-package.mjs \
  --in out/sp-cn-lan.apk --out out/sp-cn-lan-coexist.apk --package com.starpoints
```

也可以让产线透传:`--rename-package --rename-to <pkg>`(缺该工具时产线明确报错,不会静默忽略)。
iOS 侧同一工具也能改 `CFBundleIdentifier`。回归测试:`tools/rename_package.test.cjs`(在
`quick:runtime` 组),产线自身的回归是 `tools/build_client.test.cjs`(同组)。

## 注册验证码版客户端(自研登录页)

**这一版与上面的最小补丁版的区别**:最小补丁版跳过官方登录后直接进游戏;注册验证码版在客户端里
带上**自研登录页**,玩家在页面上注册/登录,页面显示服务端下发的 **6 位注册验证码**,再把这个码
交给 QQ/KOOK 群里的 bot(`/bind <码>`)或后台完成绑定。绑定前游戏会被服务端的**绑定闸门**
(`result_code = 517`)挡在门外 —— 服务端返回什么、怎么排查见
[`docs/systems/client-binding.md`](../docs/systems/client-binding.md) 的「绑定闸门」一节。

### 构建口径

登录页是 AS3 层的整类改动,走产线的 AS3 回编译钩子(默认不执行):

```bash
node client-patch/build/build-client.mjs \
  --base apkipa/V1.8.1.apk --host 192.168.1.10 --port 8001 \
  --out out/sp-cn-signup.apk \
  --as3-hook path/to/login-page-hook.mjs --ffdec /path/to/ffdec.jar \
  --zipalign "$ANDROID_BUILD_TOOLS/zipalign" --apksigner "$ANDROID_BUILD_TOOLS/apksigner"
```

钩子模块导出 `transformSwf(ctx)`,自行用 FFDec 做整类替换,返回改后的 SWF:

```js
export async function transformSwf(ctx) {
  // ctx = { logicalSwf, swfPath, entry, host, port, hostPort,
  //         ffdecJar, javaExe, ffdecVersion, workDir, log }
  return { swf: patchedBuffer, notes: ["替换自研登录页类"] }
}
```

钩子里的硬约束(产线只替你做掉一部分):

- **整类替换**,不能用 `-importScript`;单类 `-replace` 会让 FFDec 重写整份 ABC。
- 必须回读并**校验类指纹**(改前/改后特征串),不能靠字节 grep 判断补丁生效。
- APK/SWF 必须落在**纯 ASCII 路径**(`--work` 可控),FFDec 必须 headless 运行。
- FFDec 版本必须与 README 要求的 **24.0.1** 一致,否则拒绝执行
  (`--allow-ffdec-version-mismatch` 只是把它降级成警告)。
- 地址**不要**在登录页 AS3 里再写一份常量:用 `devConfig.getServerApiPath()` 推导
  `/sp-auth/*` 的基址,地址只在产线 `--host/--port` 一处进来 —— 否则「换服务器 = 改一处」
  这条约束就破了。

### 当前状态(重要)

登录页 AS3 本体(**P6** 的交付物)**尚未合并进本仓库**:本目录下只有 `apply.sh`、
`build/**`、`tools/rename-package.mjs` 与文档,没有 `.as` 源码、也没有登录页钩子。
所以上面这条命令现在**跑不出**注册验证码版,本节给的是构建口径与钩子接口约定。
P6 交付后:把它的钩子路径填进 `--as3-hook`,按 `CLIENT-BUILD.md` §6 与本节约束出包,
产物对照验收 A1→A3(登录页能注册 → 服务端建号并下发 6 位码 → 用该码绑定后能进游戏)。

### 出包后的自检

1. `<out>.build-report.json` 里的站点前后指纹应是新 host,且逐条断言全 PASS;
   退出码 `2`(任何断言 FAIL)时产物**不要分发**。
2. `apksigner verify --verbose` 通过;没签名不算失败,但签名的包才能覆盖安装自己的旧包。
3. 与官方包同机安装时确认包名确实改过(见上一节),否则会盖掉官方包/被官方包盖掉。

## 说明

完整的自动化流水线的**产线部分**已在仓库里:`client-patch/build/build-client.mjs`(打包 / 签名 /
构建报告)、`client-patch/build/patch-ipa.mjs`(iOS 唯一补丁入口)、
`client-patch/tools/rename-package.mjs`(改包名)。本目录不随附客户端素材(APK/IPA)、keystore 与
Android build-tools,这些需自备。`apply.sh` 为原创实现,不含 starview 代码;早期那套基于
[starview](https://github.com/duosii/starview)(GPL-3.0)的本地扩展未随仓库分发,已被上面的产线取代。
