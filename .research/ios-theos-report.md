# Theos / rootless / GitHub Actions 事实核实报告

**核实日期口径**：全部来源为 2026 年抓取（GitHub runner 镜像清单标注 2026 年状态；Theos 为 master 滚动版）。
**核实方式**：内置 `web_search` / `web_fetch` 在本机不可用（前者 DeepSeek API 402 Insufficient Balance，后者因本机 TUN fake-ip DNS 报 `resolves to a non-public IP address`），全部改用 `Invoke-WebRequest` 直连已知 URL + 本地解包 Theos 源码逐行核对。
**标签含义**：
- `[源码实测]` = 直接读 Theos/仓库源码得到的确定行为（附文件:行号）
- `[文档明确]` = 官方文档/官方手册原文
- `[实测]` = 本次实际抓取到的原文内容（第三方仓库、镜像清单等）
- `[推测]` = 我的推断，未找到一手来源
- `[未核实]` = 明确没找到可靠证据

---

## 0. 结论速览（先看这 12 条）

| # | 结论 | 置信度 |
|---|---|---|
| 1 | iPhone 7 Plus（A10）= **arm64**，不是 arm64e；iOS 15.8.3 在 **Dopamine 2.x 的 arm64 支持区间内**（`iOS 15.0 - 15.8.6 / 16.0 - 16.6.1 (arm64)`） | `[实测]` Dopamine `2.x` 分支 README |
| 2 | rootless 构建**不需要**另一份 Makefile：用 `THEOS_PACKAGE_SCHEME=rootless`，Theos 自动加 `/var/jb` 前缀并把 `Architecture` 强制改成 `iphoneos-arm64` | `[源码实测]` |
| 3 | rootless 下 deb 内的最终路径 = **`./var/jb/Library/MobileSubstrate/DynamicLibraries/X.dylib`**（`DEBIAN/` 本身不加前缀） | `[源码实测]` |
| 4 | 依赖写 **`Depends: mobilesubstrate`** 即可，ElleKit 声明了 `Provides: mobilesubstrate (= 99)` | `[实测]` ellekit `packaging/control` |
| 5 | 过滤器 plist 放**和 dylib 同一目录**（rootless 即 `/var/jb/Library/MobileSubstrate/DynamicLibraries/X.plist`），内容用 `Filter = { Bundles = (...); }` | `[文档明确]`+`[实测]` |
| 6 | Theos **不生成** postinst/prerm，也不会把 `INSTALL_TARGET_PROCESSES` 写进 deb；要刷新 SpringBoard 走 `$CYDIA` 的 `finish:` 协议 | `[源码实测]`+`[文档明确]` |
| 7 | SDK 版本必须写死（如 `iphone:clang:16.5:15.0`）；写 `latest` 会解析到 **Xcode 的 iOS 26.x**，而且 `macos-latest` 镜像里**没有任何 ≤16.5 的 iOS SDK** | `[源码实测]`+`[实测]` |
| 8 | `macos-latest` 现在是 **macOS 26 arm64**；镜像**没有** dpkg/fakeroot/ldid/xz | `[实测]` runner-images |
| 9 | 打包**不需要 fakeroot**（Theos 自带 `bin/fakeroot.sh`，且在 macOS 上找不到 fakeroot 时会退化为直接执行），但**需要 `lzma` 可执行文件**（默认 `-Zlzma`）→ `brew install xz` | `[源码实测]` |
| 10 | 签名应装 **`brew install ldid-procursus`**（2.1.5-procursus7），**不是** `brew install ldid`（那是 saurik v2.1.5，两者 conflicts） | `[实测]` Homebrew formula |
| 11 | `ldid -S<file.xml>` 才是嵌 entitlements（`-M` 是「与已有 entitlements 合并」开关，须与 `-S` 连用）；`codesign --deep` 自 macOS 13 弃用且**对 iOS .app 只签主二进制** | `[文档明确]` 官方 manpage |
| 12 | iPhone 7 Plus：`bounds` = 414×736pt、`scale` = 3.0、`nativeBounds` = **1080×1920**、`nativeScale` = **2.608**；「1242×2208」是**渲染缓冲区**（bounds×scale），**不是** `nativeBounds` | `[文档明确]` Apple 归档 Display 文档 |

---

# 1. Theos 工程配置

## 1.1 Makefile 完整模板（一份出 rootful + rootless）

`[文档明确]` 官方给的 rootful/rootless 条件模板（[theos.dev/docs/rootless](https://theos.dev/docs/rootless)）：

```make
ifeq ($(THEOS_PACKAGE_SCHEME),rootless)
ARCHS = arm64 arm64e
TARGET = iphone:clang:latest:15.0
else
ARCHS = armv7 armv7s arm64 arm64e
TARGET = iphone:clang:latest:7.0
endif
```

`[文档明确]` 原文注意事项：rootless scheme 只支持 iOS 15+；**切换 rootful/rootless 必须 `make clean`**；不需要为两种 scheme 用不同的 package identifier（Sileo/Zebra 只显示兼容架构，Cydia 会显示重复条目但两个都指向 rootful 版）；rootless 下所有文件都必须在 `/var/jb` 下，否则非越狱态可能被越狱检测命中。

**本项目可直接照抄的版本**（针对 iPhone 7 Plus / iOS 15.8.3 + 侧载双线）：

```make
# ===================== AutoMatcher/Makefile =====================
ifeq ($(THEOS_PACKAGE_SCHEME),rootless)
    # Dopamine 2.x：arm64(15.0-15.8.6/16.0-16.6.1) + arm64e(A12+)
    ARCHS  = arm64 arm64e
    TARGET = iphone:clang:16.5:15.0
else
    # palera1n 等有根越狱；只为 iPhone 7 Plus 出 arm64 也可
    ARCHS  = arm64
    TARGET = iphone:clang:16.5:15.0
endif

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = AutoMatcher

AutoMatcher_FILES = Tweak.xm \
                    UI/PanelViewController.m \
                    Core/Matcher.cpp \
                    Core/ImageCodec.mm \
                    Vendor/miniz.c

# 只对 ObjC / ObjC++ 生效，避免给纯 C/C++ 传 -fobjc-arc
AutoMatcher_OBJCFLAGS  = -fobjc-arc
AutoMatcher_OBJCCFLAGS = -fobjc-arc -std=c++17
AutoMatcher_CFLAGS     = -O3 -ffast-math -Wno-deprecated-declarations \
                         -I$(THEOS_PROJECT_DIR)/Core -I$(THEOS_PROJECT_DIR)/Vendor
AutoMatcher_CCFLAGS    = -std=c++17 -O3 -ffast-math -fno-exceptions -fno-rtti

AutoMatcher_FRAMEWORKS         = UIKit Foundation CoreGraphics CoreImage \
                                 QuartzCore ImageIO Accelerate
AutoMatcher_PRIVATE_FRAMEWORKS = IOSurface BackBoardServices GraphicsServices
AutoMatcher_LDFLAGS            = -undefined dynamic_lookup

include $(THEOS_MAKE_PATH)/tweak.mk

after-install::
	install.exec "killall -9 SpringBoard"
```

为什么这样写，逐条依据：

- **`ARCHS` 单复数与取值** `[源码实测]`：`makefiles/instance/rules.mk:179` `ALL_ARCHFLAGS = $(foreach ARCH,$(TARGET_ARCHS),-arch $(ARCH))`。arm64 与 arm64e 会各出一份 slice 并 `lipo` 合并。iPhone 7 Plus 是 A10 → 只能跑 arm64；加 arm64e 是为了同一份 rootless deb 也能装到 A12+ 设备。
- **`-fobjc-arc` 放 `_OBJCFLAGS`** `[源码实测]`：`rules.mk:187/204/205`，编译行（`rules.mk:305` .m / `:313` .mm）把 `$(ALL_CFLAGS) $(ALL_OBJCFLAGS) $(ALL_CCFLAGS) $(ALL_OBJCCFLAGS)` 依次展开；`_CFLAGS` 是对**所有**源文件生效的。Theos 官方的 `tweak` 模板里写的是 `_CFLAGS = -fobjc-arc`（[theos/templates ios/tweak/Makefile](https://github.com/theos/templates/blob/master/ios/tweak/Makefile)），当项目里有 `.c/.cpp` 时给 C++ 传 `-fobjc-arc` 只是无用参数，`common.mk:223` 已带 `-Wno-unused-command-line-argument -Qunused-arguments` 所以不会报错 `[推断]`（未实测混编时的实际告警）。
- **`.cpp/.mm/.c` 直接写进 `_FILES` 即可** `[源码实测]`：`rules.mk:11-14` 按扩展名分派（`OBJC_FILES = $(filter %.m %.mm %.x %.xm %.xi %.xmi,...)`、`OBJCC_FILES`、`SWIFT_FILES = $(filter %.swift,...)`）；`:311-313` `.mm` → `$(TARGET_CXX) -x objective-c++`；`:335` `.cc`；`:347` `.cpp`。也支持独立变量 `XXX_CC_FILES` / `XXX_OBJCC_FILES`（`rules.mk:5`）。
- **`-O3` 能覆盖默认 `-Os`** `[源码实测]`：`common.mk:223` 的 `_THEOS_INTERNAL_CFLAGS` 里含 `$(OPTFLAG)`，而它排在 `ALL_PFLAGS` 的**最前面**（`rules.mk:187`），instance 级 `XXX_CFLAGS` 排在后面 → 后者覆盖前者。
- **`.metal` 不被支持** `[源码实测]`：`rules.mk:292` 的 `.SUFFIXES: .m .mm .c .cc .cpp .xm .swift` 里没有 `.metal`，Theos 没有 Metal shader 编译规则（要用得自己在 `before-all::` 里调 `xcrun -sdk iphoneos metal`）。

## 1.2 `TARGET` 四段含义 + SDK 解析（含踩坑）

`[文档明确]`（Apple Wiki Dev:Theos）格式：`platform:compiler:sdk_version:deployment_version`。

`[源码实测]` 解析实现：
- `makefiles/targets/_common/darwin_head.mk:103-104`：`_SDKVERSION := $(or $(__THEOS_TARGET_ARG_<n>),...)`、`_THEOS_TARGET_SDK_VERSION := $(or $(_SDKVERSION),latest)`；第四段是 deployment version。
- `darwin_head.mk:107`：候选 SDK = `$(THEOS_SDKS_PATH)/iPhoneOS*.sdk`（`common.mk:74` → `$(THEOS)/sdks`）。
- `darwin_head.mk:109-112`：**若 `THEOS_PLATFORM_SDK_ROOT` 非空，会把 Xcode 的 `Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS*.sdk` 一并并入候选**；`makefiles/platform/Darwin.mk:17` `THEOS_PLATFORM_SDK_ROOT := $(shell xcode-select -print-path)`。
- `darwin_head.mk:123-127`：数值排序取**最大**者；`latest` → 该最大值。
- `darwin_tail.mk:11`：`SYSROOT := $(or $(wildcard $THEOS/sdks/iPhoneOS<ver>.sdk), $(wildcard .../Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS<ver>.sdk))` → **同版本时 `$THEOS/sdks` 优先**。
- `makefiles/master/rules.mk:74`：找不到时报 `Your chosen SDK, "iPhoneOS<ver>.sdk", does not appear to exist.`

> **【关键坑】** `[源码实测]`+`[实测]`：`github/runner-images` 的 macOS 26 arm64 镜像 SDK 表只有 iOS 26.0/26.1/26.2/26.4/26.5，**没有 16.5**；而 `theos/sdks` 仓库最高只有 `iPhoneOS16.5.sdk`。两边一合并，写 `iphone:clang:latest:15.0` 会选中 **iOS 26.x SDK**（不是你以为的 16.5）。要稳定拿到私有符号，必须写死 `iphone:clang:16.5:15.0` 并把 `theos/sdks` 装好。

`[实测]` `theos/sdks` 仓库（[theos/sdks](https://github.com/theos/sdks)）README 原文：
> `This repository contains patched iOS SDKs containing private symbols. These were removed from official SDKs starting in Xcode 7.3 and the iOS 9.3 SDK.`

仓库内含 `iPhoneOS9.3 / 10.3 / 11.4 / 12.4 / 13.7 / 14.5 / 15.6 / 16.5 .sdk`（根目录是**真实目录**，不是压缩包；`iPhoneOS16.5.sdk/` 下有 `SDKSettings.json`、`usr/include`、`usr/lib`、`System/Library/{Frameworks,PrivateFrameworks}`）。安装（README 推荐整包下载）：

```bash
# 方式 A（README 原文推荐，体积大）
curl -L https://github.com/theos/sdks/archive/master.zip -o sdks.zip
unzip -q sdks.zip -d /tmp/sdks
mkdir -p "$THEOS/sdks" && cp -R /tmp/sdks/sdks-master/iPhoneOS16.5.sdk "$THEOS/sdks/"

# 方式 B（只拉一个 SDK，推荐用于 CI）[推测：git 语义正确，但未在 CI 实测]
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/theos/sdks.git /tmp/sdks
cd /tmp/sdks && git sparse-checkout init --cone && git sparse-checkout set iPhoneOS16.5.sdk && git checkout
mkdir -p "$THEOS/sdks" && mv iPhoneOS16.5.sdk "$THEOS/sdks/"
```

## 1.3 rootless 对 `INSTALL_PATH` 与 deb 内路径的自动改写规则

`[源码实测]` 完整链条（这是本报告最需要精确的一节）：

1. **安装前缀**：`vendor/mod/rootless/package.mk` → `THEOS_PACKAGE_INSTALL_PREFIX = /var/jb`。
2. **staging 目录**：`makefiles/common.mk:261-264`
   ```make
   THEOS_STAGING_DIR_NAME ?= _
   THEOS_STAGING_DIR ?= $(_THEOS_LOCAL_DATA_DIR)/$(THEOS_STAGING_DIR_NAME)
   _THEOS_STAGING_TMP = $(THEOS_STAGING_DIR)tmp
   _THEOS_SCHEME_STAGE = $(_THEOS_STAGING_TMP)$(THEOS_PACKAGE_INSTALL_PREFIX)
   ```
   → rootless 时 `_THEOS_SCHEME_STAGE = .theos/_tmp/var/jb`。
3. **改写动作**：`makefiles/package/deb.mk:61-79`（注释原文 `# Iterate through staging dir and move top-level items to tmp stage if != "DEBIAN"`）
   ```make
   ifneq ($(THEOS_PACKAGE_INSTALL_PREFIX),)
     foreach i in $(wildcard $(THEOS_STAGING_DIR)/*):
       除非 i 含 "DEBIAN"，否则 mv $(i) $(_THEOS_SCHEME_STAGE)
     mv $(wildcard $(_THEOS_STAGING_TMP)/*) $(THEOS_STAGING_DIR)
   endif
   ```
   → **只对 staging 顶层的非 `DEBIAN` 项加前缀**，`DEBIAN/control`、`DEBIAN/postinst` 本身**不会**变成 `var/jb/DEBIAN/...`。
4. **`layout/` 的处理**：`makefiles/stage.mk:26` `[ -d layout ] && rsync -a "layout/" "$(THEOS_STAGING_DIR)" --exclude "DEBIAN"`；`deb.mk:31-32` 单独 `rsync layout/DEBIAN/ → staging/DEBIAN/`。
5. **最终结果** `[源码实测]`：
   - tweak 默认安装路径 `makefiles/instance/tweak.mk` → `LOCAL_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries`
   - 加上前缀后 deb 内路径 = **`./var/jb/Library/MobileSubstrate/DynamicLibraries/AutoMatcher.dylib`** 与同目录 `AutoMatcher.plist`
   - 若自己写 `AutoMatcher_INSTALL_PATH = /Library/Application Support/AutoMatcher`，最终 = `/var/jb/Library/Application Support/AutoMatcher`
   - `[文档明确]` 官方原话：rootless 下**所有东西都必须在 `/var/jb` 内**，你不应该再手动写 `/var/jb`（Theos 会加）。
6. **dylib 的 install_name 也会被改写** `[源码实测]`：
   - 有根：`makefiles/targets/_common/darwin_head.mk:6` `TARGET_LDFLAGS_DYNAMICLIB = -dynamiclib -install_name "$(LOCAL_INSTALL_PATH)/$(1)"`（绝对路径）
   - rootless：`vendor/mod/rootless/instance/library.mk` → `-install_name "@rpath/$(THEOS_CURRENT_INSTANCE)$(TARGET_LIB_EXT)"`；framework 同理
   - rpath：`vendor/mod/rootless/instance/rules.mk` → `-rpath /var/jb/Library/Frameworks -rpath /var/jb/usr/lib`（v1）；rootless **v2** 额外加 `-rpath '@loader_path/.jbroot/Library/Frameworks' -rpath '@loader_path/.jbroot/usr/lib'`
   → 你自己的 dylib 若被另一个 dylib 依赖，用 `@rpath/xxx.dylib` 而不是绝对路径。
7. **包装架构强制改写** `[源码实测]`：`vendor/mod/rootless/package/deb.mk` 全文只有：
   ```make
   ifneq ($(THEOS_PACKAGE_ARCH),iphoneos-arm64)
   	THEOS_PACKAGE_ARCH := iphoneos-arm64
   endif
   ```
   而 `makefiles/package.mk:26-28` 的 include 顺序是「先 `__mod,package.mk` → 再 `-include package/deb.mk` → 再 `__mod,package/deb.mk`」，`common.mk:136` 定义 `__mod = -include $(THEOS_VENDOR_MODULE_PATH)/<mod>/<file>` → **覆盖发生在读取 control 之后，所以最终一定赢**。结论：rootless 构建的 deb 文件名与 control 里的 `Architecture` **都是 `iphoneos-arm64`**，你在 control 里写什么都会被改。

## 1.4 rootless runtime 路径助手 `rootless.h`

`[源码实测]` [theos/headers/rootless.h](https://github.com/theos/headers/blob/master/rootless.h)：在真机（非模拟器）走 `#include <libroot/libroot.h>`，`ROOT_PATH(cPath) = JBROOT_PATH_CSTRING(cPath)`、`ROOT_PATH_NS(nsPath) = JBROOT_PATH_NSSTRING(nsPath)`（**运行期**探测真实 jbroot，兼容 relocated jbroot）；其它平台退化为编译期拼 `THEOS_PACKAGE_INSTALL_PREFIX`（编译器已注入 `-D THEOS_PACKAGE_INSTALL_PREFIX=...`，见 `rules.mk:144`）。

> **注意**：`rootless.h` 只在「越狱环境」语义下正确。**侧载进 IPA 的那条线不要 include 它**，否则路径会多出 `/var/jb` 前缀（非越狱设备上不存在）。

## 1.5 `control` 字段与依赖（rootless 要点）

`[源码实测]` `makefiles/package/deb.mk:25-27`：

```make
THEOS_PACKAGE_NAME := $(shell grep -i "^Package:" control | cut -d' ' -f2-)
THEOS_PACKAGE_ARCH := $(shell grep -i "^Architecture:" control | cut -d' ' -f2-)
THEOS_PACKAGE_BASE_VERSION := $(shell grep -i "^Version:" control | cut -d' ' -f2-)
```

`:52-55` 随后把 control 拷进 staging 时 **删掉** `Version:` / `Architecture:` 行并**重新追加** `Architecture: $(THEOS_PACKAGE_ARCH)` / `Version: $(_THEOS_INTERNAL_PACKAGE_VERSION)` / `Installed-Size: <du>`。

→ **所以：`control` 里必须写 `Architecture:` 和 `Version:`（Theos 靠它推导），但最终 deb 里的值由 Theos 决定。**

`[文档明确]` 字段规范（[theos.dev/docs/packaging](https://theos.dev/docs/packaging)）：`Package`（唯一 ID，反域名）、`Name`、`Depends`（逗号分隔，版本语法 `(>= x)`；伪包 `firmware` 可限制 iOS 版本）、`Pre-Depends`、`Recommends`、`Provides`、`Conflicts`、`Architecture`（**`iphoneos-arm` = 有根，`iphoneos-arm64` = 无根**）、`Section`（`Tweaks` / `Utilities` 最常见）、`Description`、`Icon`、`Depiction`、`SileoDepiction`、`Maintainer`、`Author`、`Version`。`Installed-Size` / `Tag` 一般由打包器生成。

`[实测]` 【**依赖写什么**】ElleKit 自己的包定义 [ellekit/packaging/control](https://raw.githubusercontent.com/evelyneee/ellekit/main/packaging/control)（2026 抓取，main 分支）原文：

```
Package: ellekit
Conflicts: com.ex.substitute, org.coolstar.libhooker, science.xnu.substitute, mobilesubstrate, com.saurik.substrate.safemode
Replaces: com.ex.libsubstitute, org.coolstar.libhooker, mobilesubstrate
Provides: mobilesubstrate (= 99), org.coolstar.libhooker (= 1.6.9)
```

→ **Dopamine / rootless 下 `Depends: mobilesubstrate` 就是正确写法**（ElleKit 提供虚拟包 `mobilesubstrate (= 99)`）。写 `ellekit` 也对，但会硬绑实现；同时写两个反而可能因 Conflicts 语义出问题，**只写 `mobilesubstrate`**。

**可直接照抄的 control**（rootful / rootless 共用一份，架构由 Theos 覆盖）：

```
Package: com.yourname.automatcher
Name: AutoMatcher
Version: 1.0.0
Architecture: iphoneos-arm
Description: Screen template matcher with a runtime control panel.
Maintainer: YourName
Author: YourName
Section: Tweaks
Depends: mobilesubstrate (>= 0.9.5000), firmware (>= 15.0)
Tag: purpose::extension, compatible_min::ios15.0
```

- `[文档明确]` rootless 构建时 Theos 会把 `Architecture` 改成 `iphoneos-arm64`；同一 identifier、同一版本号可以同时发 rootful 与 rootless 两个 deb，APT 只装匹配架构的那个（[Apple Wiki: Rootless](https://theapplewiki.com/wiki/Rootless) 原文：`APT will only install the version of the package that matches the appropriate architecture, even if it has an older version number`）。
- 自建源时 `Release` 必须写 `Architecture: iphoneos-arm iphoneos-arm64`，否则 Sileo/Cydia/apt 刷新报错；Zebra 不检查该字段。
- `[文档明确]` iOS 15 **不需要**任何 `libswift` 依赖（Swift 运行时自 iOS 12.2 内置于系统，[theos.dev/docs/swift](https://theos.dev/docs/swift)）。本项目也不要用 Swift（见 §2.5）。
- `[文档明确]` 不要用 `Architecture: iphoneos-arm64e`：Theos 的 rootless module 只有 `iphoneos-arm64`；`iphoneos-arm64` 里的 "64" **不表示 CPU 架构**（原文：`The architecture name is misleading - this does not change anything relating to arm64 packages prior to iOS 15`），arm64 与 arm64e 设备都装它。

## 1.6 过滤器 plist

`[文档明确]` 路径：与 dylib 同目录。
- 有根：`/Library/MobileSubstrate/DynamicLibraries/X.dylib` + `X.plist`
- 无根：`/var/jb/Library/MobileSubstrate/DynamicLibraries/X.dylib` + `X.plist`（Theos 自动加前缀）

`[源码实测]` 命名约束（`makefiles/instance/tweak.mk`）：plist 必须叫 `<实例名>.plist` 或 `Filter.plist`，否则报
`You are missing a filter property list. Make sure it's named "<X>.plist" or "Filter.plist".`

`[文档明确]` 内容（Theos Packaging 文档原文结构）：

```xml
<plist version="1.0">
<dict>
	<key>Filter</key>
	<dict>
		<key>Bundles</key>
		<array><string>some.bundle.id</string></array>
		<key>Executables</key>
		<array><string>executable-name</string></array>
		<key>Classes</key>
		<array><string>class-name</string></array>
	</dict>
</dict>
</plist>
```

等价 NeXTSTEP 文本格式（Theos 官方 `ios/tweak` 模板用的就是这种）：

```
{ Filter = { Bundles = ( "com.apple.springboard" ); }; }
```

`[实测]` 真实仓库三种写法：
- [YTUHD/YTUHD.plist](https://github.com/PoomSmart/YTUHD) → `{ Filter = { Bundles = ( "com.google.ios.youtube" ); }; }`
- [BHTwitter/BHTwitter.plist](https://github.com/BandarHL/BHTwitter) → `{ Filter = { Bundles = ( "com.atebits.Tweetie2" ); }; }`
- [Choicy/Choicy.plist](https://github.com/opa334/Choicy) → XML，`Filter/Bundles = [com.apple.Security]`，另外带 `IsTweakManager = true`

- `Bundles` 匹配 **bundle identifier**，`Executables` 匹配**可执行文件名**（如 `SpringBoard`），`Classes` 匹配类名。三者可组合（不同键之间是「或」，第一次注入后不再重复）。
- **关于 `Mode`**：`[未核实]` 我在 Theos 文档、Apple Wiki、以及上面三个真实仓库里**都没有找到 `Mode` 键**。老式 Cydia 过滤器里有 `CoreFoundationVersion`（限制系统版本）这类键，但**我这次没能找到任何权威来源**，建议不要用 `Mode`，用 `Bundles` / `Executables`。
- 运行时弹出的控制面板要读设备上的 `.auto` 文件列表 → 你的 tweak 需要注入 **SpringBoard**（或你的目标 App）本身；过滤器写 `Bundles = ("com.apple.springboard");`。若同时要 hook 目标 App，写成两个 bundle id 的数组即可。

## 1.7 `layout/DEBIAN/postinst` / `prerm`

`[源码实测]` **Theos 完全不会替你生成维护脚本**：`makefiles/` 里 grep `postinst|prerm|preinst|postrm|extrainst` 只命中 `package/deb.mk:31-32`（把 `layout/DEBIAN/` 原样 rsync 进 staging）与 `:12`（control 查找）。`layout/DEBIAN/` 里放什么就打包什么。

`[文档明确]` 由 `layout/DEBIAN/` 提供的脚本名：`preinst` / `postinst` / `prerm` / `postrm` / `extrainst_`；`extrainst_` 是 Telesphoreo/Elucubratus/Procursus 的 dpkg 扩展（参数 `install`/`upgrade`），用它需要在 control 里加 `Pre-Depends: dpkg (>= 1.13.25-5)`。

要点（rootless 相关）：

1. **所有路径都要带 `/var/jb`**：脚本里写死 `PREFIX=/var/jb`，或用 `dpkg` 的变量。Theos **不会**改写你脚本里的路径字符串。
2. **不要直接 `sbreload` / `uicache`** `[文档明确]`（Apple Wiki Dev:Packaging）：正确做法是通过 dpkg 传进来的 `$CYDIA` 文件描述符上报 `finish:` 状态。状态值：`0` = 仅返回、`1` = uicache（现代系统已由「装到 /Applications 自动触发」替代）、`2` = reopen、`3` = restart（重启 userspace）、`4` = reload（现在与 3 等价）、`5` = reboot（iOS 11+ 仅重启 userspace）。官方给的 C 写法要点是：`sscanf(cydia, "%d %d", &fd, &version)`，若返回值 ≠ 2 或 `version < 1` 就直接 return，否则 `fprintf(fout, "finish:%s\n", cmd)`。
   自拟 shell 版（`[推测]` 未实测，建议装到设备后先用 `dpkg -i` 手工验证）：
   ```bash
   #!/bin/bash
   set -e
   # Theos 构建期已对产物执行过 ldid -S，这里通常不需要再签
   # 若需补签：ldid -S/var/jb/Library/MobileSubstrate/DynamicLibraries/AutoMatcher.dylib
   if [ -n "$CYDIA" ]; then
     set -- $CYDIA; fd=$1; ver=$2
     if [ -n "$fd" ] && [ -n "$ver" ] && [ "$ver" -ge 1 ] 2>/dev/null; then
       printf 'finish:restart\n' >&"$fd" || true
     fi
   fi
   exit 0
   ```
3. **`ldid` / `codesign` 步骤在 postinst 里不是必需的** `[源码实测]`：`makefiles/targets/_common/darwin_head.mk:31-43` 默认探测 `ldid`（找不到则用 `$(SDKBINPATH)/ldid`），`TARGET_CODESIGN_FLAGS ?= -S`；`rules.mk:214-215` 在链接后自动执行
   `CODESIGN_ALLOCATE=$(TARGET_CODESIGN_ALLOCATE) $(TARGET_CODESIGN) <FLAGS>`。
   → **Theos 已对每个产物 `ldid -S`**。只有需要额外 entitlements 时才在构建期覆盖：`TARGET_CODESIGN_FLAGS = -S$(THEOS_PROJECT_DIR)/ent.plist`（注意是 `-S<file>` 不是 `-M<file>`，见 §3.2）。
4. 脚本 hashbang 要准 `[文档明确]`：用了 bashism 就写 `#!/bin/bash`（iOS 上是 bash 3.2）。
5. 保持可执行位：`layout/` 里文件权限会被 rsync 保留，打包时务必确认 `postinst` 是 `0755`。
6. 设 `export COPYFILE_DISABLE=1`（`[文档明确]` Dev:Packaging 建议，防止 macOS 把 `._*` 资源分叉文件打进 deb）。Theos 打包命令里已经带了（`deb.mk:79`）。

## 1.8 一份 Makefile 同时出两个 deb（构建矩阵）

`[实测]` ElleKit 用的是 **per-target 变量**写法（[ellekit/Makefile](https://raw.githubusercontent.com/evelyneee/ellekit/main/Makefile)）：

```make
deb-ios-rootful: ARCHITECTURE = iphoneos-arm
deb-ios-rootful: INSTALL_PREFIX =
deb-ios-rootless: ARCHITECTURE = iphoneos-arm64
deb-ios-rootless: INSTALL_PREFIX = /var/jb
...
	@find $(INSTALL_ROOT)/usr/lib -type f -exec ldid -S {} \;
	@ldid -S./loader/taskforpid.xml $(INSTALL_ROOT)/usr/libexec/ellekit/loader
	dpkg-deb --root-owner-group -b $(STAGE_DIR) packages/ellekit_$(DEB_VERSION)_$(ARCHITECTURE).deb
```

但**用 Theos 时不需要这么写** —— Theos 的方案是「**同一个 Makefile + 两次带不同 `THEOS_PACKAGE_SCHEME` 的调用**」，因为 scheme 会自动 import 对应 module（`common.mk:133/136`）并改写前缀、rpath、install_name、Architecture。**唯一要求**是两次构建之间 `make clean`（官方明确要求）。

`[源码实测]` 产物命名与输出目录：
- `makefiles/package/deb.mk:59`：`_THEOS_DEB_PACKAGE_FILENAME = $(THEOS_PACKAGE_DIR)/$(THEOS_PACKAGE_NAME)_$(_THEOS_INTERNAL_PACKAGE_VERSION)_$(THEOS_PACKAGE_ARCH).deb`
  → rootless 文件名以 `_iphoneos-arm64.deb` 结尾，rootful 以 `_iphoneos-arm.deb` 结尾，**天然不会互相覆盖**。
- `makefiles/common.mk:268-269`：`THEOS_PACKAGE_DIR_NAME ?= packages`、`THEOS_PACKAGE_DIR ?= $(THEOS_BUILD_DIR)/$(THEOS_PACKAGE_DIR_NAME)`（`THEOS_BUILD_DIR` = `.theos`）。
- `makefiles/master/rules.mk:127`：`rm -rf $(THEOS_PACKAGE_DIR)/$(THEOS_PACKAGE_NAME)_*-*_$(THEOS_PACKAGE_ARCH).deb`（清理旧产物）。

**CI 中推荐的写法（把产物放到 `.theos` 之外，避免被 `make clean` 清掉）**：

```bash
# rootless
make clean
make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless THEOS_PACKAGE_DIR="$PWD/dist/rootless"

# rootful
make clean
make package FINALPACKAGE=1 THEOS_PACKAGE_DIR="$PWD/dist/rootful"
```

`[源码实测]` `FINALPACKAGE=1` 的意义（`makefiles/package.mk:54-61`）：不加时版本号会被追加 `-<自增 build number>`（`bin/package_version.sh`），**加了才是干净的 `<Version>`**（`VERSION.EXTRAVERSION = $(if $(PACKAGE_BUILDNAME),+$(PACKAGE_BUILDNAME))`）。CI 上要确定性产物 → 一律 `FINALPACKAGE=1`。

## 1.9 开发期（可选）

- `[文档明确]` `INSTALL_TARGET_PROCESSES = SpringBoard` + `make do`（走 SSH 到 `THEOS_DEVICE_IP`）：`[源码实测]` 它**只影响 `make install`**（`makefiles/package.mk:116-145`、`messages.mk:88-90`），**不会写进 deb**。
- `[文档明确]` Theos 必须以**普通用户**安装和运行，不要 root（[theos.dev/docs/installation](https://theos.dev/docs/installation)）。
- `[文档明确]` 更新 Theos 用 `$THEOS/bin/update-theos`；报 `make: *** No rule to make target 'update-theos'. Stop.` 说明是老式安装。

---

# 2. 编译 C / C++ / 手写优化代码 / 框架 / Swift

## 2.1 C++ 与优化选项

- `[源码实测]` 加源文件：`.c/.cc/.cpp/.mm/.xm` 直接写进 `XXX_FILES`（`rules.mk:11-14`），或用 `XXX_C_FILES` / `XXX_CC_FILES` / `XXX_OBJCC_FILES`。`.xm` 会先过 `logos.pl` 预处理器生成 `.mm` 再按 objective-c++ 编译（`rules.mk:411-419`）。
- `[源码实测]` 默认优化级别是 `-Os`（来自 `common.mk:223` 的 `$(OPTFLAG)`）；在 `XXX_CFLAGS` 里写 `-O3` 即可覆盖（顺序依据见 §1.1）。
- `[源码实测]` 标准库：SDK ≥ 12 起 Theos 自动加 `-stdlib=libc++`（`darwin_tail.mk`）。
- `[文档明确]` `-ffast-math`：会打开不保 IEEE 语义的假设（重结合、无 NaN/Inf 语义）。模板匹配若用**整数** SAD/NCC 无所谓；若用浮点归一化互相关，`-ffast-math` 可能在极端像素分布下产生差异，建议只给 `.cpp` 加（`XXX_CCFLAGS`），别给整包加。
- `[文档明确]` `-fobjc-arc` 只对 ObjC 有意义 → 放在 `XXX_OBJCFLAGS` / `XXX_OBJCCFLAGS`。
- 手写 NEON：见 §2.2。

## 2.2 NEON 怎么开

- `[文档明确]`（Android NDK 官方指南 [developer.android.com/ndk/guides/cpu-arm-neon](https://developer.android.com/ndk/guides/cpu-arm-neon)，2026 抓取）：原文 `All ARMv8-based ("arm64") Android devices support Neon.`，`The NDK enables Neon by default for both Arm ABIs.` → **arm64 上 Neon 是 ABI 基线，默认开启，不需要任何编译开关**。
- `[文档明确]` `-mfpu=neon` 属于 **32 位 ARMv7** 的 `-mfpu` 家族；arm64 的 clang 不认（会报 unused argument / 被 `-Qunused-arguments` 吞掉）。**本项目 ARCHS 只有 arm64/arm64e → 不要写 `-mfpu=neon`**。
- 用法：`#include <arm_neon.h>` 直接用 `uint8x16_t` / `vld1q_u8` / `vabdq_u8` / `vaddlvq_u8` 等 intrinsic。`[文档明确]` NDK 指南同时建议：`You should not write explicit Neon intrinsics in your C/C++ code. Clang's portable vector types will automatically use Neon instructions.` —— 即优先写 `typedef uint8_t v16u8 __attribute__((vector_size(16)));` 让 clang 自动向量化，只有 SAD/SSD 这类热点再手写 intrinsic。
- `[推测]` GCC/Clang ARM 的一手架构手册引用我这次没抓到（Android 文档是异平台语境），但「AArch64 基线含 Advanced SIMD」是 ARM 架构事实，实践上无误。

## 2.3 公开框架 / 私有框架链接

`[源码实测]` `makefiles/instance/rules.mk:104-117` 的展开规则（**这是本节最关键的一条**）：

```make
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$($(TYPE)_FRAMEWORKS),-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$(INSTANCE_)_FRAMEWORKS,-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach l,..._LIBRARIES,-l$(l))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$($(TYPE)_PRIVATE_FRAMEWORKS),-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$(INSTANCE_)_PRIVATE_FRAMEWORKS,-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,..._EXTRA_FRAMEWORKS,-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$($(TYPE)_WEAK_FRAMEWORKS),-framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach f,$(INSTANCE_)_WEAK_FRAMEWORKS,-weak_framework $(f))
_THEOS_INTERNAL_LDFLAGS += $(foreach l,...,-weak-l$(l))
```

→ **`XXX_FRAMEWORKS` 与 `XXX_PRIVATE_FRAMEWORKS` 编译出来的 `-framework` 完全一样**，区别只在「框架搜索路径」。

- `[源码实测]` 私有框架路径：`common.mk:196` 对每个 searchpath 做 `$(if $(call __exists,$(path)),-L$(path) -F$(path))` → **只有目录存在才会加 `-F`**；`darwin_tail.mk:17` `TARGET_PRIVATE_FRAMEWORK_PATH ?= $(SYSROOT)/System/Library/PrivateFrameworks`；`-F` 目录 = SDK 内的 `System/Library/PrivateFrameworks`。所以 `PRIVATE_FRAMEWORKS = IOSurface BackBoardServices GraphicsServices` 之所以能解析，是因为**用的是打过补丁的 SDK**（`$THEOS/sdks/iPhoneOS16.5.sdk` 里这些都存在）。
- `[实测]` `theos/sdks` 的 `iPhoneOS16.5.sdk/System/Library/PrivateFrameworks/` 里确认存在 `BackBoardServices.framework`、`IOSurface.framework`、`GraphicsServices.framework`、`FrontBoardServices.framework`（早期字母序逐一验证；GitHub 的 tree 列表在 1000 条处截断，N 之后的框架名没验完 `[未核实]`）。
- `[源码实测]` **Theos 不会自动加 `-undefined dynamic_lookup`**（整个 Theos 仓库 grep `dynamic_lookup` = 0 命中），它默认只加 `-multiply_defined suppress`（`darwin_tail.mk:42`）。
- `[文档明确]` 链接器手册（[ld(1)](https://keith.github.io/xcode-man-pages/ld.1.html)）：`-undefined treatment ... Options are: error, warning, suppress, or dynamic_lookup. The default is error.` → **引用 SDK 里没有声明的符号（私有 API 常见）时，必须在 `XXX_LDFLAGS` 里显式加 `-undefined dynamic_lookup`**，否则 `Undefined symbols for architecture arm64` 直接失败。
  同一手册的注意事项原文：`dynamic_lookup that depends on lazy binding will not work with chained fixups.` `[推测]` 对 dylib 影响通常可忽略（社区 tweak 大量使用），但如果遇到加载期崩溃，先怀疑这条。
- `[文档明确]` `-rpath path`：`Add path to the runpath search path list for image`。自己发私有 dylib/framework 时用 `@rpath` + `-rpath`；rootless 下 Theos 已自动加好 rpath（见 §1.3）。
- **私有 API 的三层兜底策略**（`[推测]`，工程建议）：
  1. 首选 `XXX_PRIVATE_FRAMEWORKS` + 打补丁 SDK（编译期有类型，最省事）；
  2. 符号缺失 → `-undefined dynamic_lookup` + 运行时用 `dlsym(RTLD_DEFAULT, "CARenderServerRenderDisplay")` 取函数指针；
  3. 框架在部分系统上不存在 → `dlopen("/System/Library/PrivateFrameworks/X.framework/X", RTLD_LAZY)`，失败就降级。
  注意 2/3 都要求 `#include <dlfcn.h>`，并且**别把私有框架写进 `_FRAMEWORKS`（公开列表）**，语法上没区别但语义混乱。
- `[文档明确]` `.tbd` stub：Xcode 7.3 / iOS 9.3 SDK 之后官方 SDK 移除了私有符号，这就是需要 `theos/sdks` 的根本原因；`-undefined dynamic_lookup` 是绕过 stub 缺失的另一条路。
- 针对本项目要用的框架：
  - `Accelerate`（vImage/vDSP，公开，iOS 4+）：**这是替代 OpenCV 做模板匹配/图像预处理最划算的选择**（vImageConvolve、vImageScale、vDSP 相关）。
  - `ImageIO` + `CoreGraphics`（公开，iOS 4+/2+）：PNG 解码 → `CGImageSourceCreateWithData` → `CGImageSourceCreateImageAtIndex` → `CGContextDrawImage` 到自己的 buffer。
  - `CoreImage`（公开，iOS 5+）、`QuartzCore`（公开）、`UIKit`、`Foundation`。
  - `Metal` / `MetalPerformanceShaders` / `CoreML`：都是公开框架，直接写进 `_FRAMEWORKS` 即可；但 **MPS/CoreML 的模型文件与 Metal shader 需要额外资源打包**，而 Theos 没有 `.metal` 编译规则（`[源码实测]` 见 §1.1）→ `[推测]` 想用 Metal 得自己在 `before-all::` 里 `xcrun -sdk iphoneos metal` 并手动塞进 `_BUNDLE_RESOURCE_DIRS`，成本高、不建议第一版做。
  - `IOSurface` / `BackBoardServices` / `GraphicsServices`：**私有**，走 `_PRIVATE_FRAMEWORKS`；其中 `IOSurface` 是拿 framebuffer 的常用入口。
  - `[未核实]` 定时截屏的具体实现路径（`IOSurface` 抓屏 vs `CARenderServerRenderDisplay` vs `UIGraphicsImageRenderer` + `drawViewHierarchyInRect:`）我这次没有核实任何权威来源，本报告不给结论。

## 2.4 资源文件打包

- `[文档明确]` `XXX_BUNDLE_RESOURCE_DIRS`（默认 `Resources`）：tweak 有该目录时默认装到 `/Library/Application Support/<实例名>`（有根）；rootless 下自动变成 `/var/jb/Library/Application Support/<实例名>`。
- 若要在 dylib 里 `NSBundle` 找自己的资源，别用 `[NSBundle mainBundle]`（拿到的是宿主 App 的 bundle）——用 `[NSBundle bundleWithPath:ROOT_PATH_NS(@"/Library/Application Support/AutoMatcher")]`。

## 2.5 Swift 能不能用

`[文档明确]` [theos.dev/docs/swift](https://theos.dev/docs/swift)（2026 抓取）：
- Theos **可以**编译 Swift，支持与 ObjC 混编，宿主可为 macOS/iOS/Linux。
- ObjC 调 Swift：`#import "<实例名>-Swift.h"`（Swift 侧须 `public`/`open`）；Swift 调 ObjC：`<实例名>-Bridging-Header.h`（默认路径，可用 `XXX_SWIFT_BRIDGING_HEADER` 改）。
- iOS 12.2+ 系统自带 Swift 运行时 → **本项目（最低 iOS 15）不需要 `libswift` 依赖**。
- 官方对 tweak 的原话：`Tweaks: You can write tweaks in Swift using Orion. Do note that there is no solution for hooking Swift code at the moment.`
- `[源码实测]` Theos 的子模块里确实有 `vendor/orion`、`vendor/swift-support`（`.gitmodules`），CI 必须 `git clone --recursive` 才拿得到。

> **结论**：本项目用 **ObjC + C/C++** 更稳。Swift 只在你确实需要时才上（要 Orion 工具链、`dev.theos.orion (>= 1.0.0)` 依赖 `[源码实测]` `deb.mk:49`，且无法 hook Swift 代码）。UI 面板用 UIKit + ObjC 完全够。

---

# 3. 签名与 CI

## 3.1 CI 依赖清单（macos-latest）

`[实测]` `actions/runner-images` 的 `macos-26-arm64-Readme.md`（2026 年状态）：
- **`macos-latest` 现在 = macOS 26 Arm64**（同标签还有 `macos-26`、`macos-26-xlarge`）。`macos-15` / `macos-15-xlarge` 也是 arm64；`macos-15-large`、`macos-15-intel` 是 x64。macOS 14 已 deprecated。
- **镜像自带**：Git 2.55.0、GitHub CLI、**Perl 5.44.0**、Ruby 3.4.10、Python/Pip 3.14/26.2.1、`tar`(bsdtar 3.5.3)、`gtar`(GNU Tar 1.35)、zstd 1.5.7、7-Zip、curl、**默认 Xcode 26.6 (17F113)**。
- **镜像没有**：`dpkg`、`fakeroot`、`ldid`、`xz`/`lzma`。（`xz` 未被列入镜像清单 `[未核实]` 是否由系统自带——清单里没有，按没有处理。）

因此 CI 需要补的只有 **`ldid-procursus`** 和 **`xz`**：

```yaml
- name: Toolchain
  run: |
    brew install ldid-procursus xz
```

理由：
- `[实测]` `brew install ldid` 装的是 **saurik v2.1.5**（formula `url "git://git.saurik.com/ldid.git", tag: "v2.1.5"`，`install_symlink "ldid" => "ldid2"`）；`brew install ldid-procursus` 装的是 **`2.1.5-procursus7`**（homepage `ProcursusTeam/ldid`）。两个 formula `conflicts_with` 彼此。`[文档明确]`（Apple Wiki Dev:Updating extensions for iOS 15/16）iOS 15.0+ 要求 **DER 编码的 entitlements**，所有 tweak 必须用「更新过的 ldid」签名；iOS 15.1+ 增加 hash agility 要求，需 **ldid ≥ 2.1.5-procursus3**。（该来源是社区 wiki，非 Apple 官方 `[未核实]` 官方对应文档。）
- `[源码实测]` `xz` 是为了 `lzma`：`makefiles/package/deb.mk:5` `_THEOS_PLATFORM_DPKG_DEB_COMPRESSION ?= $(or $(THEOS_PLATFORM_DEB_COMPRESSION_TYPE),lzma)`，而 [dm.pl](https://raw.githubusercontent.com/theos/dm.pl/master/dm.pl) 的 `compression_cmd()` 是 `lzma -c`（经 Perl `open2` 管道）→ 构建机上**必须有 `lzma` 可执行文件**。想避免装 xz 可以改压 gzip：`THEOS_PLATFORM_DEB_COMPRESSION_TYPE=gzip`（`[源码实测]` 该变量优先于默认值；gzip 在 macOS 自带）。
- **不需要 `fakeroot`** `[源码实测]`：`common.mk:287-288` `FAKEROOT := $(THEOS_BIN_PATH)/fakeroot.sh -p ...`，Theos 自带 `bin/fakeroot.sh`（纯 bash），在非 root 且找不到 fauxsu/fakeroot-ng/fakeroot 时，带 `-r` 就直接执行 → macOS 上打包照常工作，且与 CPU 架构无关（**arm64 runner 可行**）。
- **不需要 `dpkg`** `[文档明确]`：[theos.dev/docs/dm.pl](https://theos.dev/docs/dm.pl)，dm.pl 是 `dpkg-deb -b` 的替代品，`平台无关（不需要 dpkg）`。
- 也**不需要 `dhinakg/procursus-action`**（ElleKit 用它是因为它用 `xcodebuild` + `dpkg-deb` 而非 Theos；该 action 自己也标了 **unmaintained**，且装的是 x86_64 bootstrap，在 arm64 runner 上要 Rosetta）。用 Theos 就没这回事。

## 3.2 `ldid -S` / `ldid -M` / `codesign` 各自怎么用

`[文档明确]` ldid 官方手册（[ProcursusTeam/ldid docs/ldid.1](https://github.com/ProcursusTeam/ldid/blob/main/docs/ldid.1)，January 20, 2022）原文：

| 选项 | 手册原文 | 实际用法 |
|---|---|---|
| `-S [file.xml]` | `Pseudo-sign the Mach-O binaries. If file.xml is specified then the entitlements found in file.xml will be embedded in the Mach-O.` | **嵌 entitlements：`ldid -S<ent.xml> <bin>`** |
| `-M` | `When used with -S, merge the new and existing entitlements instead of replacing the existing entitlements.` | **单独用无意义**；合并写法 `ldid -Sent.xml -M <bin>` |
| `-s` | `Resign the Mach-O binaries while keeping the existing entitlements.` | 保留原 entitlements 重签 |
| `-w` | `Shallow sign. Only the main binary of the specified bundle will be signed... Any nested bundles and/or stray binaries will be completely left alone.` | **ldid 对目录默认深签**，`-w` 才只签主二进制 |
| `-H [sha1\|sha256]` | `Disable the hash not specified. This is useful to replicate the default behavior of codesign(1), which only provides a sha256 signature.` | ldid 默认同时写 sha1+sha256 |
| 其它 | `-e` 打印 entitlements；`-h` 打印签名信息；`-r` 移除签名；`-K file` 用真实证书（p12/pkcs11）签；`-P [num]` 标 platform binary；`-I name` 指定 identifier；`-arch`（Procursus 扩展） | — |

`[文档明确]` 手册 HISTORY 原文：`iOS 15 support was added on June 11, 2021.` —— **手册里没有任何关于 DER entitlements 的说明**（手册早于该需求）`[未核实]` DER 支持对应的确切 ldid 版本/commit。

`[文档明确]` codesign 官方手册（[codesign(1)](https://keith.github.io/xcode-man-pages/codesign.1.html)）：
- `--deep`：`DEPRECATED for signing as of macOS 13.0`；并且 `Using the --deep option on an iOS style bundle without a Contents folder will not cause an error but will only sign the main binary of the bundle.` → **对 iOS `.app` 用 `--deep` 不会递归签内部 dylib**。手册另注：`Nested code content is a special term that only applies to macOS style bundles with a Contents folder.`
- `--force`：`causes codesign to replace any existing signature on the path(s) given. Without this option, existing signatures will not be replaced, and the signing operation fails.`
- `--force-library-entitlements`：`forcefully embed the supplied entitlements in the signature of libraries (non-main-executables). Not embedding entitlements in library signatures is default behavior as of macOS 15.0 when signing for all platforms.`
- `--generate-entitlement-der`：`Embedding DER entitlements is default behavior as of macOS 12.0 when signing for all platforms.`
- identity `-`：ad-hoc 签名。

**两条线各自怎么用：**

| | 越狱 deb 线（tweak dylib） | 侧载 IPA 线（非越狱 dylib） |
|---|---|---|
| 构建期签名 | **Theos 自动 `ldid -S`**（`rules.mk:214-215`，`TARGET_CODESIGN_FLAGS ?= -S`）。你**不需要**在 CI 里手写 ldid 命令 | 你自己签：注入后主二进制签名失效，重签由 **Sideloadly/AltStore 用你的 Apple ID 证书**完成；本地只做 ad-hoc 验证 |
| 需要 entitlements 时 | `TARGET_CODESIGN_FLAGS = -S$(THEOS_PROJECT_DIR)/ent.plist`（构建期）；或 postinst 里 `ldid -S/var/jb/.../X.dylib` | `codesign --force --sign - --entitlements ent.plist X.dylib`；**注意**默认不给 library 嵌 entitlements（macOS 15+ 起明确为默认），要嵌需 `--force-library-entitlements` |
| `codesign --deep` | 不要用 | **不要用**（对 iOS .app 只签主二进制，见上文） |
| 是否需要 DER | iOS 15+ 建议用 Procursus 版 ldid（社区证据） | 由 Sideloadly/AltStore 用 Xcode 的 codesign 处理，天然带 DER |

## 3.3 非越狱 dylib 侧载

`[实测]` [Sideloadly FAQ](https://sideloadly.io/faq) 原文（2026 抓取）：
> `What kind of .dylibs or .debs can I add to my IPA? / App crashes on launch after injecting dylib/deb/framework.` — `All dylib/deb/framework files are supported by Sideloadly, however, some of these files are specifically made for Jailbroken and will cause crashes when sideloaded on non-jailbroken devices. **Sideloadly will automatically attempt to update the injected files to support non-jailbroken devices, but it's not always guaranteed.**`

FAQ 其它相关条目：支持 iOS 7 到 iOS 26+；免费 Apple ID 同时最多 3 个侧载 App、7 天失效；iOS 16+ 需在设备上开 **Developer Mode**（Settings > Privacy & Security）；`IncorrectArchitecture (Failed to find matching arch for 64-bit Mach-O input file)` 无解；`no default case defined` 通常是 IPA 内文件损坏。

结论与建议（按置信度标注）：

1. `[文档明确]` **`-undefined dynamic_lookup` 是必需项**（当你的 dylib 引用宿主 App / 私有框架里 SDK 未声明的符号时）：ld 手册 `The default is error.`。Theos 不会自动加（§2.3），侧载线的 dylib 同样要加。
2. `[推测]`（社区通行做法，**未找到 Sideloadly/AltStore 官方明文**）**install_name 用 `@executable_path/Frameworks/X.dylib` 比 `@rpath/X.dylib` 稳**：因为 Sideloadly 把注入的 dylib 放到 `<App>.app/Frameworks/` 下，而**被注入的主二进制通常没有 `LC_RPATH` 含 `@executable_path/Frameworks`**（除非它自己就带 Frameworks 目录）。`@rpath` 依赖主二进制里已有对应 rpath，不可控。给 dylib 自己加 `-install_name @executable_path/Frameworks/X.dylib` 即可。
3. `[文档明确]` **注入工具默认会删掉主二进制的原有签名**：[Tyilo/insert_dylib](https://github.com/Tyilo/insert_dylib) README 说明它向 Mach-O 追加 `LC_LOAD_DYLIB`（`--weak` 则 `LC_LOAD_WEAK_DYLIB`）并同时自增 `ncmds`/`sizeofcmds`，默认删除代码签名（删 `LC_CODE_SIGNATURE` 并截断 `__LINKEDIT`、扩大 `LC_SYMTAB` 的 string table），否则报
   `.../codesign_allocate: file not in an order that can be processed (link edit information does not fill the __LINKEDIT segment):`
   用法：`insert_dylib dylib_path binary_path [new_binary_path]`，选项 `--inplace --weak --overwrite --strip-codesig --no-strip-codesig --all-yes`。
4. **嵌套 dylib 是否必须一起签**：`[未核实]` 我**没有找到** Sideloadly 官方文档或 AltStore FAQ 明确写"嵌套 dylib 必须一起签名"。可确证的相邻事实只有两条：① codesign 手册明确 `--deep` 对 iOS `.app` 只签主二进制（→ 谁要签就必须**逐个显式签**）；② Sideloadly FAQ 承认它会"自动尝试改写注入的文件以支持非越狱设备，但不保证"。**实践建议：自己用 `codesign -f -s -` 逐个签好每个 dylib，再交给 Sideloadly 重签**（ad-hoc 签名会被 Sideloadly 用你的开发者证书覆盖，但至少保证文件结构自洽、不会出现"签名覆盖范围不含 dylib"的错误）。这条我标为 `[推测]` 的工程建议，不是文档结论。
5. `[文档明确]` dylib 里**不能**用越狱专属的 hook API（MSHookFunction / libsubstitute / ellekit 的 API）：非越狱设备上根本没有这些库。要在非越狱环境改行为，得用 `fishhook`（rebase/bind 重定向）或方法交换（`class_getInstanceMethod` + `method_exchangeImplementations`）。同理**不要 include `rootless.h`**（§1.4）。
6. `[实测]` 参考：YTUHD 用自建开关区分两条线（[YTUHD/Makefile](https://raw.githubusercontent.com/PoomSmart/YTUHD/master/Makefile)）：
   ```make
   ifeq ($(SIDELOAD),1)
   $(TWEAK_NAME)_FILES += libundirect_compact.m
   else
   $(TWEAK_NAME)_LIBRARIES = undirect
   endif
   ```
   即「越狱线链接动态库 / 侧载线把等价源码直接编进去」——你可以用同一个思路做 `SIDELOAD=1`。

## 3.4 CI：完整可抄的两条流水线

### 3.4.1 越狱 deb（双 scheme）

```yaml
name: build-jailbreak
on: [push, workflow_dispatch]
jobs:
  deb:
    runs-on: macos-latest          # 2026 年 = macOS 26 arm64
    env:
      THEOS: ${{ github.workspace }}/theos
    steps:
      - uses: actions/checkout@v4

      - name: Install Theos
        run: |
          git clone --recursive https://github.com/theos/theos.git "$THEOS"

      - name: Install patched SDK (16.5)
        run: |
          git clone --filter=blob:none --no-checkout --depth 1 https://github.com/theos/sdks.git /tmp/sdks
          cd /tmp/sdks
          git sparse-checkout init --cone
          git sparse-checkout set iPhoneOS16.5.sdk
          git checkout
          mkdir -p "$THEOS/sdks"
          mv iPhoneOS16.5.sdk "$THEOS/sdks/"

      - name: Install tools
        run: brew install ldid-procursus xz

      - name: Build rootless deb
        run: |
          make clean
          make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless \
               THEOS_PACKAGE_DIR="$PWD/dist/rootless"

      - name: Build rootful deb
        run: |
          make clean
          make package FINALPACKAGE=1 \
               THEOS_PACKAGE_DIR="$PWD/dist/rootful"

      - uses: actions/upload-artifact@v4
        with:
          name: debs
          path: dist/**/*.deb
```

要点：`make clean` 夹在两次构建之间（官方要求）；`THEOS_PACKAGE_DIR` 指到 `.theos` 之外，避免被下一次 `make clean` 清掉；两次产物文件名自带 `_iphoneos-arm64` / `_iphoneos-arm` 后缀，不会冲突。

### 3.4.2 非越狱 dylib（iOS 15~18）

```yaml
name: build-sideload
on: [push, workflow_dispatch]
jobs:
  dylib:
    runs-on: macos-latest
    env:
      THEOS: ${{ github.workspace }}/theos
    steps:
      - uses: actions/checkout@v4
      - run: git clone --recursive https://github.com/theos/theos.git "$THEOS"
      - run: brew install ldid-procursus xz
      # 用 library 模板（LIBRARY_NAME / include library.mk），TARGET 同为 iphone:clang:16.5:15.0
      - run: make clean && make FINALPACKAGE=1 SIDELOAD=1 THEOS_PACKAGE_DIR="$PWD/dist"
      - uses: actions/upload-artifact@v4
        with:
          name: dylib
          path: |
            .theos/obj/**/*.dylib
            dist/**/*
```

`[推测]` 侧载线建议直接用 Theos 的 **library** 模板（[theos/templates ios/library/Makefile](https://github.com/theos/templates/blob/master/ios/library/Makefile)：`LIBRARY_NAME` / `_INSTALL_PATH = /usr/local/lib` / `include $(THEOS_MAKE_PATH)/library.mk`），把 `_INSTALL_PATH` 改成无所谓的位置，只要拿到 `.dylib`；`_LDFLAGS += -install_name @executable_path/Frameworks/AutoMatcher.dylib -undefined dynamic_lookup`。

## 3.5 在 CI 里跑 C/C++ 单元测试（不用真机/模拟器）

把**纯 C/C++ 的匹配/图像处理代码**编成 macOS 可执行文件直接跑——这是最省事、最快、最稳的方案：

```yaml
      - name: Unit tests (host macOS)
        run: |
          clang++ -std=c++17 -O2 -g -fsanitize=address,undefined \
            -I Core -I Vendor \
            -o /tmp/matcher_test \
            tests/matcher_test.cpp Core/Matcher.cpp Vendor/miniz.c \
            -framework Accelerate -framework CoreGraphics -framework ImageIO
          /tmp/matcher_test
```

可行性依据：
- `Accelerate`、`CoreGraphics`、`ImageIO` 在 macOS 上同名同 API 存在（Simulator 与 macOS 共用这些框架），所以只要你的匹配代码不碰 UIKit，就能在这三个框架下双端编译。
- `[实测]` runner 自带 Xcode 26.6 与 macOS SDK，`clang++` 可直接用。
- 测试用 `assert` / 自写 main 返回非 0 即可，**不需要 Xcode 工程文件**（Theos 项目本来就没有 `.xcodeproj`）。
- 若要跑 iOS 模拟器测试：`[实测]` 镜像预装 iOS 26.2/26.4/26.5 模拟器 runtime，可以用 `xcodebuild test -scheme ... -destination 'platform=iOS Simulator,name=iPhone 17'`，但**前提是你得另外维护一个 Xcode 工程或 SwiftPM 包**；对 Theos 工程属于额外成本，`[推测]` 不建议第一版做。
- 建议把「模板匹配 / ZIP 解包 / PNG 解码 → 灰度 buffer」全部写成不依赖 UIKit 的纯 C/C++（只依赖 CoreGraphics/ImageIO/Accelerate），这样 CI 上能 100% 覆盖核心算法。

---

# 4. 版本/兼容清单与屏幕像素 API

## 4.1 目标环境事实

- `[实测]` **Dopamine 2.x 支持矩阵**（[Dopamine `2.x` 分支 README](https://raw.githubusercontent.com/opa334/Dopamine/2.x/README.md)，2026 抓取）原文：
  > `A rootless semi-untethered jailbreak for iOS 15.0 - 16.5.1 (arm64e) and iOS 15.0 - 15.8.6 / 16.0 - 16.6.1 (arm64).`
  → **iPhone 7 Plus（A10 = arm64）+ iOS 15.8.3 在支持范围内**。
  ⚠️ 注意 [Dopamine `main` 分支 README](https://raw.githubusercontent.com/opa334/Dopamine/main/README.md) 是**旧的**：`Rootless arm64e jailbreak for iOS 15.0 - 15.4.1`。`main` 与 `2.x` 内容不同，别被 main 误导。
- `[实测]`（Apple Wiki）其它相关：palera1n 覆盖 A8-A11 / iOS 15.0+；meowbrek2 覆盖 A8-A11 / iOS 15.0-15.8.1。ElleKit 支持 iOS 15-27 (arm64) 与 iOS 15-17 (arm64e)。
- `[文档明确]` **arm64e 与部署版本**（[theos.dev/docs/arm64e-deployment](https://theos.dev/docs/arm64e-deployment)）：arm64e = armv8.3 + 指针认证，Apple 视为私有；**iOS 14.0 + Xcode 12.0（clang ≥ 12.0.0）起 arm64e ABI 变更，新编译器产物与 iOS 12.0–13.7 的 arm64e 不兼容**。Theos 会告警：
  `Warning: Building for iOS 7.0, but the current toolchain can't produce arm64e binaries for iOS earlier than 14.0.`
  → 本项目部署版本 15.0 ≥ 14.0，**该问题不存在**。（A10 设备本身也只会加载 arm64 slice。）
- `[文档明确]`（Apple Wiki Dev:Theos）`arm64e devices in most cases can run arm64 binaries. PreferenceLoader, however, cannot typically load arm64 bundles on arm64e devices.` → 如果你后面做**偏好设置面板**（PreferenceLoader bundle）给 A12+ 用户用，bundle 要单独出 arm64e `[推测：由该句直推]`。

## 4.2 `UIScreen` 各属性语义（官方原文）

`[文档明确]`（来源：`https://developer.apple.com/tutorials/data/documentation/uikit/uiscreen/<sym>.json`，2026 抓取）

| 符号 | 起始版本 | 官方原文 |
|---|---|---|
| `UIScreen.bounds` | iOS 4.0+ | `The bounding rectangle of the screen, measured in points.` |
| `UIScreen.scale` | iOS 4.0+ | `The natural scale factor associated with the screen.` 讨论原文：`This value reflects the scale factor needed to convert from the default logical coordinate space into the device coordinate space of this screen. The default logical coordinate space is measured using points. For Retina displays, the scale factor may be 2.0 or 3.0 and one point can be represented by nine or four pixels respectively. For standard-resolution displays, the scale factor is 1.0 and one point equals one pixel.` |
| `UIScreen.nativeBounds` | iOS 8.0+ | `The bounding rectangle of the physical screen, measured in pixels.` 讨论原文：`This rectangle is based on the device in a portrait-up orientation. This value does not change as the device rotates.` |
| `UIScreen.nativeScale` | iOS 8.0+ | `The native scale factor for the physical screen.`（**官方没有 discussion 文本**） |
| `UIScreen.mainScreen` | iOS 2.0+，**iOS 26.0 起 DEPRECATED** | `Returns the screen object representing the device's screen.` |
| `UIWindowScene.screen` | iOS 13.0+（未弃用） | `The screen that displays the contents of the scene.` |
| `UITraitCollection.displayScale` | iOS 8.0+ | `The display scale of the trait collection.` |

`[文档明确]` 归档文档 [Display](https://developer.apple.com/library/archive/documentation/DeviceInformation/Reference/iOSDeviceCompatibility/Displays/Displays.html) 的**权威数值表**（节选）：

| 设备 | 原生分辨率(px) | UIKit 尺寸(pt) | Native Scale | UIKit Scale |
|---|---|---|---|---|
| iPhone 7 Plus | **1080 x 1920** | **414 x 736** | **2.608** | **3.0** |
| iPhone 6s Plus | 1080 x 1920 | 414 x 736 | 2.608 | 3.0 |
| iPhone 7 / 6s / 6 | 750 x 1334 | 375 x 667 | 2.0 | 2.0 |
| iPhone SE (1st) | 640 x 1136 | 320 x 568 | 2.0 | 2.0 |
| iPad Pro 12.9" (2nd) | 2048 x 2732 | 1024 x 1366 | 2.0 | 2.0 |

同页两段关键原文：
> `At runtime, use the bounds and scale properties of a UIScreen object to understand how UIKit present the display to your app, and the nativeBounds and nativeScale when you need to work with the exact number of pixels on the display. If the native scale differs from the UIKit scale factor, then iOS first renders the content at the UIKit scale factor and then scales it to fit into the native number of pixels on the screen.`
> `... iOS first renders any content at the UIKit scale factor and then **downsamples** it to fit on the screen. For games and other apps that perform many calculations per pixel, rendering these additional pixels can be expensive.`

**由此得出的硬结论**：

- iPhone 7 Plus（默认显示模式）：`bounds.size = 414×736 pt`、`scale = 3.0`、`nativeBounds = 1080×1920`、`nativeScale = 2.608`。
- 「414×736 @3x = **1242×2208**」是 **UIKit 渲染缓冲区**尺寸（`bounds.size × scale`），**`nativeBounds` 不是这个值**（`nativeBounds` = 1080×1920）。系统会把 1242×2208 下采样到 1080×1920。
- 你问的「iPhone X 系列 1125×2436」：`1125×2436` 是 iPhone X 的 `nativeBounds`，其 `bounds` = 375×812、`scale` = 3.0 → 渲染缓冲区也是 1125×2436（**X 系列不做下采样**，nativeScale = scale = 3.0）。iPhone XS Max / 11 Pro Max 是 1242×2688（bounds 414×896 @3x，同样不下采样）。`[文档明确]`（X/XS Max 的数值来自归档表；该归档表未列 X 之后的机型，X 的 1125×2436 我是从『bounds×scale = nativeBounds』一致性与设备常识推出的 `[推测]`，**建议以你自己设备上打印的 `nativeBounds` 为准**。）

## 4.3 显示缩放（Display Zoom / 放大模式）怎么检测

`[文档明确]` 归档表同一机型会出现**两行**（例如 Plus 机型既有 414×736 也有 375×667；iPhone 6/6s/7 既有 375×667 也有 320×568）→ **`bounds`/`scale` 随显示缩放模式变化，而面板像素（`nativeBounds`）不变**。这就是「显示缩放」在 API 层的表现。

**推荐做法（不依赖任何未文档化的数值）**：

```objc
UIScreen *s = UIScreen.mainScreen;                  // iOS 26 起 deprecated，可用 UIWindowScene.screen 替代
CGSize  ptSize  = s.bounds.size;                    // 逻辑点
CGFloat uiScale = s.scale;                          // UIKit scale
CGSize  renderPx = CGSizeMake(ptSize.width  * uiScale,
                              ptSize.height * uiScale);   // 「UIKit 渲染像素」= 7+ 的 1242x2208
CGRect  nativePx = s.nativeBounds;                  // 面板物理像素 = 7+ 的 1080x1920
CGFloat nativeScale = s.nativeScale;                // 7+ 的 2.608
BOOL downsampled = fabs(nativeScale - uiScale) > 0.001;   // 是否发生下采样/放大
NSLog(@"[AutoMatcher] pt=%.0fx%.0f uiScale=%.3f render=%.0fx%.0f native=%.0fx%.0f nativeScale=%.3f downsampled=%d",
      ptSize.width, ptSize.height, uiScale,
      renderPx.width, renderPx.height,
      nativePx.size.width, nativePx.size.height, nativeScale, downsampled);
```

**回答「`.`auto` 里的绝对像素矩形怎么回放」这个问题，正确姿势不是选一个 API，而是做归一化**：

1. `.auto` 文件是 ZIP，里面有 JSON。**在 JSON 里记录录制时的参考分辨率**（`referenceWidth` / `referenceHeight`）以及它是哪一类像素（UIKit 渲染像素 or 面板像素）。匹配时：
   ```objc
   CGFloat sx = currentRenderPx.width  / (CGFloat)referenceWidth;
   CGFloat sy = currentRenderPx.height / (CGFloat)referenceHeight;
   CGRect  rectInCurrent = CGRectMake(r.origin.x * sx, r.origin.y * sy,
                                      r.size.width * sx, r.size.height * sy);
   ```
2. **截屏得到的 buffer 是哪个坐标系，就用哪个坐标系做匹配**，不要混。`[推测]`：用 `UIGraphicsBeginImageContextWithOptions(screen.bounds.size, NO, screen.scale)` + `drawViewHierarchyInRect:` 拿到的是 **1242×2208**（UIKit 渲染像素）；直接抓 framebuffer/IOSurface 拿到的是 **1080×1920**（面板像素）。二者的比例 1080/1242 ≈ 0.869 —— **搞错坐标系会导致匹配整体偏移、完全对不上**，这是本项目最容易踩的坑。
3. 若必须固定到某一个坐标系：**推荐统一到 `bounds.size × scale`（UIKit 渲染像素）**，因为它对显示缩放模式敏感这一点恰好与「UIKit 布局」一致；而 `nativeBounds` 虽然恒定，但它对应的 framebuffer 与你用 UIKit 截图拿到的 buffer 尺寸不同。

`[未核实]`（重要）：**我没能找到任何一手来源说明「启用显示缩放后 `nativeScale` 的具体数值」**（例如 7 Plus 放大模式下 `nativeScale` 是 2.88 还是仍为 2.608）。官方对 `nativeScale` 只有一句 `The native scale factor for the physical screen.`，无 discussion。因此**不要拿 `nativeScale` 的绝对值做判断依据**，用上文的「比值归一化」方案。另外 `UIScreen.mainScreen` 自 iOS 26 起 deprecated，虽然本报告目标（iOS 15~18）不受影响，但建议用 `UIWindowScene.screen`（iOS 13+）以免将来迁移。

## 4.4 其它兼容性提醒

- `[文档明确]` **iOS 15.0+ 要求 DER 编码 entitlements**（Apple Wiki Dev:Updating extensions for iOS 15/16）→ 用 Procursus 版 ldid（§3.1）。
- `[文档明确]` **rootful 包不能装到 rootless 设备，反之亦然**（同一来源）；自建源要在 `Release` 里声明 `Architecture: iphoneos-arm iphoneos-arm64`。
- `[文档明确]` rootless 下**所有文件必须位于 `/var/jb` 下**，否则非越狱状态下可能被越狱检测命中（Theos 已自动处理，你只要别在代码里硬编码 `/Library/...` 之类的绝对路径）。
- `[文档明确]` `/var/jb` 是指向 `/private/preboot/$boot-manifest-hash$/procursus` 的符号链接（绕开 `/var` 不可执行的 sandbox 规则 + 便于快速移除以规避越狱检测）。
- `[实测]` Cydia 不支持 rootless；Sileo 自 2.4.2、Zebra 自 1.1.29 起完整支持多架构。
- `[文档明确]` 镜像 / CI 上**不要**依赖 `macos-13`：runner-images 已把 macOS 14 标为 deprecated，可用列表以 README 为准；ElleKit 的 CI 里写死的 `runs-on: macos-13` 属于历史写法 `[推测]`。

---

# 5. 我检索不到可靠证据的点（明确列出，不要采信任何编造）

1. **过滤器 plist 的 `Mode` 键**：Theos 文档、Apple Wiki、三个真实仓库（YTUHD / BHTwitter / Choicy）里**都没有出现**。也没有找到 `CoreFoundationVersion` 等老式键的权威说明。→ 只用 `Filter = { Bundles/Executables/Classes }`。
2. **显示缩放（Display Zoom）下 `nativeScale` 的确切数值**：Apple 归档文档只给出默认配置的数值，`nativeScale` 官方无 discussion。→ 用 §4.3 的比值归一化。
3. **iPhone X 及之后机型（X/XS/XS Max/11/12/…）的官方 nativeBounds 表**：Apple 归档文档停在 iPhone 7 / iPad Pro 2 那一代，没有后续机型。我在报告里给出的一致性推导标了 `[推测]`。
4. **Sideloadly / AltStore 关于「嵌套 dylib 是否必须一起签名」的官方明文**：Sideloadly FAQ 只承认"会自动尝试改写注入文件以支持非越狱设备，但不保证"，没有签名要求说明。AltStore FAQ 我没能定位到相关条目。
5. **DER entitlements 对应的确切 ldid 版本/commit**：ProcursusTeam/ldid 的 manpage HISTORY 完全没提 DER；「需 ldid ≥ 2.1.5-procursus3」只有 Apple Wiki 一个社区来源；`brew install ldid-procursus` 当前装的是 `2.1.5-procursus7`。
6. **`codesign --deep` 对 iOS `.app` 只签主二进制这一条在 Sideloadly 实际行为里的后果**：手册说的是 codesign 的行为，Sideloadly 内部如何签嵌套 dylib 没有公开文档。
7. **`theos/sdks` 中字母序 N 之后的私有框架是否齐全**（GitHub tree 列表 1000 条截断）：`SpringBoardServices.framework`、`UIKitServices.framework` 等我未能逐一验证。`IOSurface` / `BackBoardServices` / `GraphicsServices` / `FrontBoardServices` 已验证存在。
8. **`macos-latest` 镜像是否自带 `xz`/`lzma`**：镜像工具清单里没有列出；不能 100% 排除系统自带 `/usr/bin/xz`（`brew install xz` 是零风险的保险做法）。
9. **定时截屏在越狱环境下的推荐实现**（IOSurface vs CARenderServerRenderDisplay vs UIKit 截图）：本次没有核实到任何权威来源，本报告不给结论。
10. **`.auto` 文件内部 JSON 记录的坐标系约定**：这是你们自己的文件格式，我无从核实；但 §4.3 的归一化方案不依赖它——**请务必在 JSON 里补上录制分辨率字段**。
11. **Theos 对 `.metal` 的官方支持态度**：我只核到"没有 `.metal` 编译规则"，没找到官方声明。
12. **arm64e slice 在 Dopamine arm64 设备上的实际行为**（是否被 dyld 忽略、ElleKit 是否会给 arm64 设备加载 arm64e 镜像）：未能核实。保险做法是给 iPhone 7 Plus 单独出 `ARCHS = arm64`。

---

# 附录 A：本次核实用到的关键来源清单

| 主题 | 来源 | 类型 |
|---|---|---|
| rootless 概念与包架构 | https://theos.dev/docs/rootless | 官方文档 |
| rootless 源码实现 | Theos master `vendor/mod/rootless/{package.mk,package/deb.mk,instance/{rules,library,framework}.mk}` | 源码 |
| 打包/路径改写 | Theos master `makefiles/{common.mk,stage.mk,package.mk,package/deb.mk,master/rules.mk}` | 源码 |
| 编译规则/框架链接 | Theos master `makefiles/instance/rules.mk`、`makefiles/targets/_common/darwin_{head,tail}.mk` | 源码 |
| control 字段规范 | https://theos.dev/docs/packaging | 官方文档 |
| 变量清单 | https://theos.dev/docs/variables | 官方文档 |
| dm.pl | https://theos.dev/docs/dm.pl + https://github.com/theos/dm.pl | 官方文档/源码 |
| arm64e 部署 | https://theos.dev/docs/arm64e-deployment | 官方文档 |
| Swift 支持 | https://theos.dev/docs/swift | 官方文档 |
| 模板 | https://github.com/theos/templates | 官方仓库 |
| rootless.h | https://github.com/theos/headers/blob/master/rootless.h | 官方仓库 |
| 打补丁 SDK | https://github.com/theos/sdks | 官方仓库 |
| 包定义范例 / Provides | https://raw.githubusercontent.com/evelyneee/ellekit/main/packaging/control | 真实仓库 |
| 双 deb 构建范例 | https://raw.githubusercontent.com/evelyneee/ellekit/main/Makefile | 真实仓库 |
| SIDELOAD 开关范例 | https://raw.githubusercontent.com/PoomSmart/YTUHD/master/Makefile | 真实仓库 |
| 框架/私有框架范例 | https://github.com/BandarHL/BHTwitter（Makefile） | 真实仓库 |
| 过滤器 plist 范例 | YTUHD / BHTwitter / Choicy | 真实仓库 |
| Dopamine 支持矩阵 | https://raw.githubusercontent.com/opa334/Dopamine/2.x/README.md | 真实仓库 |
| runner 镜像 | https://github.com/actions/runner-images（`images/macos/macos-26-arm64-Readme.md`） | 官方仓库 |
| ldid formula | https://formulae.brew.sh/formula/ldid、/formula/ldid-procursus | 实测 |
| ldid 手册 | https://github.com/ProcursusTeam/ldid/blob/main/docs/ldid.1 | 官方手册 |
| codesign 手册 | https://keith.github.io/xcode-man-pages/codesign.1.html | 官方手册 |
| ld 手册 | https://keith.github.io/xcode-man-pages/ld.1.html | 官方手册 |
| Sideloadly FAQ | https://sideloadly.io/faq | 官方 FAQ |
| insert_dylib | https://github.com/Tyilo/insert_dylib | 真实仓库 |
| NEON | https://developer.android.com/ndk/guides/cpu-arm-neon | 官方文档（异平台） |
| 屏幕数值表 | https://developer.apple.com/library/archive/documentation/DeviceInformation/Reference/iOSDeviceCompatibility/Displays/Displays.html | Apple 归档文档 |
| UIScreen API | https://developer.apple.com/documentation/uikit/uiscreen | Apple 文档（JSON 端点） |
| 设备分辨率（第三方） | https://www.ios-resolution.com/ | 第三方 |
| rootless 生态事实 | theapplewiki.com `Rootless` / `Dev:Packaging` / `Dev:Updating_extensions_for_iOS_15/16` / `ElleKit` / `Dopamine`（经 api.php 获取 wikitext） | 社区 wiki |

# 附录 B：iPhone 7 Plus 的坐标速查

| 量 | 值 | 来源 |
|---|---|---|
| `bounds.size`（默认显示模式） | 414 × 736 pt | Apple 归档表 `[文档明确]` |
| `scale` | 3.0 | Apple 归档表 `[文档明确]` |
| `bounds.size × scale`（UIKit 渲染缓冲区） | **1242 × 2208 px** | 计算值 `[文档明确]`（公式来自官方讨论） |
| `nativeBounds.size`（面板物理像素） | **1080 × 1920 px** | Apple 归档表 `[文档明确]` |
| `nativeScale` | **2.608** | Apple 归档表 `[文档明确]` |
| 是否下采样 | 是（1242×2208 → 1080×1920） | Apple 归档讨论原文 `[文档明确]` |
| 放大模式（Display Zoom）下的 `bounds` | 375 × 667 pt | Apple 归档表同行机型 `[文档明确]` |
| 放大模式下的 `nativeScale` | **未核实** | — |
| 能否跑 arm64e | 不能（A10 无 PAC） | ARM 架构事实 `[文档明确]` |
