# 随机招募与 NPC 回退设计

> 当前状态：已实施（同服内真人随机招募）。`npc_mode_enabled` 开关未实施，见下表。

本文定义多人房间的真人随机招募、NPC 回退和后台设置边界。目标是补齐国服客户端已经存在的随机招募服务端协议，同时保留当前服务端使用 NPC 保障单人体验的能力。

已落地的部分：房主选择随机招募后 `share_room` 登记招募、`/attention/check` 下发 `data.multi` 铃铛、房间满员/解散/关闭招募即撤下。招募状态是进程内内存（`src/multi/recruitment/registry.ts`），不落盘。`npc_mode_enabled` 与 `summon_com_seconds` 后台入口尚未实施，现有 NPC 流程保持原样。

实现位置：

| 文件 | 职责 |
|---|---|
| `src/multi/recruitment/registry.ts` | 进程内招募登记表（幂等刷新、可见窗口、重投递上限、关闭） |
| `src/multi/recruitment/attention.ts` | `data.multi` 契约构造（字段类型严格对齐客户端解析器） |
| `src/multi/recruitment/query.ts` | 把登记表投影成某玩家可见的铃铛列表 |
| `src/multi/http/room.ts` | `/share_room` 按 `share_type_list` 开/关/刷新招募 |
| `src/routes/api/attention.ts` | `/attention/check` 返回 `data.multi` |

## 1. 设计结论

NPC 模式和 NPC 等待时长是两个独立配置：

| 配置 | 作用 | 默认行为 |
|---|---|---|
| `npc_mode_enabled` | 是否启用当前 NPC 优先流程 | **未实施**；当前等价于 `false`（真人招募始终可用） |
| `summon_com_seconds` | 官方真人招募开始后，客户端等待多久再请求 NPC | 当前服务端下发 `20` 秒 |

`npc_mode_enabled` 不使用 `0` 表示关闭。它是布尔开关：

- `true`：服务端不建立真人招募队列，`summon` 按当前实现返回 NPC；`attention/check` 不返回本服真人招募请求。
- `false`：服务端启用官方真人随机招募；真人不足时，客户端等待 `summon_com_seconds` 后请求 `summon`，服务端只补足剩余空位的 NPC。

该开关没有进入 `server_gameplay_settings`，也没有出现在后台；当前行为等价于 `false`，即房主手动选择随机招募就会发布铃铛。若要恢复“NPC 优先”的旧体验，需要在登记表与 `/attention/check` 之间补一道设置门。

`summon_com_seconds` 只影响客户端何时请求 `multi_battle_quest/summon`，不负责切换 NPC 模式。当前服务端下发 `20` 秒（`src/routes/api/attention.ts`）。客户端在 `MultiBattleRoomScene.as` 的房主分支里用这个值作为门槛：招募计时器启动后经过该秒数、房间仍未满，就调用 `summon` 并同时停止重发招募。所以这个值同时是「铃铛真实可被别人看到的窗口」——`20` 秒意味着大厅里的其他玩家必须在 20 秒内点铃铛，超时后房主房间被 NPC 补满，铃铛随之撤下。设计文档早期建议的 `120` 秒更适合真人招募，但改它属于体验决策，需要业主确认。TCP 中的 NPC 加入消息延迟和 ready 消息延迟仍是内部协议时序，不与该设置混用。

首期只实现同一服务端内的真人随机招募。跨 Hub、跨服的随机招募另行设计，不把跨节点房间发现混入本功能。

关闭 NPC 模式不会改变客户端的入口行为：仅创建房间、进入房间或原地等待，都不会自动开启随机招募。房主仍需在房间内选择随机招募；服务端不能替客户端凭空触发 `share_room` 请求。若要实现“创建房间后自动发布招募”，那是额外的服务端自定义行为，不属于官方客户端流程。

## 2. 国服客户端证据

CN 1.8.1 反编译源码已经包含完整的客户端招募链路：

1. 房主在房间内选择随机招募后，`MultiBattleRoomScene.shareRequestAPI()` 才会把 `roomSharings[3]` 标记为已选择、启动 Attention 招募，并调用 `multi_battle_quest/share_room`。仅创建房间不会执行这一步，请求字段包含：

   ```json
   {
     "category": 19,
     "quest_id": 500009002,
     "room_number": "126523",
     "share_type_list": [3]
   }
   ```

2. `AttentionRecruitmentRedeliverTimer` 首次立即发送招募，之后按照 `attention_recruitment_interval_seconds` 重复发送；当前客户端配置为 15 秒，最多 20 次。房间满员或进入 NPC 回退后停止重发。客户端还会在已选择随机招募并恢复房间状态后设置一个 1800 帧的延迟重发计数，但这不是创建房间后的自动开启。

3. 其他玩家在普通场景或战斗场景按客户端配置轮询 `/attention/check`。当前配置为普通场景 10 秒、战斗场景 15 秒，请求携带 `holding_number` 和 `request_number=3`。

4. `/attention/check` 成功响应中的 `data.multi` 是招募通知列表。每项至少包含：

   ```json
   {
     "attention_key": "...",
     "quest_info": {
       "category_id": 19,
       "quest_id": 500009002,
       "room_number": "126523",
       "establisher_character": 151165,
       "establisher_character_evolution_img_level": 1,
       "establisher_follow": 0,
       "establisher_rank": 138,
       "host_entry_time": 1719622252,
       "is_newbie": false
     }
   }
   ```

5. 其他玩家接受通知后，客户端根据 `room_number` 进入对应房间。成功进入后，房主继续接收成员变化，真人成员占用房间空位。

6. 房主开始随机招募后，客户端在 `summon_com_seconds` 到期且房间仍未满时请求 `multi_battle_quest/summon`。本项目首期将该值设置为 120 秒。若返回有效 NPC，客户端再通过 TCP `EnterComs` 将 NPC 加入房间；若没有有效 NPC，则停止本轮 NPC 尝试并继续随机招募。

因此，官方客户端的“随机招募”和“NPC 回退”已经是两段流程。服务端不能只延长当前 TCP NPC 消息的延迟来实现真人招募。

主要参考文件：

- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/scene/bossBattle/room/MultiBattleRoomScene.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/context/attention/AttentionRecruitmentRedeliverTimer.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/remote/attention/check/AttentionCheckRealRemoteService.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/context/attention/AttentionSystemLogic.as`

## 3. 服务端接入点与现状

下表记录各接入点当前的行为，以及本次实施后是否仍然需要调整：

| 位置 | 本次实施后的行为 | 是否仍需调整 |
|---|---|---|
| `multi_battle_quest/share_room` | 按 `share_type_list` 判定：含 `3` 创建或幂等刷新招募，不含 `3` 关闭该房间招募，缺字段按启用处理（兼容老客户端）；`category`/`quest_id` 与活房不符返回 400 `Room quest mismatch.` | 已完成 |
| `/attention/check` | 返回 `data.multi` 数组（无可用招募时为 `[]`），字段严格对齐客户端解析器 | 已完成 |
| `/attention/action` | 仍只返回优先级分数 | 保留 stub：客户端不带 key 调用，首期不作为匹配入口 |
| `multi_battle_quest/get_rooms` | 仍只返回请求玩家自己的房间 | 不改造为 Attention 招募入口，铃铛走 `data.multi` |
| `multi_battle_quest/summon` | 仍返回固定 NPC | 未改；客户端只在招募计时器启动后经过 `summon_com_seconds` 才调用它，且客户端自己保证房间未满 |
| TCP lobby | `EnterComs` 后直接绑定 NPC roster | 保留作为客户端 NPC 回退的最终接入点 |

`/attention/check` 的可见性判据（全部在每次轮询时重新向协调器取实时房间状态，而不是读登记表快照）：

- category、quest ID、房主 viewer ID 必须与登记时一致，否则丢弃；
- 房间当前真人数 `< 3`，或请求者本人已在成员列表里（已进房的人保留铃铛）；
- 请求者不是房主本人（自己的房间不出现在自己的列表）；
- 不额外校验房主在线状态与 `raising_state`——guest 走 `Enter` 进房的路径本身没有这两道门槛，加上去会与既有可加入语义不一致。

登记表的可见窗口由“最后一次 share 时间”决定：`RECRUITMENT_VISIBLE_WINDOW_MS = 30_000`（覆盖 15 秒重投递间隔加一次丢包），并对客户端时钟早于服务器的情况容忍 `5_000ms`。累计 share 次数达到 `RECRUITMENT_REDELIVER_LIMIT = 20` 时视为客户端已按 `attention_recruitment_redeliver_limit` 停止重发，服务端主动撤下铃铛，不假装房间还在招募。

`attention_key` 由服务端生成（`wfcn-<base36 序号>-<base36 时间戳>-<8 位 hex>`）。客户端只断言它是 String、并用精确相等匹配，不校验格式，因此格式不与官方一致不影响功能。同一房间重复 share 时 key 保持不变——客户端进房后会凭这个 key 把该条通知标记为“参加中”，换 key 会让玩家手里的铃铛失效。房间关闭后重新招募才生成新 key。

## 4. 首期服务端状态机

真人招募请求只属于进程内房间，不写入玩家存档和业务数据库。当前房间本身也是进程内状态，因此服务重启后请求自然失效；客户端可以重新创建房间。

```text
Idle
  -> 房主手动选择随机招募
  -> share_room
Recruiting
  -> 真人接受并进入房间
Recruiting
  -> 房间满员 -> Closed
Recruiting
  -> summon_com_seconds 到期 -> NPC fallback
NPC fallback
  -> summon 返回 NPC -> EnterComs -> Closed
NPC fallback
  -> 真人同时进入 -> 只补剩余 NPC -> Closed
Recruiting / NPC fallback
  -> 房主离开、解散或房间过期 -> Closed
```

招募请求至少需要保存：

- `room_number`、category、quest ID；
- 房主 viewer ID 和创建时间；
- 当前有效招募次数和最后发布时间；
- Attention key 和过期时间；
- 房间当前真人成员数；
- 请求状态和关闭原因。

登记表实际保存的字段（`RecruitmentRecord`）：`roomNumber`、`hostViewerId`、`category`、`questId`、`attentionKey`、`firstSharedAtMs`、`lastSharedAtMs`、`shareCount`。**房间真人成员数不缓存**——每次轮询都向协调器取实时状态，避免登记表快照与真实房间脱节；过期时间不单独存储，由 `lastSharedAtMs + 30s` 推导；关闭原因不存储，关闭即从表中删除。

同一房间的重复 `share_room` 必须幂等刷新已有请求，不能产生多个通知。房间满员、房主离开、解散、NPC 回退或房间过期后，旧 Attention key 必须失效。

真人加入和 NPC 补位必须在同一房间状态锁内完成判断：

- 真人先占位时，NPC 只能补剩余槽位；
- NPC 回退先完成时，后续真人仍可替换 NPC，但不得超过三名真人/成员上限；
- 过期通知、重复接受和断线重连不能重复占用槽位；
- 不同房间可以使用相同 quest，但不能共享招募状态。

## 5. 后台设置

> 本节是待实施的设计。当前 `server_gameplay_settings` 只有掉率/救援碎片/700011 兼容三项，后台的 Gameplay 页面也没有招募相关字段；`summon_com_seconds` 与其它 attention 配置一起硬编码在 `src/routes/api/attention.ts` 的 `/attention/check` 响应里。

`npc_mode_enabled` 和 `summon_com_seconds` 属于运行中的游戏体验设置，进入 `server_gameplay_settings`，由新管理后台修改。环境变量只作为旧部署首次初始化时的兼容输入，单例设置存在后由数据库值作为权威。

后台需要显示：

- NPC 模式开关；
- 当前 NPC 回退等待秒数；
- 保存成功或失败反馈；
- 当前生效值，无需重启服务。

后台不提供招募请求的手工修改入口。招募请求只由游戏协议创建和关闭，避免后台状态与进程内房间状态分离。

## 6. 不属于首期范围

- 跨 Hub、跨服务端随机招募；
- 公网匹配服务器或全局玩家大厅；
- 持久化招募队列；
- 修改客户端 Attention UI 或招募倒计时；
- `attention/action` 优先级算法的官方复原；
- NPC 模板、NPC 名称池和 NPC 战斗 AI 的重新设计；
- 真实玩家匹配的评分、推荐和反作弊策略。

## 7. 验证范围

已落地的自动测试：

| 文件 | 覆盖 |
|---|---|
| `tests/multi-attention-recruitment.test.js` | 登记表与查询层共 23 例：`share_type_list` 判定、幂等刷新保持 key、30 秒过期、20 次重投递上限、`close()`、契约字段类型、空列表、自己房间不出现、满员隐藏但给已进房成员保留、房间不存在/协调器失败、live quest 变更、换房主、房主解析失败、`holding_number` 上限与 0 饱和、requester 身份单次解析、同 quest 两房间互不污染、`establisher_follow` 逐房间计算、非法角色 id 兜底为 1 |
| `tools/attention_recruitment_route.test.cjs` | 路由级端到端（真实 SQLite + 真实 `EmbeddedMultiCoordinator` + `fastify.inject`）共 9 例：无招募返回 `[]`、share 后对方收到完整契约、自己的房间不出现、`holding_number=0` 不发、满员隐藏且对已进房成员保留、不含 3 的 share 撤下、重复 share 保持 key、解散即撤下、quest 不符返回 400 且不发布 |

尚未自动覆盖、需要人工或后续补充的部分：

- NPC 回退与真人加入三种竞争顺序（真人先加入、NPC 先补位、同时到达）；
- `summon` 只补足剩余空位（当前仍是原实现）；
- 后台设置即时生效（`npc_mode_enabled` 未实施）；
- Hub 房间走 attention 的行为（本功能只在同节点内生效，Hub 房间的 `data.multi` 恒为空）。

客户端人工验收仍需要确认：

- 招募通知是否出现；
- 接受通知后是否进入正确房间；
- 真人加入后房主页面是否立即刷新；
- 等待时间到期后 NPC 是否正常加入；
- 重复招募、断线和重赛时 UI 是否符合预期。
