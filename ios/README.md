# iOS 客户端联调 SOP：出包 → 装机 → 首启取证

把**官方 iOS 包**原地指向本机私服（`http://<LAN_IP>:8001`），装到真机上跑一次首启，
用服务端探针把客户端实际发出的身份头（`UDID` / `SHORT_UDID`）原样抓下来。

配套工具：[`client-patch/build/patch-ios-ipa.mjs`](../client-patch/build/patch-ios-ipa.mjs)（出包）、
[`src/lib/udid-probe.ts`](../src/lib/udid-probe.ts)（探针）。
Android 侧的等价改动见 [`client-patch/README.md`](../client-patch/README.md)。

> **本文件不写任何真实 IP**：所有地址一律用占位符 `<LAN_IP>`。真实地址只出现在你本机的命令行里。

---

## 0. 前置

| 项 | 要求 |
| --- | --- |
| 官方 iOS 包 | 自备（`apkipa/iOS-1.8.4.ipa` 或你手上的同版本解密包），**不入库**（>1 MB 二进制只放 `out/`） |
| Node | ≥ 20（本工具零依赖，只用 node 内置 `zlib`） |
| 服务端 | 见第 2 步，与手机**同一局域网** |
| 手机 | 越狱机（路线 A）或普通机 + 电脑（路线 B） |

为什么要重签：补丁直接改了 `Payload/<App>.app/<App>` 的字节 ⇒ 原 `LC_CODE_SIGNATURE` 失效，
**装之前必须重签**。官方包 `cryptid=0`（已是解密 dump，见 `Info.plist` 的 `From DumpDecrypter`），所以重签可行。
`Info.plist` 里 `NSAppTransportSecurity.NSAllowsArbitraryLoads=true`，明文 `http://` 不会被 ATS 拦。

---

## 1. 出包

```bash
node client-patch/build/patch-ios-ipa.mjs \
  --ipa <官方包路径>.ipa \
  --host <LAN_IP> --port 8001 \
  --guard-mode launch \
  --out out/sp-cn-ios-lan.ipa
```

只算不断言（先看数字，不写盘）：加 `--dry-run`。

工具会打印并落盘 `out/sp-cn-ios-lan.ipa.build-report.json`，其中 **4 条断言必须全 PASS**：

| # | 断言 | 参考值 |
| --- | --- | --- |
| ① | 补丁前：官方包里的域名站点数 | `137` 个可改写（总 `150`，另 `13` 个太短跳过） |
| ② | 目标 authority 长度 | `18`（不等长直接报错退出——**绝不缩短/搬移字符串**） |
| ③ | 补丁后回读：旧站点 `0` 处、新端点 `138` 处 | `0` / `138`（URL 站点 `137` + ABC 常量池 `1`） |
| ④ | `--guard-mode launch` 的 NOP 命中数 | `1`（仅 `0xb00c`） |

另外报告里的 `premise` 段会复核任务书里那个「官方包含 `8.133.209.122:7001` 共 137 处」的前置事实——
**官方包实测为 `0` 处**，该字面量只存在于被第三方改过的包，禁止拿它当输入。

改动落点（两处，全部等长覆盖）：

1. **137 个域名站点**（`__TEXT,__cstring` 里的 `https?://…leiting.com|roguelike.com|cl2009.com`）→
   `http://<填充>@<LAN_IP>:8001`（不足处用 userinfo 补 `0`，长度严格守恒）；
2. **游戏 API 基址**（`ABC` 常量池里相邻的一对条目 `"https"` + `"shijtswygamegf.leiting.com"`）→
   `"http"` + `"00000000@<LAN_IP>:8001"`（成对长度守恒：`5+26` 字节 ↔ `4+27` 字节，
   条目数与后续所有条目偏移逐字节不变）。运行期拼出 `http://00000000@<LAN_IP>:8001/api/index.php`。

---

## 2. 起服务端（带探针）

```bash
# Linux/macOS
CN_LISTEN_HOST=0.0.0.0 CN_LISTEN_PORT=8001 ASSET_MODE=client-owned \
IOS_COMPAT_ENABLED=1 IOS_API_HOST=<LAN_IP>:8001 IOS_API_SCHEME=http \
SP_PROBE_UDID=1 SP_PROBE_LOG="$PWD/out/probe-ios.jsonl" \
node out/cn-server.js
```

```powershell
# Windows PowerShell
$env:CN_LISTEN_HOST='0.0.0.0'; $env:CN_LISTEN_PORT='8001'; $env:ASSET_MODE='client-owned'
$env:IOS_COMPAT_ENABLED='1'; $env:IOS_API_HOST='<LAN_IP>:8001'; $env:IOS_API_SCHEME='http'
$env:SP_PROBE_UDID='1'; $env:SP_PROBE_LOG="$PWD/out/probe-ios.jsonl"
node out/cn-server.js
```

要点（每一项都对应一个能让人白跑一趟的坑）：

- **`CN_LISTEN_HOST=0.0.0.0`**：默认只监听 `127.0.0.1`，手机连不上。
- **`ASSET_MODE=client-owned`**：默认 `local` 模式起服前会跑内容同步，本机没有 `.cdn/cn` 会直接
  `[CONTENT_SYNC_FAILED]` 起不来；取证只关心身份头，用 `client-owned` 跳过。
- **`IOS_COMPAT_ENABLED=1` + `IOS_API_HOST=<LAN_IP>:8001`**：客户端标题页会请求
  `/shijtswy/version/client_release_ios.dis` 并用返回值**改写**运行期 API 基址；不设这两项它会被指回官方域名。
- **`SP_PROBE_UDID=1`**：探针默认关，不开就一行日志都没有。
- 启动成功会打印一行 `[SP_PROBE_UDID] identity probe active (append -> …)`。
- Windows 首次放行防火墙（入站 TCP 8001），否则手机连不上。

---

## 3. 装到手机

### 路线 A：越狱机（推荐，最省事）

1. 把 `out/sp-cn-ios-lan.ipa` 拷进去（AirDrop / `scp` / Filza）并解包拿到 `Payload/<App>.app/`。
2. 重签主二进制 + 所有嵌套二进制（**一个都不能漏**）：
   ```bash
   cd Payload/<App>.app
   ldid -S <App>                      # 主二进制
   find . -name '*.dylib' -o -name '*.framework' | while read f; do ldid -S "$f"; done
   ```
   漏签嵌套 dylib / framework 的表现是启动瞬间闪退。
3. 装回 `/Applications/`（或用 Filza / `ipainstaller` / AppSync 直接装 IPA）。
4. 首次启动如提示「不受信任的开发者」，在 设置 → 通用 → VPN 与设备管理 里信任。

### 路线 B：非越狱机（Sideloadly + Apple ID，7 天续签）

1. 打开 Sideloadly，选 `out/sp-cn-ios-lan.ipa`，Apple ID 登录（普通账号即可），开始。
2. 电脑侧输入 Apple ID 密码 / 双重验证码，等它自动重签 + 安装。
3. 手机 设置 → 通用 → VPN 与设备管理 → 信任你的开发者证书。
4. **7 天后过期**：重跑一次 Sideloadly 即可（存档在 App 沙盒里，续签不丢）。
5. 装不上先看两条：
   - 报 `The app is in an invalid format.` ⇒ 打包丢了 Unix 可执行位（`jar uf0` 的经典坑；
     本工具用自带 ZIP 引擎逐条保留 `versionMadeBy` / `externalAttr` / method，不会再触发）；
   - 报签名相关错误 ⇒ 重签没覆盖到嵌套二进制。

> iPhone 与电脑/服务端必须同一网段；非越狱机上**装完就能取证**，不需要越狱。

---

## 4. 取证（人只需要动两下）

1. 手机启动游戏，**点一次「点击开始」**，然后在标题页停留 30 秒。
2. 看服务端日志文件：
   ```bash
   cat out/probe-ios.jsonl
   ```
   每行一个请求，形如：
   ```json
   {"ts":"…","method":"POST","url":"/api/index.php/tool/signup","ip":"<手机IP>","udid":"…","short_udid":null,"user_agent":"…","has_session":false,"body_keys":["channelNo","device_id"]}
   ```
3. 记下 `udid` 的**原始字符串**（报告里要原样抄）。

探针只观察不改行为：不读 `reply`、不碰 body、不加路由、不改错误码；
`body_keys` 只记键名，不落请求体内容。

**判读**（三种形态对应三个分支，判定必须由 agent 依据原始证据做）：

| 观测到的 `UDID` | 分支 | 含义 |
| --- | --- | --- |
| 缺失 / 空串，或请求带的是本地存档里的 `viewerId` | **α** | 身份来自 LocalStore，可预写存档 |
| 所有设备（≥2 台）完全相同的一串 | **β** | 共用固定身份（最高风险，服务端必须改成按设备返回身份） |
| 每台设备不同、且同一台重复启动保持稳定 | **γ** | 每设备唯一且稳定 |

**重复观测**：同一台机器卸载重装再跑一次，得到第二份样本；要判 β 至少需要**两台不同设备**（或两台设备的样本）各一次。

---

## 5. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 手机上游戏卡在「获取版本信息失败，重试中」 | 服务端没起 / 不是 `0.0.0.0` / 防火墙 / 手机不在同一网段 |
| 探针文件是空的 | `SP_PROBE_UDID=1` 没设；或请求全被别的前置逻辑挡在 TCP 之前 |
| 请求落进日志但业务报错 | 正常：探针只记录，不影响路由；先确认签名与重签是否正确 |
| 启动黑屏 | 补丁改坏了容器长度前缀（本工具禁止缩短/搬移，出现即工具 bug，附 `build-report.json` 报障） |
| 装完闪退 | 嵌套 dylib / framework 没重签（路线 A 第 2 步） |
| 想抓明文流量对账 | Wi-Fi 代理 + mitmproxy（仓库根 `start-capture-traffic.bat`），或按需在越狱机取存档：`<appStorage>/<saveDataKey>/account`（DEFLATE + JSON，含 `udid` / `viewerId` / `shortUdid`） |

---

## 6. 产物去向

- 产出包、探针日志、构建报告一律落在 `out/`（已被 `.gitignore` 忽略）。
- 报告正文（含原始证据）写在仓库外：`D:\wfcnmod\报告-B0-iOS身份分支.md`。
