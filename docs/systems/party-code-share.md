# 编队分享码（Party Code）

> 客户端验收状态：待人工验收。当前完成代码、契约与路由回归验证。

## 范围

编队分享码是两名玩家之间的一次性编队交接：发送方在编队编辑页发布得到 6 字符码，
把码发给对方（游戏外渠道），对方在编队编辑页输入码即可把该编队复制到自己的编队编辑
缓冲。它只在同一个 `starpoint-cn` 实例内有效，不跨节点、不跨服，也不进入存档。

## 协议

| 端点 | 请求 | 成功响应 | 失败 |
| --- | --- | --- | --- |
| `/party/publish` | `party_name`、`battle_party{characters,unison_characters,equipments,ability_soul_ids}`、`viewer_id` | `data.party_code`（6 字符 String） | 400 `Invalid battle party.` / `Invalid viewer id.` / `Invalid request body.` |
| `/party/refer` | `party_code`（String） | `data.party_name` + `data.battle_party`（四个数组，与发布时逐字段一致） | 400 `Invalid request body.`；未知码 → HTTP 200 + `result_code 3404` |

客户端在 `PartyReferRemote.errorHandler` 里只理解三个业务码：`3403` 不兼容、`3404` 不存在、
`3405` 旧版二进制。本实现只使用 `3404`——另外两个描述的是官方二进制版本迭代，本地私服
不存在对应状态，回它们等于凭空造一个玩家无法处理的分支。

## 码的形态由客户端决定，不是风格选择

编队码输入框在 `PartyCodeInputDialog.as:118` 用

```
^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty]{6,}$
```

决定确认按钮是否可点，所以服务端下发的码必须只由这 49 个字符组成，否则玩家看得到码却
输不进去（旧 Stub 返回的是 `https://www.howLongCanThisBe?=+-.com` 拼三次，含 `:`、`/`、
`?`，正是这种「显示正常但永远无法兑换」的故障）。字母表刻意去掉了 `0 I O S Z` 与
`c e i k l m n o p s u v w x z`——这些是抄码时最容易看错的字符。
`PARTY_CODE_ALPHABET` 与 `PARTY_CODE_LENGTH` 定义在 `src/lib/party-code/registry.ts`，
测试 `tools/party_code_route.test.cjs` 直接断言下发的码匹配上面这条正则。

## 存储边界

- 目录是**进程内存**（`PartyCodeRegistry`），不写 SQLite：重启即全部失效，
  不会出现在存档导出、恢复或克隆里。
- 过期 `PARTY_CODE_TTL_MS = 24h`，延迟清理（发布时清扫 + 读取时判定）。
- 容量 `PARTY_CODE_CAPACITY = 4096`，超出按插入顺序淘汰最旧的一条；这是防「循环发布」
  的内存上限，不是产品配额。
- 码用 `randomBytes` 生成而非序号派生：可猜的码等于任何人可以拉走陌生人的编队。
  序号只用于拆冲突重试。

## 为什么 refer 回的是发布方的成长值

`data.battle_party` 里的 `evolution_level` / `exp` / `over_limit_step` / `mana_node_ids` /
`illustration_settings` / `ex_boost` 全部原样回发布时收到的值，而不是从数据库重新投影：

- `PlayerCharacter` 里**没有** `mana_node_ids`（觉醒节点在独立表，`mana_node_ids` 只在
  多人快照与 NPC 模板里出现过），重新投影会凭空丢掉这一项；
- 兑换方本来就未必拥有这些角色，真正的「能不能用」由客户端
  `CopySourcePartyDataTools.excludeUnownedCharactersAndItems` 在本地判定，随后走正常的
  `party/edit` 上行（服务端的角色所有权校验在 `/party/edit`，不在 refer）；
- 因此 refer 不需要知道是谁在兑换，也不需要校验兑换者的存档。

`ex_boost` 在 `status_id` 缺失或为 0 时返回 `null` 而不是补 0：客户端把 `status_id` 直接
喂给 `ExStatusLogic`，而 `ex_status` master 的 id 从 1 起，补 0 会让编队页抛错。

## 槽位保持原状

四个数组的长度与槽位位置完全按发布时的样子回传（空槽是 `null` 元素，不是被裁掉的尾巴）。
编队编辑器按位置渲染九个槽位，裁掉尾部空槽会让复制出来的编队整体错位。

## 与 Gate C 的关系

`docs/reference/stub-route-audit.md` 原先记录本功能「跨节点 Party Code 目录所有权未定，
明确延期」。本实现落地的是**单实例**语义：目录只在本进程内，地址簿所有权问题不再存在。
跨节点共享码（多实例房间/多进程部署）仍然未实现。

## 自动测试

`tools/party_code_route.test.cjs`（真实 Fastify + SQLite + msgpack，11 例）：

- 码匹配客户端正则、长度 6、字符全部在字母表内；
- 两次发布得到不同的码；
- refer 逐字段回传发布方的编队（含 `ex_boost`、`illustration_settings`、`null` 槽位与四个数组长度）；
- 未知码 → `result_code 3404` 且 `data` 为空对象；码大小写敏感；
- 畸形 `party_code` → 400；
- 非整数成长值 → 400 `Invalid battle party.` 且不产生码；
- `ex_boost.status_id: 0` 不落库为 0，而是保持缺失；
- 超长 `party_name` 截断到 20；
- TTL 过期后码不再解析。

## 尚未自动覆盖

- 真机双人验收：A 发布 → 粘贴码 → B 输入 → 编队编辑页出现 Copying 状态 → 确认复制 →
  `/party/edit` 落库；
- 兑换方未拥有角色/装备时 `excludeUnownedCharactersAndItems` 的实际表现（客户端行为）；
- 重启后旧码失效的玩家可见反馈（当前是「码不存在」对话框，与过期同一条路径）。
