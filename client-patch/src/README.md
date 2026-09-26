# P6 自研登录页 · 客户端补丁源码（Android / AS3）

本目录是 **P6 的独占写入集**：自研登录页的 AS3 源、把源回填进原始 SWF 的构建工具。它 **不是** 一个
可独立编译的 AS3 工程（本仓库里没有 AS3 编译器），真值链路见下面「构建」。

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `pinball/channels/dummy/ChannelSDKDummy.as` | **载体源**：接缝宿主类。只改 5 个既有方法体（登录页 UI + 轮询 + 网络回包 + 拆页清理），其余 20 个方法体是「可编译占位」，**永不进入最终 SWF**（最终 SWF 由路线 B 只注入 5 个靶方法体，其它方法体保持 `base.swf` 原样逐字节不变）。文件头注释写明选桩依据与约束。 |
| `tools/p6-escape.mjs` | 非 ASCII → `\uXXXX` 转义器（`node p6-escape.mjs <in.as> <out.as>`）。FFDec 读源文件按平台默认编码，中文会烂（共享导出树 `work/swf/as3_v181/scripts/**` 就是这个坑的现场）⇒ **喂 FFDec 的源必须纯 ASCII**。 |
| `tools/p6-build.mjs` | 全链构建 + 强制回读校验（见 §3）。 |
| `tools/README` 说明（本文） | 挂点表 / Plan A·B / 未验证项。 |

## 2. 挂点表（P7b `build-client.mjs --as3-hook` 需要的就是这张表）

- 靶 FQCN：`pinball.channels.dummy.ChannelSDKDummy`
- 承载它的 DoABC tag：**abcIndex = 284**（SWF 内共 285 个 DoABC tag，0 基）
- `bodyIndex` 口径：**该 DoABC tag 内 method_body 的 0 基下标**（探针 `indexSwfMethods()` 口径，
  已实测直接喂给 `-replace` 并回读通过；**不是全局下标**）

| # | 方法（成员名） | bodyIndex | 原始字节码 | 注入后字节码 | 职责 |
| --- | --- | --- | --- | --- | --- |
| 1 | `startLoginServer` | **7268** | 9 B | 827 B | 接缝入口：建页、取 `device_id`、挂 `ENTER_FRAME` + `stage.MOUSE_DOWN` 监听 |
| 2 | `testLogin` | **7266** | 130 B | 5057 B | 帧循环：请求超时、发请求（唯一发点）、轮询调度、倒计时、按脏标记重绘 |
| 3 | `testLoginReport` | **7265** | 118 B | 1760 B | 点击派发：`stage.mouseX/mouseY` 命中按钮矩形（无参签名 ⇒ 可安全当监听器） |
| 4 | `testHeartbeat` | **7267** | 100 B | 3212 B | URLLoader `COMPLETE`/`IO_ERROR` 回调：`JSON.parse` → C7 错误码 → 中文文案 → 分支 |
| 5 | `dispose` | **7287** | 1 B | 241 B | 拆页清理（框架钩子）+ 清 `root["sp6"]` |

**为什么是这 5 个既有方法（0 新增方法 / 0 新增字段 / 0 新增类）**：路线 B 只替换既有成员体，新增成员
必须走路线 A 整类重编译（会连带重编该类全部方法体、重排全局方法表），风险不值当。选桩依据：
`testConnect` 在本客户端恒 `false`（全树 4 处引用，无处置 true）⇒ `testLogin`/`testLoginReport`/
`testHeartbeat` 是事实死代码；`dispose` 是框架钩子。**不可挪用**：`isSDKLogining`/`isSDKLoginOk`/
`isServerloginResponsed`（TitleScene 的 START 分支要读）、`update(param1:Number)`（Number 形参当事件
监听器会被参数强制转换）。state 全部挂在 SWF 根 `Lib.current` 的动态属性 `sp6` 上。

## 3. 构建（路线 B：只换既有方法体）

```powershell
node D:\wfcnmod\wt\p6\client-patch\src\tools\p6-build.mjs            # 全链
node D:\wfcnmod\wt\p6\client-patch\src\tools\p6-build.mjs --list     # 只打印 bodyIndex，不编译
```

链路（每一步都实测过）：

1. `p6-escape.mjs`：载体源 → 纯 ASCII 源（44,445 B）。
2. **路线 A 当编译器**：`java -jar ffdec.jar -air -onerror abort -replace <base.swf> <stageA.swf> <FQCN> <ascii.as>`
   （FFDec 的 EXPERIMENTAL AS3 编译器；这一步只为拿 pcode，产物 **不发布**）。
3. `-format script:pcode -selectclass <FQCN> -export script <dir> <stageA.swf>` → 整类 pcode（744,066 字符）。
4. 按 `trait method QName(...,"<方法名>")` … `end ; method` 抽出 5 个靶方法块。
5. **路线 B**：逐个
   `java -jar ffdec.jar -air -onerror abort -replace <in.swf> <out.swf> <FQCN> <块.pcode> <bodyIndex>`
   链式回填 **原始 `base.swf`**（不传 format；块文件是 **pcode 汇编**，喂 `.as` 一律 `exit 1`
   `CharacterId does not exist`）。
6. **强制回读校验**（只信 exit code 会翻车，见 §5 坑 1）。加 `--dump-as3` 会再跑两次全量
   `-dumpAS3` 比对**类清单 sha 与基线一致**（慢，默认关）。

产物：`D:\wfcnmod\tmp\p6\out\sp-cn-p6-pcode.swf`（29,067,411 B；base 29,052,839 B，+14,572 B），
sha256 `156EDD0CAD4956FB18683FB6FF2E5ACA787E7A3BEA02C4C80645079479191F24`
（**两次独立构建 sha 相同 ⇒ 可复现**）。
报告：`D:\wfcnmod\tmp\p6\build\p6-build-report.json`。实测 **30/30 断言 PASS、`ALL PASS`、exit 0**
（含：DoABC tag 285→285、方法体 96,392→96,392、`other_bodies_changed=0`、类清单 sha
`13d36fd8929abcb0dfc50843cfdfcbce6143c83e15f7ded6f3837b40fc6db8c9` 前后一致）。

## 4. Plan A / Plan B

| | Plan A（整类重编译） | **Plan B（本交付，只换方法体）** |
| --- | --- | --- |
| 命令 | `-replace base out <FQCN> <改后的.as>` | `-replace base out <FQCN> <块.pcode> <bodyIndex>` |
| 输入 | **AS3 源**（整类） | **pcode 汇编块**（单方法） |
| FFDec 行为 | 用 EXPERIMENTAL 编译器重编译整个类，重排方法表 | 只替换 `<bodyIndex>` 指向的方法体 |
| 影响面 | 该类全部方法体被重编；全局方法表/方法体下标可能平移 | **其它 96,387 个方法体逐字节不变**，DoABC tag 数、方法体总数、类清单不变 |
| 本仓库实测 | `exit=0`（我的 44 KB 源能过 FFDec 编译器），但产物 = stageA.swf（29,067,984 B），**仅用于取 pcode** | 全链 20/20 断言 PASS |
| 采用 | 否（只作为「本机唯一可用的 AS3 语法/类型检查器」使用） | **是** |

Plan B 的代价：载体源必须**保持与原始类完全相同的成员集合**（25 个方法 + 6 个字段，已用脚本比对一致），
且非靶方法体写成占位实现——它们只在 stageA 里存在，不进最终 SWF。

## 5. 已踩过的坑（改这条链路前必读）

1. **块文件不存在时 `-replace` 照样 `exit 0`**，并把靶方法体写成**空体**，SWF 反而**变小**
   （29,052,839 → 29,052,829 B）。⇒ 必须回读校验，禁止只看 exit code。
   （注意「产物比 base 大」只是**启发式**：FFDec 重存时会重新压缩 DoABC tag，这里的体积变化里混着
   压缩噪声——决定性的三条是**回读靶方法体 pcode 逐行一致**、**其它方法体 sha 全不变**、
   **方法体总数不变**。）
2. 路线 B **只吃 pcode 汇编块**，不吃 `.as`：喂 AS3 报 `CharacterId does not exist`（exit 1）。
3. 块文件必须从 `trait method QName(...)` 行起、到同缩进 `end ; method` 止；**不能从
   `public function ...` 起**（FFDec 会报 `Invalid instruction name:public`）。
4. 源文件含中文 ⇒ 必须 `\uXXXX`（本目录的 `p6-escape.mjs`），否则 FFDec 按平台编码读成乱码
   （共享导出树里中文字面量被 GBK 重解码、**连收尾引号一起吃掉**，直接编译报
   `COMMA or PARENT_CLOSE expected but RETURN found`）。
5. PowerShell 调 java 必须**数组传参**：`& java @('-Xmx4g','-Djava.awt.headless=true','-jar',$jar,...)`，
   否则 `-Djava.awt.headless=true` 被拆成 `-Djava` + `.awt.headless=true` → `ClassNotFoundException`。
6. FFDec 每次都刷 3 条无关 WARNING（`Duplicate scriptpack path found (com.gibits.leitingaar.LeitingSDKExtension)` 等），过滤即可。
7. 新增类**不可行**：P0 实测同文件追加类后拿新类 FQN 当 scriptName ⇒
   `... is not recognized as a CharacterId or a script name.`（类数不变但 `-selectclass` 导出 0 文件）。
   新增方法本身可行（内容 ≤256 KB 不移位），但只能靠路线 A，故本交付不用。

## 6. 未验证项（**没有任何 Android 真机证据**）

- `[未验证-需真机]`：5 个方法体注入后在真机 AOT/JIT 下的实际行为（渲染、点击命中、轮询节奏、回调放行）。
- `[未验证-需真机]`：`localStore.get_device()` 返回值与 `DeviceLocalStore_Impl_.get(...)` 的取值时机
  （已静态确认调用形态与既有代码一致，见报告「证据」节）。
- `[未验证-需真机]`：接缝回调 `param1(deviceId)` 异步返回后，框架是否接受（`startLoginServer` 的
  调用方在收尾前不读其它身份字段——静态走查结论）。
- `[未验证-需真机]`：真机网络栈对 `URLRequest` 的默认超时（代码里自带 15 s 帧计时兜底）。
- 本机 `adb devices` 为空，**以上一律未做真机验证，报告里不得声称已验证**。

## 7. 约束遵守自查（[已验证]）

- 0 新增类 / 0 新增方法 / 0 新增字段：脚本比对方法名集合（25/25）与 `public var` 字段集合（6/6）完全一致。
- **不写第二个地址常量**：基址由 `remote.devConfig.getServerApiPath()` 去掉 `/api/index.php` 推导（C6）。
- 不引用任何 `cn.*` 类；只 `import flash.*` 与既有 `pinball.*` 类。
- 无 `git push` / `reset --hard` / `checkout` / `stash` / `clean`；只写 `client-patch/src/**`。
