#
# 非越狱版（dylib）—— 注入单个应用后侧载
#
# 构建：
#   make clean && make            # 产出 .theos/obj/AMAutoClick.dylib
#   make package                  # 也会打个 deb（用不上，但省得 Theos 报错）
#
# 与 tweak/Makefile 的三处差别，都是有原因的：
#   1. 多编译 dylib.x（无 substrate 版入口），不编 Tweak.x；
#   2. **不链 substrate**，也没有「安装到 /Library/MobileSubstrate」这一步 ——
#      产物是被 ios/auto/dylib/tools/inject-dylib.mjs 塞进 app 包的
#      Frameworks/ 里，靠 LC_LOAD_DYLIB 载入；
#   3. THEOS_PACKAGE_SCHEME 无关紧要（不装 deb），但 TARGET 的下界仍写 15.0。
#

TARGET = iphone:clang:16.5:15.0
ARCHS  = arm64

include $(THEOS)/makefiles/common.mk

LIBRARY_NAME = AMAutoClick

# 路径锚定到 $(THEOS_PROJECT_DIR)，理由同 tweak/Makefile。
AMAutoClick_FILES = \
	dylib.x \
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

AMAutoClick_CFLAGS = -fobjc-arc -I$(THEOS_PROJECT_DIR)/../core -I$(THEOS_PROJECT_DIR)/../ios
AMAutoClick_FRAMEWORKS = UIKit Foundation CoreGraphics
AMAutoClick_LIBRARIES = z

#
# -undefined dynamic_lookup 是**必须**的：
#   我们调 UIKit / IOKit 的私有 selector 与私有函数（_touchesEvent、
#   IOHIDEventCreateDigitizerEvent、glReadPixels 之外的 EAGL 私有物等）。
#   这些东西在链接期没有符号可解析，不加这个开关链接器直接报错。
#
# ⚠️ 不要加 -Wl,-U,_objc_msgSend：那是给 tweak 用的老写法，dylib 里
#    动态查找已经足够，多一个 -U 只会掩盖真正的未定义符号。
#
AMAutoClick_LDFLAGS = -undefined dynamic_lookup

include $(THEOS_MAKE_PATH)/library.mk
