# 苹果v18.ipa × iOS-1.8.4.ipa 差分解剖：v18 到底打了什么补丁，能不能改由注入 dylib + hook 复刻

> 审计对象（只读副本，未修改原件）
> - `苹果v18.ipa`：167,038,327 B，sha256 `66b1057c…`（`C:\Users\relea\.dsh\attachments\v1\files\66\66b1057cc7cd9e66da7a38aa9e4963d7effe2220f0889a9fcff4cfa1eeac77e0\苹果v18.ipa`）
> - `iOS-1.8.4.ipa`：139,212,360 B，sha256 `5241e51b…`（`C:\Users\relea\.dsh\attachments\v1\files\52\5241e51b40bd9d7e2ad92bae9b85e4dc31cd19cd68a637d363c5dcca3eae0a3a\iOS-1.8.4.ipa`）
> 解包树 `D:\ipa-diff\v18\Payload\worldflipper.app`、`D:\ipa-diff\v184\Payload\worldflipper.app`；分析脚本 `D:\ipa-diff\*.py`。
> 结论口径：**v18 不是「一份 hook 补丁」，而是一个重新编译过 AS3(AOT) 的客户端本体**。下面给出逐层证据与 hook 可行性边界。

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| v18 相对 1.8.4 的 delta 是什么 | 5 个文件不同；其中主二进制 3 处结构性改动：**+14 个新 Mach-O 段（111.6 MB）**、**__text 里 486 处就地代码改写（5,029 B）**、**__TEXT.__const 里 ≈6.0 MB AS3/AOT 元数据整体重建（85.5% 字节不同）** |
| 能否改用「注入 IPA 的 substrate dylib + hook」实现 | **只能覆盖其中一小部分**：端点重定向 + 官方 SDK/登录/更新/计费/日志抑制（≈ 你现在 `client-patch` 已在做的那一类）。**112 MB 的新功能（新 AS3 类、场景、数据表、跳转实现）没有 hook 等价物** —— 那部分必须以「出包」形式交付 |
| 那 CN 方自己是怎么做的 | 也是**静态二进制注入**（改 Mach-O、加段、就地打补丁），不是 hook。这本身就是「hook 不足以达成其目标」的旁证 |

---

## 1. 包级差分：3568 条目里只有 5 个文件不同

全树 3,568 个归档条目，**文件名集合逐条相同**；全量 size+sha256 比对后仅 5 个文件内容不同（其余 3,563 个同尺寸文件内容差异 0）：

| 文件 | v18 | 1.8.4 | delta |
|---|---|---|---|
| `Payload/worldflipper.app/worldflipper` | 221,501,728 | 108,757,200 | **+112,744,528** |
| `Payload/worldflipper.app/worldflipper_ios_release.swf` | 10,023,966 | 11,242,032 | −1,218,066 |
| `Payload/worldflipper.app/Info.plist` | 4,319 | 11,560 | +7,241 |
| `Payload/worldflipper.app/asset/production/ios_bundle/dc/bcccb129122c0189c8eab004ecc4516a077f3e` | 480 | 466 | −14 |
| `Payload/worldflipper.app/META-INF/AIR/application.xml` | 4,687 | 4,693 | +6 |

### 1.1 身份/描述层（无技术含量，产线已在做）
- `Info.plist`：**键集合完全相同**，仅 3 个键不同 —— `CFBundleIdentifier` `com.leiting.wf`→`com.kulo.wf`、`CFBundleURLTypes[0].CFBundleURLName` 同步改、`CFBundleVersion` `1.8.4`→`1.8.46`（`CFBundleShortVersionString` 两包都是 `1.8.4`）。其余 7,241 B 差值是二进制 plist 的编码差异。
- `application.xml`：仅 2 处 —— `<id>com.leiting.wf</id>`→`<id>com.kulo.wf</id>` 及同值 `<string>`。
- 两边 URL scheme 都是 `worldflipperlt`，`CFBundleExecutable` 都是 `worldflipper`，MinimumOSVersion 12.0，`NSAllowsArbitraryLoads=true`。
- `asset/production/ios_bundle/dc/bcccb129…`：466/480 B 高熵不可读密文块，两包互不相同 —— 疑似与 bundle id 绑定的加密配置/token（**唯一一处无法用字符串/表结构解释的差异**）。

### 1.2 SWF 层：几乎没动
- v18 是 `CWS`（zlib 压缩），1.8.4 是 `FWS`（未压缩）；**解压后 body 长度同为 11,242,024**。
- tag 结构完全相同（tag code 序列相同、每个 tag 长度都相同、DoABC 各 284 个），**逐字节比对只有 19 字节不同**，集中在一个 38 B 的 `DoABC` 标签（名 `boot_2a1b`）里的「3 字节 + 16 字节摘要」。
- 也就是说：**SWF 里的 AS3 字节码逐字节相同**，v18 没在这里做任何功能改写。
- 参考：`worldflipper_ios_release.swf` 里 `pinball.` 只出现 7 次、`HomeScene`/`BattleCharacterLogic`/`DevConfig`/`sdkDummy` 均为 0 次 —— 与仓库既有认知一致（iOS 走 AOT，游戏 AS3 不在 SWF 里）。最大 tag 是 `DefineFont3`（75，10,625,285 B 字体）。

---

## 2. 主二进制解剖

### 2.1 骨架：同一份 AIR 运行时，节地址/尺寸逐节相同
`__TEXT` vmsize `0x6208000`、`__text` size `0x057d2684`、`__DATA` filesize `0x2ac000`；`__stubs/__stub_helper/__objc_stubs/__gcc_except_tab/__literals/__objc_methname/__ustring/__unwind_info/__eh_frame` **差异 0 字节**。`LC_MAIN` Entry `0x1122f0`、`LC_FUNCTION_STARTS`、`LC_CODE_SIGNATURE`、`LC_BUILD_VERSION`（SDK 18.2 / lld(17)）相同；两边 `LC_ENCRYPTION_INFO_64` 都是 `cryptid=0`（已解密，可直接改）。

### 2.2 v18 独有：14 个新增段（111,575,040 B），插在 `__DATA` 与 `__LINKEDIT` 之间
load command 81 条 vs 67 条（+14）。每段一个 `__payload` 节：

| 段 | vmsize | fileoff | 权限 |
|---|---|---|---|
| `__LENS` | 0x8bc000 (9.16 MB) | 0x64b4000 | r-x |
| `__ABYAUTO` | 0x570000 (5.70 MB) | 0x6d70000 | r-x |
| `__CNUPDATE` | 0x594000 | 0x72e0000 | r-x |
| `__CNACCT` | 0x2b4000 | 0x7874000 | rw- |
| `__HUDSTATE` | 0x4000 | 0x7b28000 | r-x |
| `__CNCACHE` | 0x57c000 | 0x7b2c000 | r-x |
| `__CNCTAB` | 0x2b4000 | 0x80a8000 | rw- |
| `__CNRECORD` | 0x578000 | 0x835c000 | r-x |
| `__CNRCTAB` | 0x2b4000 | 0x88d4000 | rw- |
| `__CNSHOP` | 0x578000 | 0x8b88000 | r-x |
| `__CNSHTAB` | 0x2b4000 | 0x9100000 | rw- |
| `__CNADMIT` | 0x58c000 | 0x93b4000 | r-x |
| `__CNADTAB` | 0x570000 | 0x9940000 | rw- |
| `__CNRECIO` | 0x3064000 (48.4 MB) | 0x9eb0000 | r-x |

vmaddr 区间 `0x106524000`–`0x10cf84000`；`__LINKEDIT` 被顺移到 fileoff `0xcf14000`。

**内容定性（已验证）**
- 段内含 **真实 ARM64 代码**：对 224 处 `B` 跳转目标按段表做 VA→fileoff 映射后取 4 KB 取样，BL 占比 3.7%–4.7%、`RET` 非零、首指令就是标准序言（如 `0x107b9e6c0`：`fd7bbaa9 e00701a9 e20f02a9 e41703a9` = `stp x29,x30,[sp,#-0x60]!; stp x0,[sp,#0x10]; …`）。
- 段内同时含 **AS3/AOT 元数据与多重名常量池**：`pinball.` 出现 8,365 次/段（`__CNRECIO` 高达 67,100 次），并含 `.as$`、`FilePrivateNS:`、`AbyssDetails.as$0:anonymous`、`ClientAdmission`、`LocalRecordIO`、`BossMechanics`、`starling`、`flash.` 等。
- `__CNCACHE` 里出现**私有服自有标识**：`NSString`/`NSUserDefaults`/`NSBundle`、`cn.startpoint.startup-network-cache.install-v1`、UUID `93843279-d87f-4499-bcc4-2b0fd03a3e05`（"startpoint" 与本源仓库同名，值得确认是否同源产物）。
- 4 个 `*TAB` 段（`__CNACCT/__CNCTAB/__CNRCTAB/__CNSHTAB/__CNADTAB`）**互为近乎同一张表**（512 B 块匹配 5518–5530/5536）——生成器把同一张 ~2.72 MB 表重复盖了多份。
- `__LENS` 是**跳板岛**：命中其中的目标形如 `adrp x16,…; add x16,x16,#…; br x16; nop`（`10ad02b0 10821c91 00021fd6 1f2003d5`），即 162 处重定向经它二次跳转。

### 2.3 `__TEXT.__text`：486 处就地改写，共 5,029 B（占 92,087,940 B 的 0.0055%）
- 形态分布：`B`（26 位相对跳转）**≈224–229 处**、`NOP`(`1f2003d5`) 19 处、`BL` 8 处，其余为 1–22 B 的多字节重写（`MOV X0,#0; RET` 整函数桩、序言改写、函数中段条件反转等）。
- 典型样本：
  - `@0x1122f0`（**LC_MAIN 入口**）1.8.4 `a9bd57f6`(`stp x22,x21,[sp,#-0x30]!`) → v18 `15ea30f4`(`B`)，目标 `0x107b9e6c0`（`__CNCACHE`）
  - `@0x64b238` `d10703ff`(`sub sp,sp,#0x1c0`) → `d2800000 d65f03c0`(`MOV X0,#0; RET`)
  - `@0x60f15c` / `@0x698990` `a9be4ff4` → `52800000 c0035fd6`(`MOV W0,#0; RET`)
  - `@0x6c6cfc` `37000700`(`TBZ`) → `14000038`(`B`)，目标 `0x1006c6ddc`（仍在 `__TEXT` 内）——**函数中段条件反转**，这类不是「包一层」能做到的 hook
  - `@0x312230` 16 B 序言 → `d2800000 d65f03c0 d503201f d503201f`
- 跳转目标分布：`__LENS` 162、`__TEXT` 20、`__CNRECIO` 19、`__CNUPDATE` 13、`__CNADMIT` 5、`__CNSHOP` 4、`__CNCACHE` 3、`__HUDSTATE`/`__ABYAUTO`/`__CNRECORD` 各 1。
- 符号表无助于定位：`LC_SYMTAB` 仅 1,587 项，全是 ANE 调试路径（`/pb/pinball20190816/core/client/lib/crackify/ios/Crackify/CrackifyContext.m`、`GenerateSignature`、`Vibration`、`distriqt/*`、`leitinglib`）与导入符号（`_AVAudioSession…`）。**运行时函数全被 strip**，只能按 file offset/VA 寻址。

### 2.4 `__TEXT.__const`：≈6.0 MB AS3/AOT 元数据被整体重建
- 逐 256 KB diff 密度：`0x57d6684`–`0x5996684` 全 0；`0x5996684`–`0x5f56684` 突增至 **48.9%→95.6%**；之后又回到 0。
- 该区间 6,029,312 B，两包**字节匹配率仅 14.52%**（即 85.5% 不同），且**不是整体位移**（±16 字节位移逐一测试，最好只有 2% 匹配）；起始 48 B 两包完全相同，熵 5.77，含 `mx_internal`、`__go_to_definition_help`、`4.6.0.23201`(Flex SDK)、`mx.utils`、`XMLNotifier`。
- 定性：**结构保留、内容重排/重建的 ABC/AOT 元数据区**（不是代码：BL 0.2%、RET 0.00%），与「AS3 重新编译」一致。
- `__cstring`：264 处 run、2,975 B（占 285,229 B 的 1.04%）；`__DATA.__const/__data/__cfstring/__objc_const` 等合计仅 255 runs / 1,004 B。

### 2.5 字符串差分告诉我们补丁**做了什么**（v18 独有 807 条 / 1.8.4 独有 130 条）
- **端点重定向**（替换掉官方全套域名）：
  - v18 新增：`http://000000@124.222.203.221:80/`、`http://124.222.203.221/api/index.php`、`http://@124.222.203.221:80/shijtswy/version/`、`?res_ver=`、`124.222.203.221`
  - v18 移除：`https://worldflipper.leiting.com/`、`https://update.leiting.com/shijtswy/version/`、`https://account.leiting.com/`、`https://login.leiting.com/`、`https://captcha.leiting.com/captcha/`、`https://cfgsdk.leiting.com/`、`https://adsapi.leiting.com/*`、`https://hkwebproxyo.leiting.com/login|pay/`、`https://leitsdkshushu.leiting.com:19083/sync_data`、`https://loginaobi.leiting.com/`、`https://login5th.leiting.com/`、`https://helper.leiting.com/*`、`logmonitor.leiting.com/api/mg_log!addMgLoginLog.action`、`https://loginslave1.roguelike.com`、`https://ltpayslave1.roguelike.com`、`https://memberslave1.roguelike.com`、`https://payslave1.roguelike.com`
- **新增客户端功能类（AS3 全限定名/元数据）**：`ClientAdmission`(+12 个 `$N:anonymous`)、`AdmissionSession`(+4)、`PlayerLogin`、`LocalRecordIO`、`AbyssDetails`(+2)、`AbyssRecordDetails`、`AuthorState`、`CacheCleanupState`、`EmptyUpdate`、`ShopFirstOpen`、`RoundedButton`、`BossMechanics`、`BossMechanicsRuntime`、`DamageTypeConversion`、`GaugeGainRestriction`、`AddFeverPointRatio`、`BuildConfig`、`DashParameter`、`DialogClass`、`ELEMENTS`、`FALLBACKK`、`CLIENT_RETRY_LATER`、`FilePrivateNS:*` 命名空间常量、`pinball.scene.event.rush.ranking.party:*` 等场景全限定名
- **新增路由**：`/abyss-records/`、`/client-admission/9`、`/player-auth/`、`/player-auth/resume`
- **版本戳**：`CN-LOGIN-20260910-r15`、`CN-BOSS-MECHANICS-20260925-v3`、`724"override_fox_oracle_autumn_dual_pf`

---

## 3. 「换成注入 dylib + hook」的可行性判定

### 3.1 可以 hook（技术上成立，且与现有产线同类）
- **端点重定向**：hook URL 构造/网络层即可。但注意：你现有 `client-patch/build/patch-ipa.mjs` + `client-patch/build/lib/ios-abc.mjs` 已经用「ABC 常量池 `scheme + host` 成对**等长改写**」做到了同一件事，且不引入运行时风险。
- **官方 SDK/登录/计费/更新/日志/广告抑制**：等价于 v18 里那 19 处 NOP 与一批 `RET 0` 桩 —— 用 substrate 按地址 hook（主镜像 slide + 硬编码 offset）或直接在运行时 `vm_protect`+`memcpy` 打同样补丁，都可行。
- **注意代价**：运行时函数全 strip，hook 只能按「本版本硬编码 VA」；这跟静态改字节一样脆，却多了代码签名/PAC/ASLR/`__TEXT` 只读等失败面。**dylib 在这里是"另一种投递方式"，不是"更强的能力"。**

### 3.2 hook 做不到（必须出包）
- **112 MB 新功能本体**：14 个新段的 ARM64 实现 + AS3/AOT 元数据 + 4 份 ~2.72 MB 表。hook 只能改变**已有**函数的行为，无法凭空新增 `ClientAdmission`/`AbyssDetails`/`BossMechanics`/`LocalRecordIO`/`ShopFirstOpen` 这些类、场景与数据表。
- **224 处跳转重定向**：它们指向新实现；不带上那 112 MB 实现，重定向过去就是死路。
- **≈6.0 MB 的 AS3/AOT 元数据重建**：完全不存在 hook 语义。
- **函数中段改写**（如 `TBZ`→`B`、序言 16 B 替换）：不是「包一层」，需要精确到指令级的就地写入。

### 3.3 结论与建议
1. **v18 的 112 MB 主体 = 一个重新编译（AOT）过的客户端**，投递方式是**静态二进制注入**（加段 + 就地补丁 + 重建元数据），不是 hook 集。想拿到同等功能，路径只有「出包」：Android 侧走 `client-patch/build/build-client.mjs --as3-hook`（pcode 注入）；iOS 侧对应的是「改 AOT 后的 ABC/元数据 + 需要时加段」，比 Android 难得多。
2. **dylib + hook 的合理定位**：把「重定向 + 官方 SDK/登录/更新抑制」做成一个可复用的注入层，好处是**不依赖等长改写**（新版本改动了字符串长度也不会失效），适合做跨版本兼容；坏处是需要越狱/substrate 或重签注入，且必须按版本硬编码地址。
3. **推荐分工**：hook 层只放「不改玩法语义」的开关（端点、登录、更新、计费、日志）；**任何新增类/场景/表/数值机制都走客户端出包**，不要试图用 hook 拼出 v18 那 112 MB。
4. **需要先确认的一件事**：`__CNCACHE` 里的 `cn.startpoint.*` 键与 `124.222.203.221` 说明这份 v18 与 "startpoint" 这条线同源（与本仓库同名）。若确实是同源/自家产物，优先去取**生成这 112 MB 的构建链**（谁产出 `__LENS`/`__CN*` 段），比逆向复刻划算得多。

## 4. 未决/证据缺口
- 224 处跳转的**语义**未逐一命名（符号被 strip，只能按 VA 记录）；`__LENS` 跳板最终 x16 指向的落地实现未全量追。
- 14 个段中「代码 vs 元数据 vs 表」的具体配比未逐段切分（已确认段内含真实代码与常量池两类内容）。
- `asset/production/ios_bundle/dc/bcccb129…` 这 480 B 密文块的作用未知（唯一无法用字符串/表结构解释的差异）。
- 未验证 v18 在真机上的运行前置（是否要求特定 TrollStore/越狱环境、是否有额外运行时校验：`crackify` ANE 仍在包内）。
