# iOS 安装形态与产物（P10-B）

这个目录是 iOS 侧的**产物落地说明**：`.deb`（越狱注入线）在这里产出/分发，安装方式与前提写在本文档。
真正的插件代码在 `ios/tweak/`，那份 README 讲怎么构建；本文讲**装到手机上**这件事。

> 本目录**不放二进制产物**。`.deb` 由 CI（`.github/workflows/ios-tweak.yml`）或你自己的 Mac 构建，
> 通过 GitHub Actions 的 artifact 取回，或推到你自建的软件源。仓库里不放 `.deb`：二进制产物不该
> 进 git，仓库的 hygiene 检查也会拦下超过 1 MB 的非 json/csv/md 文件。

## 1. 前提：必须越狱

本线（dylib/tweak 注入）**要求设备已越狱**，因为要把动态库挂进游戏进程。当前目标设备：

| 项 | 值 |
| --- | --- |
| 设备 | iPhone 7 Plus |
| 系统 | iOS 15.8.3 |
| 越狱 | Dopamine（**无根越狱 / rootless**） |

**无根 vs 有根**决定安装路径前缀，两者不能混：

| 越狱形态 | 动态库目录 | 说明 |
| --- | --- | --- |
| 无根（Dopamine、palera1n rootless） | `/var/jb/Library/MobileSubstrate/DynamicLibraries/` | 本设备属于这一类 |
| 有根（unc0ver、checkra1n 等） | `/Library/MobileSubstrate/DynamicLibraries/` | 构建时**不要**加 `THEOS_PACKAGE_SCHEME=rootless` |

构建时的对应关系：无根必须在 `make package` 时带上 `THEOS_PACKAGE_SCHEME=rootless`，Theos 会自动把
安装前缀改写到 `/var/jb`；架构是 `iphoneos-arm`（不是 `iphoneos-arm64`，因为包装的是 dylib 不是命令行工具）。

Dopamine 用 ElleKit 提供 MobileSubstrate 兼容层，所以 `control` 里依赖写的是 `mobilesubstrate`；
如果设备上装的是别的注入器，那一项可能要换成对应的包名。

**当前状态：本文档里的安装步骤从未在真机上执行过，全部标 `[未验证-需真机]`。**

## 2. 三种安装方式

1. **Sileo / Zebra 直接装** `[未验证-需真机]`
   把 `.deb` 传到手机（AirDrop、Filza 的文件共享、或 SSH/`scp`），在 Sileo 里打开它 → 安装。
   最省事，也是推荐方式。
2. **Filza 点开** `[未验证-需真机]`
   用 Filza 找到 `.deb`，点它 → 安装。装完**重启游戏**（过滤器在进程启动时读，不必 respring 整机）。
3. **命令行 `dpkg`** `[未验证-需真机]`
   ```sh
   scp com.starpoint.splogin_0.1.0_iphoneos-arm.deb root@<设备IP>:/var/mobile/
   ssh root@<设备IP>
   dpkg -i /var/mobile/com.starpoint.splogin_0.1.0_iphoneos-arm.deb
   ```
   默认 root 密码在越狱后应立刻改掉；设备 IP 不要写进任何仓库文件。

如果你打算让朋友也装，把它推到你自建的软件源上（Sileo 源），别人加源即可，不用手动传包。

## 3. 装上之后验证什么 `[未验证-需真机]`

装完重启游戏，逐条核对（详细 SOP 与日志路径见 `ios/tweak/README.md` 第 5 节）：

- [ ] 游戏启动不崩（这一步先确认，别的再说）
- [ ] 日志出现：`/var/jb/var/mobile/Library/Logs/SpLogin.log`
- [ ] 日志里有官方 SDK 的**类清单**（哪些类真的存在）——这是判断 hook 成没成的唯一依据
- [ ] 游戏里出现我们的登录面板，而不是官方 SDK 的欢迎页
- [ ] 面板顶部出现 6 位验证码与倒计时
- [ ] 完成绑定后面板显示「已绑定成功」，且服务端日志里该设备的 `UDID` 头**不再是** `10000001`

卸载：Sileo 里移除 `SpLogin`，或 `dpkg -r com.starpoint.splogin`，然后重启游戏。

## 4. 不越狱的设备怎么办

越狱这条线走不通时，只能走另一条线：**把 dylib 直接塞进 IPA 再整体重签**（P10-A 的 B4+ 方案，
`client-patch/build/patch-ipa.mjs`）。注意：

- 侧载（AltStore/Sideloadly 等）的签名**7 天过期**，到期要重新装一次；越狱设备没有这个限制。
- 重签会破坏原始签名，`Info.plist` 与嵌套 dylib 都必须一起重签，否则装不上。
- 这条线**不需要**越狱，但需要一台能跑重签工具的机器（可以用 Mac，也可以在 Windows 上做，
  取决于重签方案）。

两条线的**服务端依赖完全一样**（同一套 `/sp-auth/*`、同一个公告端点、同一份样式 token），
所以先按哪条线验收都不影响另一条。
