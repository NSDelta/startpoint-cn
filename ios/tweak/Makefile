# SpLogin —— StarPoint CN 私服 iOS 登录 UI
#
# ══════════════════════════════════════════════════════════════════════════════
# 这个 dylib 的目标用法：**非越狱设备**上自己签名、自己把 dylib 注入进 IPA。
#
# ⇒ 只有**一份**构建，不按 rootful / rootless 分叉。
#    不要加 THEOS_PACKAGE_SCHEME=rootless，也不要为手机是否越狱做两份产物：
#    越狱布局（/var/jb、MobileSubstrate 目录）不该出现在这个 dylib 的任何路径假设里。
#    代码侧同样遵守：配置/日志/取证全部落在**沙盒内**（Documents / 主包 / tmp），
#    见 SpLoginConfig.m 的 sp_firstExistingPreferencePath 与 prepareLogFile。
#
# ⇒ 不做 URL 重定向（SP_LOGIN_FORWARDING 缺省 = 0）：网络改写交给 IPA 侧静态改写，
#    这个 dylib 只负责登录 UI。
# ══════════════════════════════════════════════════════════════════════════════
#
# 地址一律在**构建期注入**，仓库里只允许出现 hygiene 白名单占位 192.168.1.10:8001
# （scripts/check-hygiene.sh:19-23 会拦 192.168.x.x，唯一白名单是 192.168.1.10）。
# 真机联调时把真实地址写在命令行上，不要写进任何仓库文件：
#
#     make package FINALPACKAGE=1 SP_LOGIN_HOST=<你的局域网 IP>:8001
#
# ⚠️ 仓库是**公开**的：真实局域网地址一旦作为 CI 输入传进去，会落进
#    `ci-out/<run>/<leg>/meta.txt` 与 Actions 日志。CI 只用占位地址，
#    真实地址在本机离线烧进二进制（ios/tweak/README.md 与交付说明里的 bake-host.cjs）。
#
# 本机（Windows）没有 make/clang/ldid，编译只能在 CI 或 macOS 上做 —— 见 ios/tweak/README.md。

TARGET = iphone:clang:latest:14.0
ARCHS = arm64

# 缺省值 = hygiene 白名单占位，不是任何真实机器
SP_LOGIN_HOST ?= 192.168.1.10:8001

# URL 重定向开关（决定这个包是不是「只加登录」）：
#   0（**缺省**）  = **编译期剔除** SpLoginURLProtocol.m —— 包内不含任何网络改写，
#                   端点转发交给 IPA 侧静态改写（client-patch/build/patch-ipa.mjs --endpoint=rewrite）。
#   1             = dylib 内 NSURLProtocol 把官方域名请求改写到 SP_LOGIN_HOST（历史行为，
#                   只给「不想改 IPA、只想装个 dylib」的越狱场景留的后路）。
#
# 为什么缺省改成 0：这个 dylib 面向的是自签注入 IPA 的场景，那边已经有 IPA 侧静态改写；
# 两层改写叠在一起，出问题时无法判断是哪一层干的。
#
# 注意：即使为 0，SP_LOGIN_HOST 仍必须给对 —— 登录面板自身要 POST /sp-auth/*，
#       且它应当与 IPA 打补丁时用的 --host 指向同一台机器。
SP_LOGIN_FORWARDING ?= 0

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

# 只影响 deb 的安装路径与 dylib 的 LC_ID_DYLIB。**对注入没有影响**：
# 注入器是往主二进制里加 LC_LOAD_DYLIB 指到我们放 dylib 的位置，
# 这个 dylib 自己的 install name 不参与那条加载路径的解析。
# 之所以不改成 @rpath：那样 deb 会把文件装到一个字面量叫 "@rpath" 的目录里。
SpLogin_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

include $(THEOS_MAKE_PATH)/library.mk
