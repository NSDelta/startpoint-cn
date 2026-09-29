# SpLogin —— iOS 登录 UI tweak（P10-B）

越狱注入线：把「长得像游戏原生」的登录面板插进 iOS 客户端，用于**把服务端下发的注册验证码
显示给玩家**、并显示「已绑定 / 未绑定」状态。与 P10-A 的「往 IPA 里塞 dylib」是同一条主线的
两个分支：本目录这条线要求设备已越狱（Dopamine 等），好处是**官方 IPA 一字节不改**。

> 状态：**编译与打包已由 CI 验证（见第 2 节）；注入、显示、钩子命中与否都还没在真机上验证过。**
> 本机（Windows）没有 `make` / `clang` / `ldid`，也没有 WSL 发行版，编译只能在 macOS（CI 或你
> 自己的 Mac）上做。下面每一条需要真机才能确认的步骤都标了 `[未验证-需真机]`。
>
> **2026-09-29 改动（真机反馈驱动）**：服主在 iPhone 7 Plus / iOS 15.8.3 / Dopamine 上装好后
> 「**没有 dylib 的窗口**」——面板根本没出现。根因是旧实现把面板 `presentViewController:` 弹进
> 游戏自己的视图层级，显示与否取决于「官方 UI 钩子命中」+「那一刻 keyWindow 上有能 present 的
> VC」。现已把显示路径整体换成**独立覆盖窗口 + 常驻悬浮球**（`SpLoginOverlay`，见第 5 节），
> **显示不再依赖任何官方 UI 钩子**；官方界面钩子退化为「自动打开」的加分项。

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `Makefile` | Theos 工程定义；`SP_LOGIN_HOST` 在构建期注入（默认值是 hygiene 白名单占位，不是真实机器） |
| `control` | deb 元数据（`Package: com.starpoint.splogin`，`Depends: mobilesubstrate`） |
| `layout/Library/MobileSubstrate/DynamicLibraries/SpLogin.plist` | MobileSubstrate 过滤器（`Bundles: com.leiting.wf`）+ 运行时开关，双用途。**必须在 `layout/` 下**：见第 6 节 |
| `Tweak.xm` | 入口：注册 NSURLProtocol、安装独立覆盖窗口、hook 官方登录界面、打类清单日志 |
| `SpLoginOverlay.h/.m` | **独立覆盖窗口**（悬浮球 + 面板容器）：自建 `UIWindow`、空白穿透、保活看门狗、键盘借还。见第 5 节 |
| `SpLoginConfig.h/.m` | 配置读取（编译期常量 > plist 覆写）+ 日志（NSLog + 落盘） |
| `SpLoginURLProtocol.h/.m` | 把 SDK 打向 `*.leiting.com` / `*.roguelike.com` / `*.cl2009.com` 的请求改写到自建服务 |
| `SpLoginAPI.h/.m` | `/sp-auth/*` 客户端（契约见分工文档 §3.2）+ 从出站请求体里嗅探 `device_id` |
| `SpLoginTheme.h/.m` | 官方样式 token 的 Objective-C 投影（与 P6 Android 页共用同一份 token） |
| `SpLoginViewController.h/.m` | 类游戏登录面板本体（状态机与 `ios/prototype/index.html` 一致）；由覆盖窗口当子 VC 承载，不再自己弹自己。**续轮询入口** `sp_resumeFromStoredTokenIfNeeded` 见第 5 节 |
| `layout/DEBIAN/postinst`、`prerm` | 安装/卸载提示（纯 echo，不改系统文件） |

## 2. 构建 `[部分已验证-CI]`

本机不能做这件事；CI 工作流在 `.github/workflows/ios-tweak.yml`。真实运行记录（fork
`NSDelta/startpoint-cn`，均 `event=push`）：

| run | `head_sha` | 结果 |
| --- | --- | --- |
| `36417028903` | `ce51e155` | `make` **失败**（exit code 2；当时 job 日志无法匿名取回，只知道第一步断在 `make`） |
| `36420791202` | `637b1839` | 编译**全过**，链接期 `ld: symbol(s) not found` / `NOTE: found '_SPLoginLog' … missing 'extern "C"'` |
| `36421222764` | `0c33c9a4` | 链接已修好，编译期 `SpLoginConfig.h:45` `-Werror,-Wnullability-completeness` |
| `36421542559` | `38766025` | **全部成功**：`make` + `make package` 两条腿（rootful / rootless）均绿 |

所以「工作流本身跑得起来、依赖装得上、源码能编译、deb 能打出来」现在都已被 CI 证实。
在你自己的 Mac 上：

```sh
brew install ldid
export THEOS=$HOME/theos
git clone --recursive --depth 1 https://github.com/theos/theos.git "$THEOS"

cd ios/tweak
make package FINALPACKAGE=1 SP_LOGIN_HOST=<你的服务器 IP>:8001                 # 传统越狱
make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless SP_LOGIN_HOST=<...>  # 无根越狱（Dopamine）
```

产物（两条腿的 arch 名不同，CI run `36421542559` 实测）：

| 方案 | `.deb` | `dm.pl` 报的包标识 |
| --- | --- | --- |
| 传统越狱 | `packages/com.starpoint.splogin_0.1.0_iphoneos-arm.deb` | `com.starpoint.splogin:iphoneos-arm` |
| `THEOS_PACKAGE_SCHEME=rootless` | `packages/com.starpoint.splogin_0.1.0_iphoneos-arm64.deb` | `com.starpoint.splogin:iphoneos-arm64` |

注意 rootless 那条**不是** `iphoneos-arm`：Theos 的 rootless 方案会把 arch 换成 `iphoneos-arm64`
（安装前缀同时自动改成 `/var/jb`）。`SpLogin.dylib` 在 `.theos/obj/` 下，实测 124560 字节。
链接期会有一条无害的 `ld: warning: -multiply_defined is obsolete`（Theos 的默认 LDFLAGS 带来）。

**不要**把 `192.168.x.x` 写进任何仓库文件：`scripts/check-hygiene.sh` 会拦（唯一白名单是
`192.168.1.10`，也就是本目录里的占位值）。真实地址只走命令行/CI 输入。

## 3. 它到底改了什么

1. **网络改写到自建服务**：`SpLoginURLProtocol` 拦 `https://<x>.leiting.com/<path>` 之类的请求，
   改写成 `http://<SP_LOGIN_HOST>/<path>`。scheme 用 http 是安全的——官方 `Info.plist` 里
   `NSAppTransportSecurity/NSAllowsArbitraryLoads = true`，明文 HTTP 不会被 ATS 拦。
   改写目标若返回 3xx，**拒绝跟随**（避免请求被导回真实官方域名）。
2. **UI 接管（现在是「自动打开」，不再是唯一的显示路径）**：面板本体挂在一个**独立覆盖窗口**
   上（`SpLoginOverlay`，见第 5 节），随 tweak 初始化就装好，屏幕上因此有一个可拖动的悬浮球；
   官方 SDK 的登录/欢迎界面一出现（`UIViewController -viewDidAppear:` 里按类名
   识别，另有 `LTLoginManager showWelcomeView:` 直钩），就**自动打开**这个面板。
3. **验证码展示**：面板调用 `/sp-auth/register`（或 `/sp-auth/login`）拿到 6 位码与到期时间，
   显示在面板顶部并倒计时，随后每秒/每 3 秒轮询 `/sp-auth/bind-status`，绑定成功即提示
   「回游戏点『点击开始』」。**同一段话术也会由服务端的公告端点下发**（见报告「iOS 公告通道」
   一节），两条路互为兜底：面板是主动展示，公告是被动展示（后者不需要越狱）。
4. **`device_id` 对齐**：绑定闸门查的是游戏自己请求体里的 `device_id`，所以本页登记的必须是
   同一个值。做法是嗅探优先——每次出站请求体都顺带扫一遍 `device_id`（JSON 与 msgpack 两种
   编码都认），抓到就落盘复用；抓不到才退到本机自生成的 UUID。**这一点必须真机确认**
   （`[未验证-需真机]`），不一致会导致绑定挂在另一个设备键上。

## 4. 开关（`SpLogin.plist`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `SPLoginHostOverrideEnabled` | `false` | 地址以编译期常量为准；置 `true` 才让 `SPLoginHost` 生效 |
| `SPLoginHost` | 占位值 | 覆写目标（临时换机联调用，不必重编） |
| `SPLoginUITakeover` | `true` | 接管官方登录界面；置 `false` 等于只做网络改写 |
| `SPLoginLogToFile` | `true` | 日志同时落盘；写不进去自动退回 `NSLog` |
| `SPLoginSkipPrivacyDialogs` | `false` | 跳过官方隐私/协议弹窗。**属于官方合规流程，未经服主确认不擅自打开** |
| `SPLoginAutoPresent` | `false` | 启动后主动弹面板（只用于真机单点验证面板本身） |
| `SPLoginAutoPresentDelay` | `2.0` | 上面那个的延迟秒数 |
| `SPLoginFloatingButton` | `true` | 显示常驻悬浮球（52×52、可拖动，点击开/关面板）。**默认值就是修复后的行为**；置 `false` 只收起这个手动入口，面板本身与「官方界面出现时自动打开」都不受影响 |

## 5. 悬浮窗（独立覆盖窗口）机制

真机反馈（2026-09-29）：装好 deb 后**面板根本没出现**。根因是旧实现把面板
`presentViewController:` 弹进**游戏自己的视图层级**（`keyWindow.rootViewController` 沿 presented
链的最深一个，`UIModalPresentationOverFullScreen`），于是「能显示」要同时满足两件事：①三个触发点
（`viewDidAppear:` 类名识别 / `LTLoginManager showWelcomeView:` / `SPLoginAutoPresent`，最后一项
默认还是 `false`）至少命中一个；②那一刻 keyWindow 上已经有能 present 的 VC。任一不满足就永远不
显示；就算显示了，AIR 重建视图层级时也会把它带走或盖住。

现在改成**独立覆盖窗口**方案（`SpLoginOverlay.h/.m`）。⚠️ **参考边界（服主原话：「我说的是技术参考，不代表 ui 参考」）**：
下面这套（窗口层级、保活三路、空白穿透、借还 keyWindow）只是从社区已在真机跑通的实现
（`wfcore/dylib/src/ui.m`）移植的**机制**，**视觉与交互设计一律用我们自己的**——面板沿用本插件既有
的 `SpLoginViewController` + `SpLoginTheme`（游戏化风格，规划见分工文档 P10-B/B2），不照搬参考实现的样式：

- **独立 `UIWindow`**：`windowLevel = UIWindowLevelStatusBar + 100`，`backgroundColor = clearColor`，
  `rootViewController` 的 view 是穿透视图 `SpLoginPassView`（iOS 13+ 用 `initWithWindowScene:`
  建窗，否则退回 `initWithFrame:[UIScreen mainScreen].bounds`）。它不参与游戏的视图层级，游戏
  怎么重建自己的窗口都影响不到它。
- **显示手段只有 `hidden = NO`，绝不 `makeKeyAndVisible`**：本游戏是 AIR 引擎，对 keyWindow 变化
  敏感（键盘/焦点/渲染循环）。`hidden = NO` 已经足够让窗口显示并接收触摸，抢 key 只会引入风险。
- **空白穿透**：`SpLoginPassView -hitTest:withEvent:` 命中自身（= 透明背景）时返回 `nil`，事件
  直接落到下层窗口的游戏；只有悬浮球和面板本体可交互。面板关掉时面板 view `hidden = YES`
  （hidden 的 view 不参与 hitTest），所以**穿透 + hidden 两件事都做了**——关掉的面板既看不见
  也摸不到。
- **保活（全幂等）**：`install` 之后 1.5 s 首挂（`reason=timer1.5s`）+ 观察
  `UIWindowDidBecomeKeyNotification`（`reason=keyWindowChanged`）+ 5 s 一次的看门狗
  （`reason=watchdog5s`），三条路都调同一个幂等挂载例程；宿主 scene 变了就把 overlay 的
  `windowScene` 迁过去；overlay 被谁藏了就恢复 `hidden = NO`；宿主窗口**当下找不到也不放弃**——
  面板请求先挂起（`pending`），挂上后自动补开。
- **宿主窗口怎么选**：先扫 `connectedScenes` 里 `UIWindowScene.windows` 中 `isKeyWindow` 且不是
  overlay 自己的那个（`hostBy=key`）；找不到再兜底「可见 + `windowLevel == UIWindowLevelNormal`
  + bounds 非空」的窗口（`hostBy=visible(normal)`）；都没有就写一行 `FAIL: 找不到可用宿主窗口`
  等下一次看门狗。**这个兜底就是「官方 UI 钩子全 miss 也要显示」的实现方式。**
- **键盘策略（唯一抢 key 的地方）**：键盘只认 keyWindow，所以点面板里的输入框开始编辑时临时
  `[overlayWindow makeKeyWindow]`，编辑结束立刻把 key 还给**挂载时记录下来的宿主窗口**
  （`hostWindow`，weak；不能现查——那一刻 overlay 自己就是 key，现查只会查到自己）。看门狗另有
  一道兜底：overlay 是 key 但面板里已经没有 firstResponder 时主动归还，防止某次通知丢失后游戏
  一直拿不到 key。
- **面板本体复用**：`SpLoginViewController` 的 view 作为覆盖窗口根视图的子视图
  （`addChildViewController:` 正式容器化），**不再走 `presentViewController:`**；业务逻辑
  （验证码申请、`/sp-auth/bind-status` 轮询、`SpLoginAPI`、`SpLoginTheme`）一行没改。打开面板时
  会把悬浮球 `bringSubviewToFront:`（否则全屏遮罩会盖住球，关不掉）；点面板外的遮罩空白也会关。
- **续轮询：`sp_resumeFromStoredTokenIfNeeded`（为什么不做 appearance 过渡）**：
  `viewDidAppear:` 里原本有一段「本地已有令牌 ⇒ `refreshBindStatus` 接着轮询」，但
  `addChildViewController:` + 直接 `hidden = NO` **不产生 appearance 过渡**，子 VC 根本收不到
  `viewDidAppear:`，所以覆盖窗口这条路径冷启动时不会自己续上（得用户手点一次主按钮）。
  修法是给 `SpLoginViewController` 加一个公开方法 `- (void)sp_resumeFromStoredTokenIfNeeded`，
  由 `SpLoginOverlay -sp_ensurePanelControllerInRoot:` 在面板挂进容器后**显式调一次**：
  - **本地没有令牌**（`SpLoginAPI.sharedAPI.token.length == 0`）⇒ 立刻返回：不发任何请求、不弹面板；
  - **已经有轮询在跑**（`pollTimer` 非空且 `isValid`）⇒ 跳过：重复调用（1.5 s 首挂 /
    `keyWindowChanged` / 5 s 看门狗 / `showPanel` / `pendingShow` 补开都汇到这一个挂载点）不会叠加定时器；
  - 有令牌且没在跑 ⇒ 走 `startPolling`（首拍在 `SpLoginPollInterval` = 3 s 后），持续等到
    `bound=true` 为止，而不是只查一次；
  - 写一行可 grep 的日志（见第 5.1 节），真机上能直接看出「续了没、为什么没续」。

  **为什么不干脆手动做一次 appearance 过渡**（`beginAppearanceTransition:YES` +
  `endAppearanceTransition`）：那会连带把 `viewDidDisappear:` 也走一遍，而
  `SpLoginViewController.m` 的 `viewDidDisappear:` 第一件事就是 `stopTimers` —— 与覆盖窗口版
  刻意的取舍（**面板隐藏期间轮询/倒计时继续跑**，再点悬浮球原样恢复）直接冲突。所以走「业务侧
  显式入口」而不是「借 UIKit 生命周期」，前提条件（有令牌 / 已轮询）也由本方法自己判定。
- **常驻悬浮球**：52×52 圆角按钮（标题「登」），可拖动（限制在屏内），点击开/关面板。它是
  **不依赖任何官方 UI 钩子**的手动入口——这正是本次修复的验收点。plist `SPLoginFloatingButton`
  置 `false` 只收起这个球。

### 5.1 怎么用日志判断「窗口到底建没建、挂没挂上」

每次挂载尝试都写一行：尝试序号、触发原因、扫到的窗口列表、选中的宿主 + 依据、overlay 自身状态、
失败原因。原文格式（源在 `SpLoginOverlay.m`）：

- 成功：`overlay attach#<n> (reason=<谁触发>) ok host=<宿主类名> hostBy=<key|visible(normal)>
  overlay=已创建(lvl=..,hid=..,scene=..,root=y|n,ball=y|n,panel=未创建|hidden|shown) windows=[...]`
- 失败：`overlay attach#<n> (reason=..) FAIL: 找不到可用宿主窗口 windows=[...] overlay=...`
- 另两类失败：`FAIL: 覆盖窗口创建失败 …` / `FAIL: 覆盖窗口 root view 不存在 …`
- 建窗那行：`overlay window 创建 lvl=1100 scene=有|无(退回 UIScreen bounds) frame=(x,y,WxH) hidden=NO`
- 悬浮球：`悬浮球创建（52x52，可拖动，点击开/关面板）` / `悬浮球挂到覆盖窗口 root=(WxH)`
- 面板：`overlay panel shown (reason=..) …` / `overlay panel hidden（触摸已交还游戏）…`
- 键盘：`overlay key<-overlay（文本输入需要键盘）` / `overlay key->host（…，key 归还游戏窗口 …）`
- 续轮询（`sp_resumeFromStoredTokenIfNeeded`，三条互斥，正好覆盖「续了没 / 为什么不续」）：
  - `resume: 本地已有令牌 ⇒ 续轮询 bind-status（每 3.0s 一次，最多 100 次；token 长度=64，面板挂载完成即触发）`
  - `resume: 本地无令牌，不续轮询（等用户在面板里创建/登录）` ← 冷启动的默认路径（此时**不该**有
    `/sp-auth/bind-status` 请求）
  - `resume: 轮询已在跑，跳过（幂等，token 长度=64）` ← 看门狗/重挂的重复调用
- 窗口列表每一项形如 `#0 UIWindow(lvl=0,key=1,hid=0,scene=1,414x896)`，overlay 自己带
  `,OVERLAY` 后缀；最多列 8 个，超出显示 `…(共N个)`。

在手机上直接跑（rootless 路径）：

```sh
L=/var/jb/var/mobile/Library/Logs/SpLogin.log

grep -E 'overlay (install|window 创建|attach#)' "$L"   # 建没建、挂没挂、失败原因
grep -E '悬浮球' "$L"                                   # 球建了没、挂上没
grep -E 'overlay panel (shown|hidden)' "$L"             # 面板开合
grep -E 'overlay key' "$L"                              # 键盘借还
grep -E 'resume:' "$L"                                  # 续轮询：续了没 / 为什么没续（第 5 节）
grep -E 'windows=\[' "$L"                               # 那一刻扫到的窗口清单
```

判读表：

| 日志现象 | 结论 |
| --- | --- |
| 完全没有 `overlay install` | tweak 没加载：查 `SpLogin.plist` 的 `Filter.Bundles` 是否等于游戏 bundle id、dylib 是否在 `/var/jb/Library/MobileSubstrate/DynamicLibraries/`、装完是否重启过游戏 |
| 有 `install`，但没有 `overlay attach#` | 1.5 s 首挂没跑到（进程在那之前就退了？）或日志写了一半 |
| `FAIL: 找不到可用宿主窗口` | 那一刻游戏还没建出自己的窗口（或窗口全被隐藏）。看门狗每 5 s 重试，正常应随后出现一行 `ok` |
| `ok … ball=y` 但屏幕上没球 | 窗口建好且挂上了，但显示层级/穿透在真机上仍可能不生效——把整段日志（含 `windows=[...]`）发回来，这是下一步定位的唯一线索 |
| `ok … panel=shown` | 面板已经被打开过（`pending` 补开或钩子触发），挂载链路是通的 |
| `resume: 本地无令牌，不续轮询` | 正常：本机还没登记过（NSUserDefaults 里没有 token）。此时**不该**看到 `/sp-auth/bind-status` 请求 |
| `resume: 本地已有令牌 ⇒ 续轮询 …` | 续轮询生效（本次修复的验收点）：面板挂上后每 3 s 打一次绑定状态，用户没点过任何按钮 |
| `resume: 轮询已在跑，跳过（幂等 …）` | 正常：5 s 看门狗/重挂的重复调用被幂等闸门挡住，没有叠加定时器 |
| 面板挂着但一直没出现任何 `resume:` | 挂载路径没走到 `sp_ensurePanelControllerInRoot:`（先看有没有 `attach#… ok`），或这版 dylib 没换上去 |

**真机排查步骤**：①`grep 'overlay install'` 确认 tweak 真的加载了 → ②`grep 'attach#'` 看挂载
结果与 `hostBy` → ③看 `windows=[...]` 里有没有游戏的普通层窗口、以及有没有带 `,OVERLAY` 的窗口
→ ④有 `ok` 但没球：确认没把 `SPLoginFloatingButton` 设成 `false`（日志会明说
`悬浮球按 plist(SPLoginFloatingButton=false) 撤下`）→ ⑤仍不行就把整段日志发回来。

## 6. 真机安装与验证 SOP `[未验证-需真机]`

环境前提：iPhone 7 Plus / iOS 15.8.3 / Dopamine（**无根越狱**，所以一切都挂在 `/var/jb` 下）。

1. 用第 2 节的两条命令之一构建出 `.deb`（Dopamine 用 rootless 那条）。
2. 把 deb 传到手机并安装（Sileo/Zebra 直接装、Filza 点开、或 `dpkg -i`）。rootless 安装后文件在：
   - dylib：`/var/jb/Library/MobileSubstrate/DynamicLibraries/SpLogin.dylib`
   - 过滤器：`/var/jb/Library/MobileSubstrate/DynamicLibraries/SpLogin.plist`
3. **重启游戏**（不是 respring 也行——过滤器在进程启动时生效）。
4. 看日志：`/var/jb/var/mobile/Library/Logs/SpLogin.log`（没有就退回 `NSLog`，用 Console.app 看）。
   启动时应能看到：地址、rootless 判定、`overlay install`、`overlay attach#…` 挂载结果、
   `悬浮球创建/挂到覆盖窗口 root`、`resume:` 续轮询判定（第 5 节）、`UIViewController viewDidAppear:`
   钩子结果、以及官方 SDK 类清单（哪些类真的存在、选择器在不在）。逐行判读方法见第 5.1 节。
5. 逐条核对：
   - [ ] **屏幕上出现「登」悬浮球**（可拖动）——这一条**不依赖任何官方 UI 钩子**，是本次修复的
         核心验收点：它出现了就说明覆盖窗口建起来了、也挂上了
   - [ ] **冷启动续轮询**（本次修复的第二个验收点）：先在面板里完成一次创建/登录让本地留下令牌，
         然后**杀掉游戏重开**，不点任何按钮——日志里应出现
         `resume: 本地已有令牌 ⇒ 续轮询 bind-status …`，且随后每 3 s 一次
         `/sp-auth/bind-status`（`[未验证-需真机]`：覆盖窗口不产生 appearance 过渡，所以这条
         只能靠真机日志确认，见第 5 节）
   - [ ] 点悬浮球能打开面板；点面板外空白或再点悬浮球能关掉面板，关掉后游戏触摸完全正常
   - [ ] 面板顶部出现 6 位数字，倒计时在走
   - [ ] 群内 bot 完成绑定后，面板变成「已绑定成功」
   - [ ] 游戏侧能正常进到「点击开始」
   - [ ] 服务端日志里该设备的 `UDID` 头**不再是** `10000001`（β 修复已验证的判据）
6. 卸载：`dpkg -r com.starpoint.splogin` 或在 Sileo 里移除，然后重启游戏。

**做不到的事**（不要承诺）：`/etc/hosts` 在 iOS 上不是可写方案（沙盒 + rootless 路径），
所以域名改写只能靠本目录的 `NSURLProtocol`，不能靠 hosts。

## 7. 已知风险

- `LTLoginManager` / `LeitingSDK` 这些类名来自官方主二进制字符串表，**真机上可能不存在或改名**。
  钩不到时 tweak 不会崩，会记一行日志并靠 `viewDidAppear` 的类名识别兜底。**注意：这只影响
  「官方界面出现时自动打开」这个加分项**——面板的显示能力由独立覆盖窗口提供（第 5 节），
  官方类名全 miss 时悬浮球照样在，点它就能开面板。
- 独立覆盖窗口这套机制（`windowLevel = StatusBar + 100`、只用 `hidden = NO`、空白穿透、借还
  keyWindow）是从社区里已在真机跑通的实现（`wfcore/dylib/src/ui.m`）移植的，但**移植到本插件上
  同样没有真机验证**。可能出问题的地方：AIR 引擎对该层级窗口有特殊处理、Dopamine 下 scene 行为
  不同、或系统安全策略不允许非 key 窗口接收触摸。出问题时日志里的 `overlay attach#…` 行会告诉我
  们走到了哪一步（见第 5.1 节）。
- 接管官方登录界面可能让官方 SDK 自己的状态机缺一步。若游戏在面板消失后卡住，把
  `SPLoginUITakeover` 设成 `false` 退回「只做网络改写」，然后回报。
- `NSURLProtocol` 只拦得到 `NSURLSession`/`NSURLConnection` 的请求；如果 SDK 某条链路走
  CFNetwork 裸 socket，那条请求不会被改写（真机上表现为某个接口连不上官方域名）。
