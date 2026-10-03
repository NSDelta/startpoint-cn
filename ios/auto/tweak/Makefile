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

# ★ 不要用 latest。写死 16.5，理由见 .research/ios-theos-report.md §4：
#   latest 会跟着 Xcode 升，某天新版 SDK 改了私有 API 的可用性或 C 语言默认标准，
#   构建会在我们完全没改动的时候失败 —— 那种失败最难定位。
TARGET = iphone:clang:16.5:15.0

# 部署目标下界 15.0，因为 AMControlPanel 用了 monospacedSystemFontOfSize:weight:（iOS 13+）
# 与 UIWindowScene（iOS 13+）；设备是 15.8.3，留 15.0 的余量给别的机型。
ARCHS = arm64

include $(THEOS)/makefiles/common.mk

LIBRARY_NAME = AMAutoClick

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
	$(THEOS_PROJECT_DIR)/../core/am_json.c \
	$(THEOS_PROJECT_DIR)/../core/am_container.c

# core/ 是纯 C99、零平台依赖；.m 用 ARC。
# -I 同样锚定，让 #include "auto_engine.h" 这种写法成立（AMRuntime.m 里就是这么写的）。
AMAutoClick_CFLAGS = -fobjc-arc -I$(THEOS_PROJECT_DIR)/../core -I$(THEOS_PROJECT_DIR)/../ios

AMAutoClick_FRAMEWORKS = UIKit Foundation CoreGraphics
# OpenGLES 用 dlopen/dlsym 拿（见 AMCapture.m），不硬链 —— 硬链会让
# 某些越狱环境的 dyld 在做 fixup 时提前解析符号，反而更脆。
AMAutoClick_LIBRARIES = z
# 必须手动加：我们调的都是 UIKit 私有 selector（_touchesEvent 等），
# 它们在链接期不存在符号，让链接器别抱怨。
AMAutoClick_LDFLAGS = -Wl,-U,_objc_msgSend -undefined dynamic_lookup

# rootless 下 Theos 会在打包阶段把它搬到 /var/jb/Library/...
# 这里写"经典路径"，让 scheme 去做前缀 —— 手写 /var/jb 会在 rootful 构建时错。
AMAutoClick_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

include $(THEOS_MAKE_PATH)/library.mk
