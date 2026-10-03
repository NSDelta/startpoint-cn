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

# SDK 版本不写死，从系统里探测 —— 与 tweak/Makefile 同一条理由，注释写在那一边：
# 写死 16.5 会让 CI 直接报 “Your chosen SDK, "iPhoneOS16.5.sdk", does not appear to exist.”
# 而 GitHub 的 macos-latest 上装的 Xcode 并不带 16.5 的 SDK。
SDKVER := $(shell xcodebuild -showsdks 2>/dev/null | sed -n 's/.*-sdk iphoneos\([0-9][0-9.]*\)$$/\1/p' | sort -V | tail -1)
TARGET = iphone:clang:$(SDKVER):15.0
$(info [AMAutoClick] xcodebuild -showsdks 选出的 iPhoneOS SDK = "$(SDKVER)"，TARGET = $(TARGET))
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
	$(THEOS_PROJECT_DIR)/../core/am_fft_accel.c \
	$(THEOS_PROJECT_DIR)/../core/am_json.c \
	$(THEOS_PROJECT_DIR)/../core/am_container.c

# AM_FFT_ACCELERATE 同 tweak/Makefile：打开 Accelerate/vDSP 的 FFT 后端。
# 不开的话 am_fft_accel.c 整段退化成空实现，全程走标量 C —— 实测那个比
# .auto 的 loop_interval = 30 ms 慢 4.26 倍。
AMAutoClick_CFLAGS = -fobjc-arc -DAM_FFT_ACCELERATE=1 \
	-I$(THEOS_PROJECT_DIR)/../core -I$(THEOS_PROJECT_DIR)/../ios
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
# ★ -not_for_dyld_shared_cache 也是**必须**的（第一次真实 CI 才暴露）：
#   Xcode 26 的 ld 在**非 rootless**（rootful）那一条腿上直接失败 ——
#       ld: Shared cache eligible dylibs cannot use '-undefined dynamic_lookup'
#           or '-U' to find symbols. Remove these options or opt out of the
#           shared cache using the build setting 'LD_SHARED_CACHE_ELIGIBLE=NO'
#           (or linker flag '-not_for_dyld_shared_cache')
#       clang: error: linker command failed with exit code 1
#   奇怪但真实的地方：**rootless 腿能过、rootful 腿不能**（两条腿用的是同一个
#   Makefile、同一份源码），说明是否给这个标志取决于 Theos 的 packaging scheme，
#   而不是我们的源码。所以我们自己显式加上，两条腿都稳。
#   语义上也完全正确：这个 dylib 是**被注入进 App 包**的（Frameworks/ 下、靠
#   LC_LOAD_DYLIB 载入），它本来就不该、也不会进 dyld 共享缓存。
#
# ⚠️ 必须写成 -Wl,-not_for_dyld_shared_cache：Theos 这里走的是 clang 驱动，
#    裸写会被 clang 自己拒绝（第二次 CI 换来 `clang: error: unknown argument:
#    '-not_for_dyld_shared_cache'`）。而 `-undefined dynamic_lookup` 是 clang
#   认识的驱动选项，所以它不加 -Wl, 前缀也对 —— 两者写法**不一样**，别统一。
#
AMAutoClick_LDFLAGS = -undefined dynamic_lookup -Wl,-not_for_dyld_shared_cache \
	-framework Accelerate

include $(THEOS_MAKE_PATH)/library.mk
