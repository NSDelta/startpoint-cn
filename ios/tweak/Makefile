# SpLogin —— StarPoint CN 私服 iOS 登录 UI（P10-B「dylib 注入」主线）
#
# 地址一律在**构建期注入**，仓库里只允许出现 hygiene 白名单占位 192.168.1.10:8001
# （scripts/check-hygiene.sh:19-23 会拦 192.168.x.x，唯一白名单是 192.168.1.10）。
# 真机联调时把真实地址写在命令行上，不要写进任何仓库文件：
#
#     make package FINALPACKAGE=1 SP_LOGIN_HOST=<你的局域网 IP>:8001
#
# rootless（Dopamine / iOS 15.8.3，iPhone 7 Plus）：
#
#     make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless SP_LOGIN_HOST=<...>
#
# 本机（Windows）没有 make/clang/ldid，编译只能在 CI 或 macOS 上做 —— 见 ios/tweak/README.md。

TARGET = iphone:clang:latest:14.0
ARCHS = arm64

# 缺省值 = hygiene 白名单占位，不是任何真实机器
SP_LOGIN_HOST ?= 192.168.1.10:8001

# 数据转发开关（决定这个包是不是「只加登录」）：
#   1（缺省，现状）= dylib 内 NSURLProtocol 把官方域名请求改写到 SP_LOGIN_HOST；
#   0             = **编译期剔除** SpLoginURLProtocol.m —— 包内不含任何网络改写，
#                    端点转发交给 IPA 侧静态改写（client-patch/build/patch-ipa.mjs --endpoint=rewrite）。
# 注意：即使为 0，SP_LOGIN_HOST 仍必须给对 —— 登录面板自身要 POST /sp-auth/*，
#       且它应当与 IPA 打补丁时用的 --host 指向同一台机器。
SP_LOGIN_FORWARDING ?= 1

include $(THEOS)/makefiles/common.mk

LIBRARY_NAME = SpLogin

SpLogin_FILES = Tweak.xm \
		SpLoginConfig.m \
		SpLoginAPI.m \
		SpLoginTheme.m \
		SpLoginOverlay.m \
		SpLoginViewController.m

ifeq ($(SP_LOGIN_FORWARDING),1)
SpLogin_FILES += SpLoginURLProtocol.m
endif

SpLogin_FRAMEWORKS = UIKit Foundation
SpLogin_CFLAGS = -fobjc-arc -DSP_LOGIN_HOST=@\"$(SP_LOGIN_HOST)\" -DSP_LOGIN_FORWARDING=$(SP_LOGIN_FORWARDING)
SpLogin_LDFLAGS = -Wl,-U,_objc_msgSend
SpLogin_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

include $(THEOS_MAKE_PATH)/library.mk
