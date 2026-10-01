# 自研账号与账号绑定

本文描述自研登录页（`/sp-auth/*`）、管理后台绑定控制面（`/api/bindings/*`）、
机器人控制面（`/api/bot/*`）以及「一设备一账号 + 平台绑定」这套模型。

代码入口：

- `src/routes/sp-auth/index.ts`（HTTP 面）、`src/lib/sp-auth/**`（协议与操作）
- `src/routes/web_api/binding.ts`（后台控制面）、`src/routes/web_api/bot.ts`（bot 控制面）
- `src/data/domains/account-binding.ts`（全部持久化与状态迁移）、`src/data/schema/account-binding.ts`（DDL）
- `src/lib/signup-code.ts`（验证码策略：TTL / 限流 / 审计）

协议常量集中在 `src/lib/sp-auth/contract.ts`，**该文件的错误码与字段名是冻结契约**
（`src/lib/sp-auth/contract.ts:5-7`），新增只能追加、不得改名。

## 三个标识的分工

| 标识 | 载体 | 生命周期 | 代码 |
| --- | --- | --- | --- |
| 设备标识 `device_id` | 游戏客户端的设备号 | 永久 | `device_grants.device_id`（主键） |
| 设备授权令牌 `token` | `/sp-auth/*` 请求体 | 15 天**不活跃**（活跃即滑动顺延） | `src/data/domains/account-binding.ts:45`、`:1028-1047`、`src/lib/sp-auth/token-ops.ts:55-77` |
| 绑定验证码 `code` | 游戏内公告 → bot | 默认 30 分钟 | `src/data/domains/account-binding.ts:31-34` |

`device_grants` 以 `device_id` 为主键并 `ON CONFLICT(device_id) DO UPDATE`
（`src/data/domains/account-binding.ts:987-998`），这是「**一设备一账号**」的落地点：
同一台设备再注册只会刷新授权行，不会产生第二个账号；登录名冲突时返回 `DEVICE_TAKEN`
（错误码与话术见 `src/lib/sp-auth/contract.ts:20,43`）。

### 授权的滑动有效期（契约 3.2，业主 2026-10-01 修订）

窗口语义是「**最后一次活跃 + 15 天**」，不是固定的 15 天签到：

- 常量 `DEVICE_GRANT_TTL_DAYS = 15`（`src/data/domains/account-binding.ts:45`）。
  契约 3.2 原为固定 30 天，业主 2026-10-01 修订为 15 天 + 活跃滑动续期。
- 每次带 token 调 `/sp-auth/bind-status`、`/sp-auth/resend`、`/sp-auth/profile`
  都算一次活跃：三条路径共用 `resolveToken()`
  （`src/lib/sp-auth/token-ops.ts:55-77`），它在 `isGrantActive` 通过后调用
  `refreshDeviceGrantExpirySync(deviceId)`
  （`src/data/domains/account-binding.ts:1028-1047`），把 `expires_at`
  重写成「现在 + 15 天」，因此持续上线的玩家永远不必重新登录。
- **续期不得轮换 token**：`refreshDeviceGrantExpirySync` 只 `UPDATE expires_at /
  updated_at`，刻意不复用 `upsertDeviceGrantSync` —— 后者在不传 token 时会
  `randomBytes(32)` 新造一个，会把客户端手里的凭据作废。无授权行时返回 `null`
  （调用方据此判失效），`ttlDays` 必须为正整数。
- 失效分支是**纯读**：`resolveGrantByToken` 返回 `null` 或 `isGrantActive` 为假时
  直接返回，绝不续期；连续 15 天不活跃 ⇒ `TOKEN_INVALID`，玩家必须重新登录。
- 登录（`src/lib/sp-auth/login.ts:128`）与注册走 `issueGrantForDevice`，它们**故意**
  签发新 token，那是「重新登录」而不是续期。
- 游戏侧准入读的是同一个 `expires_at`（`src/lib/bind-gate.ts:219-222`），所以滑动续期
  会同步延长准入 —— 活跃玩家不会在第 15 天被 517 拦下。

## 账号绑定状态机

账号级状态只有三个取值（`src/data/types.ts:937`）：

```
pending ──(绑定平台成功)──▶ active
   ▲                          │
   └──(解绑全部平台/解绑主绑定)─┘
                              │
                    (管理员停用) ▼
                          disabled
```

读写入口是 `getAccountBindStateSync` / `setAccountBindStateSync`
（`src/data/domains/account-binding.ts:1043`、`:1051`），落库前一律过
`normalizeBindState`（`src/data/domains/account-binding.ts:81`）过滤非法值。

平台侧则是 **绑定的集合**，不是单值：`account_bindings` 允许一个账号挂多个平台身份，
最多一个 `is_primary = 1`。两条唯一索引把这个约束交给数据库而不是应用层：

- `uq_account_bindings_primary`：`(platform, platform_uid) WHERE is_primary = 1`
  —— 一个平台身份在全局只能是一个账号的主绑定（`src/data/schema/account-binding.ts:47-48`）
- `uq_account_bindings_triple`：`(platform, platform_uid, account_id)`
  —— 同一账号不会重复挂同一个平台身份（`src/data/schema/account-binding.ts:51-52`）

平台取值为 `"qq" | "kook"`（`src/data/types.ts:931`，运行时白名单
`src/data/domains/account-binding.ts:39`、断言 `:48`）。

### 绑定状态与登录响应

`pending` 账号用账号密码登录时不会被放行，而是拿到 `BIND_REQUIRED`：

- `src/lib/sp-auth/login.ts:97` —— 没有活码时 `return fail("BIND_REQUIRED")`
- `src/lib/sp-auth/login.ts:106` —— 有活码时 `return fail("BIND_REQUIRED", view)`，
  `view` 即 `{code, code_expires_at}`，让登录页直接把码显示出来
- 话术见 `src/lib/sp-auth/contract.ts:46`「该账号尚未完成 QQ/KOOK 绑定。」

`login.ts:86` 的注释说明了这条分支的边界：账号处于其它失败态时**不得**退化成
`BIND_REQUIRED`，以免把账号重新拖回待绑定流程。

## 验证码：TTL、限流、审计

策略在 `src/lib/signup-code.ts`，值的生命周期在 P2 数据层。

| 项 | 值 | 代码 |
| --- | --- | --- |
| 码字母表 | `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`（去掉易混 `0/O/1/I`） | `src/data/domains/account-binding.ts:31` |
| 码长度 | 6 | `src/data/domains/account-binding.ts:32` |
| 默认 TTL | 30 分钟 | `src/data/domains/account-binding.ts:34` |
| TTL 环境变量 | `SIGNUP_CODE_TTL_MINUTES` | `src/lib/signup-code.ts:8`、`:41` |
| TTL 兜底 | 缺失/非法 ⇒ 30；上限 7 天 | `src/lib/signup-code.ts:24,27,42-45` |
| 同设备重发窗口 | 60 秒 | `src/lib/signup-code.ts:30`、`:90-96` |
| 连续失败上限 | 5 次 | `src/data/domains/account-binding.ts:36` |
| 设备授权 TTL | 15 天不活跃（活跃滑动续期） | `src/data/domains/account-binding.ts:45` |

- **一个账号同时只有一个活码**：发新码时吊销上一枚（`src/lib/signup-code.ts:62-78`）。
- **绑定成功即作废该账号仍 pending 的码（CC-6）**：账号一旦有了绑定，绑定之前发出的码
  就失去意义 —— 留在 `pending` 只会在别处被消费掉，并在同一账号上再挂一条非 primary
  绑定（`consumeSignupCodeSync` 只拦「该 uid 已是别账号的 primary」，**不**拦「该账号已有
  绑定」，`src/data/domains/account-binding.ts:520-526`）。作废落在共享写路径的成功分支
  `src/data/domains/account-binding.ts:703`（复用 `revokeSignupCodesForAccountSync`，
  `src/data/domains/account-binding.ts:371`），所以管理 API 与 bot 消费两条路径都覆盖；
  `ACCOUNT_NOT_FOUND` / `ALREADY_BOUND` 两个失败出口在 `:703` 之前就 `return`，
  因此**绑定失败一律不作废**。消费路径里正在被消费的那一枚码最终仍是 `bound`（同一事务内
  `consumeSignupCodeSync` 随后无条件置位，`src/data/domains/account-binding.ts:540-545`），
  只是会在 `bind_audit` 里多留一条 `revoke_code`。
- **重发限流**：`resend` 走 `isWithinCodeIssueWindow`，窗口内返回 `RATE_LIMITED`
  （`src/lib/signup-code.ts:85-96`；话术 `src/lib/sp-auth/contract.ts:44`）。
- **审计**：每次发码写一条 `bind_audit`，actor 固定 `"sp-auth"`
  （`src/lib/signup-code.ts:33`、`:75`；写入入口 `src/data/domains/account-binding.ts:188`）。
- **环境变量读取方式**：走 `src/lib/udid-probe.ts:117-126` 的注入式 env 模式，
  **不经过 `src/runtime/config.ts`**（`src/lib/signup-code.ts:36-38`，契约 C9 / CC-4）。

消费一个码是**单事务**的：校验 + 建绑定 + 置码为已用一起提交
（`src/data/domains/account-binding.ts:459-466`）。失败码是给 `POST /api/bot/bind` 冻结的那一套
（`src/data/domains/account-binding.ts:439-445`）：

```
CODE_INVALID  CODE_EXPIRED  CODE_USED  CODE_LOCKED  ALREADY_BOUND  ACCOUNT_DISABLED
```

## HTTP 面一：`/sp-auth/*`（自研登录页）

注册处：`src/cn-server.ts:42` 引入、`src/cn-server.ts:170`
`fastify.register(spAuthPlugin, { prefix: "/sp-auth" })`。

六条路由全部 `POST` + `application/json`（`src/routes/sp-auth/index.ts:68,73,78,83,88,93`）：

| 路径 | 用途 | 成功 `data` |
| --- | --- | --- |
| `POST /sp-auth/register` | 注册并建号 | `{token, viewer_id, username, code, code_expires_at}` |
| `POST /sp-auth/login` | 账号密码登录 | `{token, viewer_id, username, bound:true}` |
| `POST /sp-auth/bind-status` | 查绑定状态 / 当前活码 | `{bound, code, code_expires_at, viewer_id?}` |
| `POST /sp-auth/resend` | 重新发码 | `{code, code_expires_at}` |
| `POST /sp-auth/profile` | 「我是谁」+ 绑定态 | `{viewer_id, username, bound, bind_state, platform, …}` |
| `POST /sp-auth/logout` | 注销设备授权 | `{}` |

字段与 `data` 形状的权威定义在 `src/lib/sp-auth/contract.ts:85-135`。

### 响应约定（整个命名空间一致）

**HTTP 状态码一律 200**，失败也 200；成功 `{ok:true,data}`，失败
`{ok:false,code,message,data?}`（`src/routes/sp-auth/index.ts:4-8`，实现见 `:29-41`）：

- 成功：`reply.status(200).send({ ok: true, data })`（`src/routes/sp-auth/index.ts:32`）
- 失败（无附加数据）：`{ok:false, code, message}`（`src/routes/sp-auth/index.ts:39`）
- 失败（带附加数据，如 `DEVICE_TAKEN` 携带占用者）：`{ok:false, code, message, data}`
  （`src/routes/sp-auth/index.ts:40`）
- `message` 是 C7 中文兜底话术，由 `messageFor(code)` 生成
  （`src/routes/sp-auth/index.ts:36`；字典 `src/lib/sp-auth/contract.ts:39-54`）
- **未捕获异常也不破坏 200**：`guard()` 把抛出转成 `SERVICE_UNAVAILABLE`，
  且只把错误消息写服务端日志、绝不回传请求体或堆栈
  （`src/routes/sp-auth/index.ts:48-60`）

错误码全集 14 个见 `src/lib/sp-auth/contract.ts:15-30`。

### 字段规则

| 字段 | 规则 | 代码 |
| --- | --- | --- |
| `username` | `/^[A-Za-z_][A-Za-z0-9_]{3,19}$/`（4-20 位，不能以数字开头） | `src/lib/sp-auth/contract.ts:169` |
| `password` | 8-64 位 ASCII 字母数字，且同时含大写、小写、数字 | `src/lib/sp-auth/contract.ts:182-190` |
| `device_id` | 正的安全整数 | `src/lib/sp-auth/contract.ts:193-196` |
| `token` | 64 位小写 hex | `src/lib/sp-auth/contract.ts:199-201` |
| 平台 uid 回显 | `12345678` → `1234****5678`；长度 ≤ 4 → `****` | `src/lib/sp-auth/contract.ts:211-216` |

## HTTP 面二：`/api/bindings/*`（管理后台控制面）

注册处：`src/routes/web_api/index.ts:52` `fastify.register(bindingApiPlugin, { prefix: "/bindings" })`
⇒ 对外的完整前缀是 `/api/bindings`。

| 方法 + 路径 | 用途 | 路由行 | 成功状态 |
| --- | --- | --- | --- |
| `GET /api/bindings` | 分页查绑定，过滤 `platform` / `state` / `query` / `page` / `pageSize` | `src/routes/web_api/binding.ts:312` | 200 `{page,pageSize,totalCount,rows}` |
| `GET /api/bindings/codes` | 查验证码（可带 `accountId`） | `src/routes/web_api/binding.ts:356` | 200 `{rows,totalCount}` |
| `POST /api/bindings/codes` | 补发/新建验证码 | `src/routes/web_api/binding.ts:382` | 201 码行 |
| `POST /api/bindings/codes/:id/revoke` | 吊销验证码 | `src/routes/web_api/binding.ts:404` | 200 `{ok:true}` |
| `POST /api/bindings` | 手工新增绑定（`is_primary` 服务端默认 false） | `src/routes/web_api/binding.ts:418` | 201 绑定行 |
| `POST /api/bindings/:id/primary` | 设为主绑定 | `src/routes/web_api/binding.ts:459` | 200 绑定行 |
| `DELETE /api/bindings/:id` | 解绑（管理员可解主绑定） | `src/routes/web_api/binding.ts:480` | 200 `{ok:true}` |

分页响应的字段拼装见 `src/routes/web_api/binding.ts:344-350`。手工新增走
`is_primary = false` 分支（`src/routes/web_api/binding.ts:427`），主绑定迁移只走
`/:id/primary`——两者是两条不同路径，不要混用。

错误姿态：

| 状态 | 条件 | 代码 |
| --- | --- | --- |
| 503 | 数据库未就绪，**每个路由都先检查** | `src/routes/web_api/binding.ts:313,357,383,405,419,460,481` |
| 404 | 账号不存在 | `:394`、`:443` |
| 404 | 验证码不存在或已不可吊销 | `:410` |
| 404 | 绑定不存在 | `:467`、`:492` |
| 409 | 该平台身份已是**其他账号**的主绑定 | `:447`、`:450` |
| 409 | 该平台身份已存在主绑定 | `:469` |
| 400 / 500 | 入参非法 / 绑定操作失败 | `:222`、`:225` |

**鉴权姿态：这组接口没有任何后台鉴权**，与 `/api` 的其它路由一样只依赖可信网络边界
（`src/routes/web_api/binding.ts:31-32` 明确写了这一点，部署边界见
[管理后台](../admin/README.md)）。它**不接受** `X-Bot-Token`——bot 令牌属于下一节的
控制面，两套凭据不混用（`tests/admin-bindings-ui-source.test.js:52-54` 把这条写成了断言）。

## HTTP 面三：`/api/bot/*`（机器人控制面）

注册处：`src/routes/web_api/index.ts:53`
`fastify.register(botApiPlugin, { prefix: "/bot", env: options.botApiEnv })`
⇒ 对外完整前缀 `/api/bot`。三条路由**全部是 POST**
（`src/routes/web_api/bot.ts:240,288,312`）。

| 方法 + 路径 | 用途 |
| --- | --- |
| `POST /api/bot/bind` | 用验证码把 QQ/KOOK 身份绑到账号上 |
| `POST /api/bot/status` | 查某个平台身份已绑定的账号 |
| `POST /api/bot/unbind` | 自助解绑（只能解非主绑定） |

### 鉴权：fail-closed

- 令牌来自服务端环境变量 `BOT_API_TOKEN`
  （`src/routes/web_api/bot.ts:48-56`，缺失或全空白 ⇒ `null`）
- 比较是**常数时间**的：两侧先 `sha256` 再 `crypto.timingSafeEqual`，
  这样长度不可观测（`src/routes/web_api/bot.ts:63-68`）
- **env 缺失时整组 403**：`onRequest` 钩子里令牌为 `null` 直接
  `reply.status(403).send({ok:false, code:"FORBIDDEN"})`，且不区分「没带」和「带错」
  （`src/routes/web_api/bot.ts:234,236`；响应体常量 `:36`）
- 这是一处刻意的 fail-closed：**没配令牌 = 整个 bot 面不可用**，而不是「无令牌放行」。
  因此 `.env.example` 里 `BOT_API_TOKEN` 默认为空串，等于默认关闭该面。

### 状态码与失败码

| 场景 | HTTP | body | 代码 |
| --- | --- | --- | --- |
| 令牌缺失 / 不匹配 | 403 | `{ok:false,code:"FORBIDDEN"}` | `src/routes/web_api/bot.ts:234,236` |
| `unbind` 缺 `code` | 400 | `{ok:false,code:"BAD_REQUEST"}` | `:319` |
| 入参缺字段（如 platform） | 400 | `{ok:false,code:"BAD_REQUEST"}` | `:222` |
| `bind` 缺 code / 码格式非法 | 400 | `{ok:false,code:"CODE_INVALID"}` | `:248` |
| `status` 无绑定 | **200** | `{ok:true,data:{bindings:[]}}` | `:306` |
| 触发限流 | 200 | `{ok:false,code:"RATE_LIMITED"}` | `:253`、`:324` |
| 业务失败（码过期/已用/锁定/已绑定） | 200 | `{ok:false,code:<C4 码>}` | `:271`、`:328` |
| 解绑目标不存在 / 是主绑定 | 200 | `{ok:false,code:"BINDING_NOT_FOUND"｜"PRIMARY_BINDING"}` | `:336`、`:337` |

要点：**鉴权失败和参数缺失用 HTTP 状态码；业务判定失败用 200 + `code`**。
`CODE_INVALID` 一个码同时出现在 400（格式非法）和 200（查无此码，`:197`、`:203`、
`:208` 经 `:271` 返回）两条路径上——调用方必须同时看 HTTP 状态和 body 的 `code`。

`unbind` 的权限边界写在注释里：bot 自助**只能解非主绑定**，主绑定解绑需要管理员
（`src/data/domains/account-binding.ts:695`；后台侧对应 `src/routes/web_api/binding.ts:485-486`）。

bot 侧的对接契约（含 `SP_BOT_TOKEN` / `BOT_API_TOKEN` 别名关系）在 bot 仓库的
`startpoint-cn-bot/CONTRACT.md`，tag `baseline-bot-v0`。

## 绑定闸门（HTTP 517）

owner：P4。实现 `src/lib/bind-gate.ts`（524 行），拦截面 `src/routes/cn/tool.ts`。

### 拦在哪一步

`POST /tool/signup` 是客户端拿 `login_token` 的唯一入口，闸门就卡在这里：
`src/routes/cn/tool.ts:87` 先 `getDeviceBindingSync(deviceId)`，
`:89-101` 在**已知设备短路之前**做判定（`:89-90` 的注释原文：
「必须卡在已知设备分支之前，否则老设备会绕过闸门」），拒绝时
`reply.header("content-type", "application/x-msgpack")` + `reply.status(200).send(buildBindGateRejection(...))`
⇒ 不走到 `insertDeviceBindingSync`，也不下发 `login_token`。

### 开闸响应（契约 C3 冻结形状）

HTTP 状态**恒为 200**，响应体走游戏服务路由族一贯的 msgpack
（`content-type: application/x-msgpack`，`src/routes/cn/tool.ts:99`；序列化见 `src/server.ts:64`）。
形状如下（下面用 JSON 写法表示同一份 map）：

```jsonc
{
  "data_headers": {
    "force_update": false, "asset_update": false, "short_udid": 0,
    "viewer_id": 0,                      // 拒绝路径绝不回可登录凭据
    "servertime": "…",
    "result_code": 517,
    "sp_binding": { "ok": false, "code": "BIND_REQUIRED", "message": "该账号尚未完成 QQ/KOOK 绑定。" }
  },
  "data": { "result_code": 517, "code": "BIND_REQUIRED", "message": "…", "sp_binding": { … } }
}
```

- `sp_binding` **恰好三个键**：`ok` / `code` / `message`
  （`src/lib/bind-gate.ts:411`）。**不含** `data`、也不含 `code_expires_at` ——
  验证码状态与过期时间去问 `POST /sp-auth/bind-status`，别指望闸门响应里带。
- `data` 里再镜像一份同样的 `sp_binding` 与可读 `message`
  （`src/lib/bind-gate.ts:417-422`），给拿不到头部的客户端兜底。
- `viewer_id` 保持 `generateDataHeaders` 的默认 0：拒绝路径绝不回可登录凭据
  （`src/lib/bind-gate.ts:403`）。
- `code` 只有两种取值：`BIND_REQUIRED`（未绑定、无映射、grant 过期、
  `bind_state='pending'`、device_id 非法）与 `ACCOUNT_DISABLED`
  （`bind_state='disabled'`，话术「该账号已被停用，请联系管理员。」）。
  话术统一取自 C7 字典（`messageFor` → `src/lib/sp-auth/contract.ts:39-54`），闸门不另造文案。

### 判定逻辑

`evaluateBindGate(input, deps)`（`src/lib/bind-gate.ts:296-364`）是**纯函数**：
不查库、不写日志，返回值里带九种 `reason`（`:238-247`）。判定顺序：

1. 闸门关 ⇒ `allow`（`reason: "gate_disabled"`）。
2. 命中白名单 ⇒ `allow`（`reason: "udid_exempt"`）。
3. device_id 解析失败 / 查不到映射 / 映射指向已删除账号 / grant 过期 ⇒ 拒绝，`BIND_REQUIRED`
   （`reason` 分别为 `device_id_invalid`、`device_unmapped`、`device_orphaned`、`grant_expired`）。
4. `bind_state='active'` ⇒ 放行；`='pending'` ⇒ 拒绝 `BIND_REQUIRED`；
   `='disabled'` ⇒ 拒绝 `ACCOUNT_DISABLED`。

### 开关语义（安全边界，与普通开关不同）

| `BIND_GATE_ENABLED` 取值 | 结果 |
| --- | --- |
| 缺失 / 空 / `0` / `false` / `no` / `off` | **关**（代码默认） |
| `1` / `true` / `yes` / `on` | 开 |
| 其它任何值（含拼错） | **开 + fail-closed，并在启动横幅告警** |

- 关闭时 `evaluateBindGate` 在**读任何表之前**就 `return allow`（`src/lib/bind-gate.ts:304`）
  ⇒ 零额外查库，行为与闸门引入前逐字节一致。
- 拼错即开是刻意的：闸门是安全边界，不能因为 `BIND_GATE_ENABLED=TURE` 就静默放行。
  这与 `src/lib/udid-probe.ts` 的 `flagEnabled`（只认 `1`/`true`、默认关）**故意不同**，
  理由写在 `src/lib/bind-gate.ts:76-82`。
- 白名单 `BIND_GATE_EXEMPT_UDIDS`：逗号分隔，`matchExemptToken`（`:511`）
  同时比对 `device_id` 与 `udid` 头，空 token 与垃圾 token 永不匹配 ——
  给服主自测用，别拿来当长期后门。

### 启动横幅与观测

- 启动时 `src/cn-server.ts:145` 调 `reportBindGateMode()`（import 在 `:94`），
  打印当前模式；开闸会打印「拒绝未绑定设备（契约 C3, result_code=517）」，
  关闸会打印警告「生产环境必须设为 1，否则绑定流程形同虚设」。
- 每次拒绝：`recordBindGateRejection`（`src/lib/bind-gate.ts:474-492`）是**唯一副作用出口** ——
  ① 打一行 JSON 日志（`event:"bind_gate_reject"`、`result_code`、`code`、`reason`、`client`、
  `device_id`、`udid`、`account_id`、`bind_state`、`time`）；
  ② 写审计 `bind_audit(action="gate_reject", actor="bind-gate")`。
  审计写失败只记一行日志，**绝不影响 517 响应**。
- iOS 被挡时会额外打一行中文提示（`IOS_MANUAL_BIND_HINT`，`src/lib/bind-gate.ts:57-58`）：
  iOS 端没有验证码界面，让玩家走 R3 人工绑定 —— 群内报 UDID/设备号 → bot → 后台人工绑定。
  `client` 字段（`ios`/`android`）只影响日志与这句提示，**不影响判定结果**
  （`resolveBindGateClient`，`:140-163`；iOS 的判据是 dummy udid `10000001` 与
  User-Agent 里的 `ios;` / `adobeair` / `cfnetwork`）。

### 517 是新值

516 已被 `src/lib/takeover-access.ts:6` 的接管旧件错误占用，不要复用。

## 运维手册

**部署前必做**

1. `BOT_API_TOKEN` 必须显式设成一个强随机串。留空 ⇒ `/api/bot/*` 整组 403，
   玩家用 bot 自助绑定会全部失败。
2. `SIGNUP_CODE_TTL_MINUTES` 不设也能跑（默认 30 分钟），设了不要超过 10080。
3. 后台不提供管理员账号体系：`/api/bindings/*` 与 `/admin/` 只能暴露在可信网络内。
4. `BIND_GATE_ENABLED` 在公网部署必须显式设成 `1`。代码缺省是**关**，
   漏设的后果是未绑定设备直接进游戏、整套绑定流程形同虚设；
   启动横幅会打印当前模式，部署后先看那一行。

**常见现象对照**

| 现象 | 判据 | 处置 |
| --- | --- | --- |
| 玩家说「验证码不对」 | 码 6 位、字母表不含 `0/O/1/I` | 让玩家逐字重念；连续 5 次错会 `CODE_LOCKED`，需重新发码 |
| 玩家说「码过期了」 | 默认 30 分钟 | `POST /api/bindings/codes` 补发 |
| 玩家一直拿不到码 | 他登录时收到 `BIND_REQUIRED` 的 `data.code` 为空 | 说明没有活码；让他在登录页点重发，注意 60 秒窗口内只会拿到 `RATE_LIMITED` |
| 绑不上，报 `ALREADY_BOUND` | 该平台身份已挂在别的账号上 | 后台按 `platform` + 平台 uid 查 `/api/bindings`，先解绑旧账号 |
| 后台改不了主绑定 | `DELETE` 解主绑定走的是一条独立分支 | 主绑定迁移用 `POST /api/bindings/:id/primary`，不要先删后加 |

**查证入口**

- 绑定列表：`GET /api/bindings?platform=qq&state=pending&query=<uid>`
- 验证码台账：`GET /api/bindings/codes?accountId=<id>`
- 审计流水：`bind_audit` 表（写入在 `src/data/domains/account-binding.ts:188`，
  查询在 `:216`）
- 自动化：`tools/sp_auth.test.cjs`（登录页六路由与错误码）、
  `tools/account_binding.test.cjs`（领域函数与状态机）、
  `tools/bind_gate.test.cjs`（闸门两态、白名单与载荷形状）、
  `tools/bindings_api.test.cjs` 与 `tools/bot_api.test.cjs`（两个控制面）、
  `tests/admin-bindings-ui-source.test.js`（后台绑定管理页接线）。
  前三条在 `integration:database` 组，后三条在 `admin` 组
  （分组表见 `tools/test-workflow/groups.cjs`，改动选测逻辑见 `tools/test-workflow/select-tests.cjs`）

## 边界与未覆盖项

- 绑定闸门 517 已实现（见上节）；`.env.example` 里 `BIND_GATE_ENABLED=1` 是**默认值**，
  但代码缺省是 0 —— 换部署环境时忘了带这个变量，就等于闸门关着。
- iOS 的**自助**验证码入口已接通：公告通道注入了 `provideCode`
  （`src/lib/ios-notice-code.ts`，注册处 `src/cn-server.ts:354-364`），
  iOS 玩家在游戏原生公告弹窗里能看到该设备的 6 位码，再发 `/bind <code>` 给 bot。
  R3 人工绑定仍是查不到设备 / 已绑定时的兜底（详见 [iOS 客户端接入](./ios-client.md)）。
- 平台只有 `qq` / `kook`；新增平台要同时改 `src/data/types.ts:931` 与
  `src/data/domains/account-binding.ts:39` 的白名单，并补 C7 话术。
- iOS 客户端的绑定路径与人机流程见 [iOS 客户端接入](./ios-client.md)；
  它走的是「人工 R3 绑定」，不复用 `/sp-auth/*` 的页面。
- 各路由的端点级覆盖状态见[路由族覆盖矩阵](../reference/routes-status.md)；
  客户端是否通过以[测试进度](../status/test-progress.md)为准。
