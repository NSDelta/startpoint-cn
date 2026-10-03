#
# 越狱版（deb）—— rootless，iPhone 7 Plus / iOS 15.8.3
#
# 构建：
#   make clean && make package                     # rootless（var/jb）
#   make clean && make package SCHEME=             # 想同时出 rootful 时用这个
#
# 为什么 ARCHS 只有 arm64：A11（iPhone 7 Plus 是 A10）及以后的设备一律 arm64；
# arm64e 需要单独签名链，rootless 环境里没必要。iPhone 7 是 A10 Fusion，
# 是 64 位的，能跑。
#

# SDK 版本**不写死**，从系统里探测（见下方 SDKVER）。
#
# 曾经写死 16.5，理由见 .research/ios-theos-report.md §4：不想让 latest 跟着 Xcode 升，
# 免得某天新版 SDK 改了私有 API 的可用性或 C 语言默认标准，构建在我们完全没改动时失败。
# 这个理由本身没错，但它在真实 CI 上被反噬了：
#
#   ==> Error: Your chosen SDK, "iPhoneOS16.5.sdk", does not appear to exist.
#   make: *** [before-all] Error 1
#
# GitHub 的 macos-latest 上装的 Xcode 不带 16.5 的 SDK，而 Theos 只报一行错就退出。
# **硬编码一个 SDK 版本 = 把「能不能构建」绑死在 runner 镜像上**，比 SDK 漂移更危险。
#
# 所以：探测本机装了哪个 iPhoneOS SDK，用其中最高的那个。没有 xcodebuild 或探测
# 失败时保持空 —— Theos 会去用默认 SDK（这条路径没有实测过，所以下面会把它回显出来，
# 让 CI 日志里能直接看到实际选了什么）。
SDKVER := $(shell xcodebuild -showsdks 2>/dev/null | sed -n 's/.*-sdk iphoneos\([0-9][0-9.]*\)$$/\1/p' | sort -V | tail -1)
TARGET = iphone:clang:$(SDKVER):15.0
$(info [AMAutoClick] xcodebuild -showsdks 选出的 iPhoneOS SDK = "$(SDKVER)"，TARGET = $(TARGET))

# 部署目标下界 15.0，因为 AMControlPanel 用了 monospacedSystemFontOfSize:weight:（iOS 13+）
# 与 UIWindowScene（iOS 13+）；设备是 15.8.3，留 15.0 的余量给别的机型。
ARCHS = arm64

include $(THEOS)/makefiles/common.mk

LIBRARY_NAME = AMAutoClick
# ★ 必须同时声明 TWEAK_NAME：本工程 include 的是 tweak.mk（不是 library.mk），
# tweak.mk 靠 TWEAK_NAME 决定要对哪个实例做 all/stage。
TWEAK_NAME = AMAutoClick

# 路径一律写成 $(THEOS_PROJECT_DIR)/../… 而不是 ../…
# 理由：Theos 把相对 _FILES 解析到**项目目录**（THEOS_PROJECT_DIR），不是 Makefile 所在
# 目录；用 $(THEOS_PROJECT_DIR) 显式锚定后，`make -C tweak` 与 `cd tweak && make`
# 结果一致，也不会因为将来把 Makefile 挪进子目录而突然找不到源码。
AMAutoClick_FILES = \
	Tweak.x \
	$(THEOS_PROJECT_DIR)/../ios/AMRuntime.m \
	$(THEOS_PROJECT_DIR)/../ios/AMCapture.m \
	$(THEOS_PROJECT_DIR)/../ios/AMTouch.m \
	$(THEOS_PROJECT_DIR)/../ios/AMConfig.m \
	$(THEOS_PROJECT_DIR)/../ios/AMControlPanel.m \
	$(THEOS_PROJECT_DIR)/../core/auto_engine.c \
	$(THEOS_PROJECT_DIR)/../core/auto_script.c \
	$(THEOS_PROJECT_DIR)/../core/auto_match.c \
	$(THEOS_PROJECT_DIR)/../core/am_fft.c \
	$(THEOS_PROJECT_DIR)/../core/am_fft_accel.c \
	$(THEOS_PROJECT_DIR)/../core/am_json.c \
	$(THEOS_PROJECT_DIR)/../core/am_container.c

# core/ 是纯 C99、零平台依赖；.m 用 ARC。
# -I 同样锚定，让 #include "auto_engine.h" 这种写法成立（AMRuntime.m 里就是这么写的）。
# AM_FFT_ACCELERATE：打开 am_fft_accel.c 里的 Accelerate/vDSP 分支。
#   不开的话它整段退化成空实现（仍然能编、能跑，只是全程标量）。
#   实测标量 C 在 Windows/MSVC 上比 .auto 的 loop_interval = 30 ms 慢 4.26 倍
#   （9 个真实裁切搜索合计 676 ms），A10 只会更慢，所以 iOS 侧必须开。
AMAutoClick_CFLAGS = -fobjc-arc -DAM_FFT_ACCELERATE=1 \
	-I$(THEOS_PROJECT_DIR)/../core -I$(THEOS_PROJECT_DIR)/../ios

AMAutoClick_FRAMEWORKS = UIKit Foundation CoreGraphics
# OpenGLES 用 dlopen/dlsym 拿（见 AMCapture.m），不硬链 —— 硬链会让
# 某些越狱环境的 dyld 在做 fixup 时提前解析符号，反而更脆。
# Accelerate 反过来**要**硬链：它在 iOS 上是公开框架、必然存在，而且 vDSP 是热
# 路径，用 dlsym 拿一堆函数指针只会把它搞慢。（写成 LDFLAGS 而不是
# _PRIVATE_FRAMEWORKS —— 后者是给私有框架用的，Accelerate 是公开框架。）
AMAutoClick_LIBRARIES = z
# 必须手动加：我们调的都是 UIKit 私有 selector（_touchesEvent 等），
# 它们在链接期不存在符号，让链接器别抱怨。
AMAutoClick_LDFLAGS = -Wl,-U,_objc_msgSend -undefined dynamic_lookup -framework Accelerate

# rootless 下 Theos 会在打包阶段把它搬到 /var/jb/Library/...
# 这里写"经典路径"，让 scheme 去做前缀 —— 手写 /var/jb 会在 rootful 构建时错。
AMAutoClick_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

# ★★ 必须是 tweak.mk，不能是 library.mk —— 这是第 11 次 CI 用「deb 里没有过滤器 plist」
# 换来的教训。机制（逐字读了 Theos 的 makefiles）：
#   顶层 tweak.mk  →  master/tweak.mk（认 TWEAK_NAME）  →  instance/tweak.mk
#   顶层 library.mk →  master/library.mk（认 LIBRARY_NAME）→ instance/library.mk
# 只有 instance/tweak.mk 里有那四条把过滤器 plist 拷进 staging 的规则：
#   cp "$(THEOS_CURRENT_INSTANCE).plist" "$(THEOS_STAGING_DIR)$(LOCAL_INSTALL_PATH)/…"
#   找不到 plist 时它还会直接报错 "You are missing a filter property list"。
# 用 library.mk 的后果是：构建成功、deb 也出得来，但里面**只有 dylib 没有 plist**，
# 而 substrate 没有过滤器就不知道往哪个进程注入 —— 属于「装上了什么都不发生」。
# 这种失败在 CI 上只剩一条 grep 失败，在真机上则完全没有提示，所以务必保持 tweak.mk。
include $(THEOS_MAKE_PATH)/tweak.mk
