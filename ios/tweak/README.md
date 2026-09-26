# SpLogin —— iOS 登录 UI tweak（P10-B）

越狱注入线：把「长得像游戏原生」的登录面板插进 iOS 客户端，用于**把服务端下发的注册验证码
显示给玩家**、并显示「已绑定 / 未绑定」状态。与 P10-A 的「往 IPA 里塞 dylib」是同一条主线的
两个分支：本目录这条线要求设备已越狱（Dopamine 等），好处是**官方 IPA 一字节不改**。

> 状态：**代码写完，但从未编译过，也从未在真机上跑过。** 本机（Windows）没有
> `make` / `clang` / `ldid`，也没有 WSL 发行版，编译只能在 macOS（CI 或你自己的 Mac）上做。
> 下面每一条需要真机/CI 才能确认的步骤都标了 `[未验证]`。

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `Makefile` | Theos 工程定义；`SP_LOGIN_HOST` 在构建期注入（默认值是 hygiene 白名单占位，不是真实机器） |
| `control` | deb 元数据（`Package: com.starpoint.splogin`，`Depends: mobilesubstrate`） |
| `SpLogin.plist` | MobileSubstrate 过滤器（`Bundles: com.leiting.wf`）+ 运行时开关，双用途 |
| `Tweak.xm` | 入口：注册 NSURLProtocol、hook 官方登录界面、打类清单日志 |
| `SpLoginConfig.h/.m` | 配置读取（编译期常量 > plist 覆写）+ 日志（NSLog + 落盘） |
| `SpLoginURLProtocol.h/.m` | 把 SDK 打向 `*.leiting.com` / `*.roguelike.com` / `*.cl2009.com` 的请求改写到自建服务 |
| `SpLoginAPI.h/.m` | `/sp-auth/*` 客户端（契约见分工文档 §3.2）+ 从出站请求体里嗅探 `device_id` |
| `SpLoginTheme.h/.m` | 官方样式 token 的 Objective-C 投影（与 P6 Android 页共用同一份 token） |
| `SpLoginViewController.h/.m` | 类游戏登录面板本体（状态机与 `ios/prototype/index.html` 一致） |
| `layout/DEBIAN/postinst`、`prerm` | 安装/卸载提示（纯 echo，不改系统文件） |

## 2. 构建 `[未验证]`

本机不能做这件事；CI 工作流在 `.github/workflows/ios-tweak.yml`（**从未跑过**，只做过 YAML 语法
检查，见报告 §7）。在你自己的 Mac 上：

```sh
brew install ldid
export THEOS=$HOME/theos
git clone --recursive --depth 1 https://github.com/theos/theos.git "$THEOS"

cd ios/tweak
make package FINALPACKAGE=1 SP_LOGIN_HOST=<你的服务器 IP>:8001                 # 传统越狱
make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless SP_LOGIN_HOST=<...>  # 无根越狱（Dopamine）
```

产物：`packages/com.starpoint.splogin_0.1.0_iphoneos-arm.deb`（rootless 方案下 Theos 会把安装
前缀自动改成 `/var/jb`）。`SpLogin.dylib` 在 `.theos/obj/` 下。

**不要**把 `192.168.x.x` 写进任何仓库文件：`scripts/check-hygiene.sh` 会拦（唯一白名单是
`192.168.1.10`，也就是本目录里的占位值）。真实地址只走命令行/CI 输入。

## 3. 它到底改了什么

1. **网络改写到自建服务**：`SpLoginURLProtocol` 拦 `https://<x>.leiting.com/<path>` 之类的请求，
   改写成 `http://<SP_LOGIN_HOST>/<path>`。scheme 用 http 是安全的——官方 `Info.plist` 里
   `NSAppTransportSecurity/NSAllowsArbitraryLoads = true`，明文 HTTP 不会被 ATS 拦。
   改写目标若返回 3xx，**拒绝跟随**（避免请求被导回真实官方域名）。
2. **UI 接管**：官方 SDK 的登录/欢迎界面一出现（`UIViewController -viewDidAppear:` 里按类名
   识别，另有 `LTLoginManager showWelcomeView:` 直钩），就弹我们自己的面板。
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

## 5. 真机安装与验证 SOP `[未验证-需真机]`

环境前提：iPhone 7 Plus / iOS 15.8.3 / Dopamine（**无根越狱**，所以一切都挂在 `/var/jb` 下）。

1. 用第 2 节的两条命令之一构建出 `.deb`（Dopamine 用 rootless 那条）。
2. 把 deb 传到手机并安装（Sileo/Zebra 直接装、Filza 点开、或 `dpkg -i`）。rootless 安装后文件在：
   - dylib：`/var/jb/Library/MobileSubstrate/DynamicLibraries/SpLogin.dylib`
   - 过滤器：`/var/jb/Library/MobileSubstrate/DynamicLibraries/SpLogin.plist`
3. **重启游戏**（不是 respring 也行——过滤器在进程启动时生效）。
4. 看日志：`/var/jb/var/mobile/Library/Logs/SpLogin.log`（没有就退回 `NSLog`，用 Console.app 看）。
   启动时应能看到：地址、rootless 判定、`UIViewController viewDidAppear:` 钩子结果、
   以及官方 SDK 类清单（哪些类真的存在、选择器在不在）。
5. 逐条核对：
   - [ ] 游戏里能出现我们的面板（不是官方 SDK 的登录界面）
   - [ ] 面板顶部出现 6 位数字，倒计时在走
   - [ ] 群内 bot 完成绑定后，面板变成「已绑定成功」
   - [ ] 游戏侧能正常进到「点击开始」
   - [ ] 服务端日志里该设备的 `UDID` 头**不再是** `10000001`（β 修复已验证的判据）
6. 卸载：`dpkg -r com.starpoint.splogin` 或在 Sileo 里移除，然后重启游戏。

**做不到的事**（不要承诺）：`/etc/hosts` 在 iOS 上不是可写方案（沙盒 + rootless 路径），
所以域名改写只能靠本目录的 `NSURLProtocol`，不能靠 hosts。

## 6. 已知风险

- `LTLoginManager` / `LeitingSDK` 这些类名来自官方主二进制字符串表，**真机上可能不存在或改名**。
  钩不到时 tweak 不会崩，会记一行日志并靠 `viewDidAppear` 的类名识别兜底；但兜底也认不出来时
  面板就不会自动出现（此时把 `SPLoginAutoPresent` 打开可以人工确认面板本身是好的）。
- 接管官方登录界面可能让官方 SDK 自己的状态机缺一步。若游戏在面板消失后卡住，把
  `SPLoginUITakeover` 设成 `false` 退回「只做网络改写」，然后回报。
- `NSURLProtocol` 只拦得到 `NSURLSession`/`NSURLConnection` 的请求；如果 SDK 某条链路走
  CFNetwork 裸 socket，那条请求不会被改写（真机上表现为某个接口连不上官方域名）。
