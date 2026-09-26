# iOS 客户端接入（雷廷 SDK 链路）

本文描述 iOS 客户端连上本服需要的那一层服务端适配：SDK 裸路由、按设备派生的身份、
公告通道（绑定验证码的展示位），以及**当前还不成立的那一段**。

代码入口：`src/routes/cn/ios-leiting.ts`（全部路由与身份派生）、
`src/cn-server.ts:34,351-353`（注册处）、`src/runtime/config.ts` 的 `iosCompat`（开关与地址）。

协议风格参考：[路由族覆盖矩阵](../reference/routes-status.md)、
[账号绑定与验证码](./client-binding.md)。

## 启用条件

iOS 适配**默认关闭**。开启后本插件才注册，且是**无前缀**注册：

```
src/cn-server.ts:351   if (config.iosCompat.enabled) {
src/cn-server.ts:352   // iOS SDK请求的是裸路径（/sdk/v3-3/...、/mobile!...），必须无前缀注册。
src/cn-server.ts:353       fastify.register(iosLeitingPlugin, { ios: config.iosCompat });
```

关闭时 iOS 请求走 Android 相同响应，行为零变化。开关与地址：

| 环境变量 | 含义 | 默认 |
| --- | --- | --- |
| `IOS_COMPAT_ENABLED` | 启用 iOS 适配（SDK 登录 mock、`.dis` 平台拆分、`archive-ios-*` 资源隔离） | 关闭 |
| `IOS_API_HOST` | 启用时**必须**显式配置的客户端可达地址 | 无 |
| `IOS_API_SCHEME` | 无 TLS 时必须 `http` | `http` |

（说明与长度预算见 `.env.example` 的「iOS 实验性兼容」一节；
`/wf/210009_config_20200415.json` 会把这两个值回给客户端引导配置，
`src/routes/cn/ios-leiting.ts:759-766`。）

## 路由清单

### ① SDK 登录（16 条，一视同仁）

`src/routes/cn/ios-leiting.ts:39` 定义 16 条路径，注册在 `:774-794`：

```
/mobile!mobileLoginPubV2.action        /login/mobile!mobileLoginPubV2.action
/mobile!sdkLogin.action                /login/mobile!sdkLogin.action
/mobile!guestRegister.action           /login/mobile!guestRegister.action
/mobile!sdkCheckLogin.action           /login/mobile!sdkCheckLogin.action
/sdk/v3-3/code_login_v2.do             /sdk/v3-3/code_login.do
/sdk/v3-3/pwd_login.do                 /sdk/v3-3/check_login.do
/sdk/v3-3/check_force.do               /sdk/v3-3/taptap_login.do
/sdk/auth_login.do                     /sdk/v3-3/auth_login.do
```

16 条**全部**返回按设备派生的身份（`src/routes/cn/ios-leiting.ts:36`），
成功形状 `{status:"0", type:"0", message:"", data:<AES bean>}`
（`src/routes/cn/ios-leiting.ts:37`、`:792`）；失败形状把 `status` 改成 `"1"` 并带
失败原因（`src/routes/cn/ios-leiting.ts:678-680`）。

### ② SDK 短信/注册码兜底（6 条）

`src/routes/cn/ios-leiting.ts:40`，注册在 `:795-797`，一律回
`{status:"0", statusCode:"0", memo:"", message:"", data:""}`（`:38`）：

```
/mobile_two!getRegisterCodeOnly.action        /login/mobile_two!getRegisterCodeOnly.action
/aes/message/send_phone_code                  /aes/message/send_login_verify_code
/aes/message/send_bind_phone_login_code       /aes/message/send_register_code
```

### ③ 公告：`/sdk_v3/get_notice.do`（三前缀）

SDK 用 `%@sdk_v3/get_notice.do` 在运行时拼基址，静态无法确定基址形态 ⇒ 三种一起接
（`src/routes/cn/ios-leiting.ts:405-410`，注册 `:801-804`）：

```
/sdk_v3/get_notice.do
/login/sdk_v3/get_notice.do
/api/sdk_v3/get_notice.do
```

这是**玩家能看到绑定验证码的地方**（后端依据见 `:383-388`：LeitingSDK 静态链进主二进制，
公告流程全在 SDK 内部，展示由 SDK 原生弹窗完成，客户端零改动、不需要越狱）。

响应约定：

- **永远 HTTP 200 + JSON**，`provideCode` 抛错只降级成兜底文案，绝不让请求失败
  （`src/routes/cn/ios-leiting.ts:570`、`:583`）
- **默认霰弹字段**：把主二进制字符串表里出现过的字段名一次全给上
  （`noticeContent` / `NOTICECONTENT` / `urgentNoticeContent` / `announce…`），
  因为 SDK 到底读哪个静态确定不了（`:394-396`、`:528-565`）
- 文案区分有无码（`src/routes/cn/ios-leiting.ts:521-526`）：
  - 有码：`服务器绑定验证码：<code> … 把它发给 QQ 群里的 bot（/bind <code>）即完成绑定`
  - 无码：`请先在 QQ 群里向 bot 发送 /bind 获取绑定流程，或联系服主人工绑定。`

> ✅ **接缝已闭合**：注册处 `src/cn-server.ts:354-364` 已注入码提供者
> `createIosNoticeCodeProvider()`（实现见 `src/lib/ios-notice-code.ts`），
> 插件启动日志相应变成 `provideCode=injected`（`src/routes/cn/ios-leiting.ts:805`）。
>
> 提供者的语义（改之前先读 `src/lib/ios-notice-code.ts` 顶部注释）：
>
> 1. **账号解析与绑定闸门同源**：直接复用 `resolveBindGateSubject`
>    （`src/lib/bind-gate.ts:195`），即「先 `device_bindings` 再未过期的 `device_grants`」。
>    刻意不另写一套只查 `device_grants` 的窄解析 —— 否则会出现「闸门认得出这个设备、
>    公告却查不到人」的不一致（P2 之前的存量玩家只有 `device_bindings`）。
> 2. **反复打开公告不换码**：顺序永远是「先取活码
>    （`activeCodeViewForAccount`，`src/lib/signup-code.ts:81`），取不到才发新码」。
>    若每次请求都 `issueSignupCode`，玩家刚看到的码会立刻失效（CC-1 的 60 秒窗口
>    不足以救这个场景）。
> 3. **查不到人不抛错**：`provideCode` 返回 `null` ⇒ 回兜底文案；
>    内部异常也收成 `null` + 日志，绝不让玩家看到 5xx。
> 4. **已绑定 / 已封禁不发码**：`outcome` 为 `already_bound` 时回兜底文案
>    （已绑定玩家不需要新码），`account_disabled` 同理。
>
> **未做真机验证**：上述是服务端行为，真机是否真的弹出公告并渲染出 6 位码，
> 仍取决于 SDK 读取哪个字段（见下方「公告字段是猜的」）。

### ④ 其余裸路由

| 路径 | 方法 | 行为 | 代码 |
| --- | --- | --- | --- |
| `/area/config.json` | GET | 区域配置 | `:715` |
| `/protocols/leiting/switch/switch.txt` | GET | 开关文件 | `:723` |
| `/myip` | GET | 回显 IP | `:730` |
| `/logmonitor/api/advert!getNewConfig.action` | POST | 广告配置 | `:735` |
| `/api/skan/query_detail` | GET | `{code:0,data:{}}` | `:740` |
| SDK 埋点 | POST | `{code:0,data:{}}`，兼容带/不带 `.action` | `:744-749` |
| SDK 日志 | GET/POST | `{code:0,message:"success"}` | `:751-756` |
| `/wf/210009_config_20200415.json` | GET | 回 `apiPath`/`apiScheme` 引导配置 | `:759-766` |
| `/sync_data` | POST | 静默吞掉，`{code:0}` | `:768-771` |

路径表定义在 `src/routes/cn/ios-leiting.ts:42`（`SDK_LOG_PATHS`）与 `:49`（`MG_LOG_PATHS`）。

## 身份派生：一设备一 SDK 身份

**不使用随机数**，同一设备永远得到同一个身份（`src/routes/cn/ios-leiting.ts:190`）：

```
userId = 90_000_000 + (HMAC-SHA256(IOS_SDK_IDENTITY_SECRET, deviceKey).readUInt32BE(0) % 10_000_000)
```

- 常量：`DERIVED_USER_ID_PATTERN = /^9\d{7}$/`、`DERIVED_USER_ID_BASE = 90_000_000`、
  `DERIVED_USER_ID_SPAN = 10_000_000`（`src/routes/cn/ios-leiting.ts:63-65`）
- 实现：`deriveIosSdkUserId`（`:192-196`）；设备号已经是 `9xxxxxxx` 形状则**幂等原样返回**
  （`:193`）
- 整份身份由最终 `userId` 再派生一次摘要展开，所以幂等（`:198-213`）：
  `userName = g_<userId>`、`token = sp-<hex[0:20]>`、`mmid`/`ddid`/`registTime`/`timestamp`
  的**字段长度与修复前逐字段相同**（token 23 / mmid 14 / ddid 14 / 时间戳 13，`:208`）
- 设备标识来源有优先级，命中兜底时会打一行 `src=fallback` 便于真机取证
  （`:133`、`:347`、`:377-378`）
- 拿不到设备号 ⇒ **拒发身份**（`reply.send(loginFailure("ios-sdk-login-device-unknown"))`，
  `:785-788`）；身份密钥没配 ⇒ 同样拒发，且只在第一次打印原因
  （`:776-783`、`:687-693`）

### 加密与密钥（fail-closed）

登录响应里的 `data` 是 AES-128-CBC 密文（`src/routes/cn/ios-leiting.ts:257-258`）。

| 环境变量 | 要求 | 缺失后果 |
| --- | --- | --- |
| `IOS_SDK_BEAN_KEY` | 恰好 16 字节 | 拒发 SDK 登录响应 |
| `IOS_SDK_BEAN_IV` | 恰好 16 字节 | 拒发 SDK 登录响应 |
| `IOS_SDK_IDENTITY_SECRET` | 非空 | 拒发 SDK 登录响应 |

- 三者**任一缺失即拒发**：`resolveIosSdkIdentityConfig` 收集 `missing` 后返回 `ok:false`
  （`src/routes/cn/ios-leiting.ts:160-171`）
- 长度不对也拒发：`must be exactly 16 bytes`（`:168`、`:171`）
- 密钥**不再入库常量**，一律来自环境变量（`:31-32`）
- 读取方式是注入式 env（`options.env ?? process.env`，`:687`），符合契约 C9 / CC-4

## 公告探针（默认关）

用途：真机跑一次，确定 SDK 的**真实请求行**——带不带 `/login` 前缀、基址带不带尾斜杠、
请求体字段名是什么（`src/routes/cn/ios-leiting.ts:390-396`）。

- 开关：`IOS_NOTICE_PROBE=1` 打开；默认关 ⇒ 测试与日常运行**不产生任何文件**
  （`src/routes/cn/ios-leiting.ts:391`、`:402`、`:700`）
- 日志目录：`IOS_NOTICE_PROBE_LOG_DIR`，再缺省 `<cwd>/out/ios-probe`（`:403`、`:699-702`）
- **只记不改**，且**不落原始 cookie**（避免把会话凭据写进日志），
  请求/响应体各截断 4096 字节（`:393`、`:416`、`:615`、`:665`）
- 只记 URL 命中 `/notice|config|sdk|login|auth|leiting|version/i` 的请求，避免被资源请求刷爆
  （`:415`、`:653`）
- **作用范围有限**：本插件是 Fastify 封闭上下文，探针只覆盖本文件注册的路由
  （`:398-401`）；要全覆盖得在 `src/cn-server.ts` 里装等价钩子

## iOS 玩家怎么完成绑定：R3 人工兜底

iOS 客户端**没有界面显示/输入验证码**（iOS/安卓 SWF 的 ABC 已被 AOT 剥离，
`showNoticeTip`/`NoticeBean` 零命中，依据见 `src/routes/cn/ios-leiting.ts:386-388`）。
所以闸门打开后 iOS 玩家的路径是 **R3 人工绑定**：

1. iOS 玩家把 UID / 设备号发到群里
2. bot 调服务端查证
3. 后台用绑定控制面**人工建绑定**

第 3 步使用的接口与状态机见[自研账号与账号绑定](./client-binding.md)（`/api/bindings/*`）。
公告通道已注入 `provideCode`（见上节），服务端会把该设备的 6 位绑定码写进公告文案，
玩家可在游戏原生弹窗里直接看到，再发给群里 bot 的 `/bind <code>` 完成自助绑定。
R3 人工绑定仍是兜底路径（查不到设备、账号已绑定、或真机上公告文案没被 SDK 渲染出来时）。

## 边界与未验证项

- **未做真机验证**：本文描述的是服务端代码行为；真机（iOS 15.8.3 / iPhone 7 Plus）是否
  按预期登录、公告字段是否被 SDK 读取，以[测试进度](../status/test-progress.md)与
  P10-A / P10-B 的报告为准。
- **公告字段是猜的**：`shotgun:true` 的多别名霰弹就是为这个不确定性准备的
  （`src/routes/cn/ios-leiting.ts:528-530`）；探针确认后再收窄成 `false`。
- **公告触发时机未知**：`get_notice.do` 可能只在登录后或特定场景被请求。
- **IPA 补丁的长度预算**：Mach-O 中的 API authority 只有约 26 bytes
  （`.env.example`「iOS 实验性兼容」一节），过长域名写不进去。
- **绑定闸门（517）已实现**：iOS 设备同样会被 `src/routes/cn/tool.ts:89-101` 拦下，
  并被识别成 `client="ios"` 而多打一行「走 R3 人工绑定」的中文提示
  （`src/lib/bind-gate.ts:57-58`、`:140-163`、`:465`）。分流只影响日志与提示，不影响判定。
  细节见[自研账号与账号绑定](./client-binding.md)的闸门一节。
- **iOS 的「自助」验证码入口已接通服务端**：闸门拦下后玩家打开公告即可看到 6 位码，
  路径 = 游戏原生公告弹窗 → 群里 bot 的 `/bind <code>`。
  提供者的实现与语义见上节（`src/lib/ios-notice-code.ts`），单测见
  `tools/ios_notice_code.test.cjs`。**真机是否真的显示该码仍未经确认**
  （公告触发时机与字段名都是推断，见上一节）；真机确认前，R3 人工绑定与
  群里 bot 的 `/bind` 仍是可靠出路。
