# ios/auto —— `.auto` 脚本引擎（iOS 自动点击插件的共同内核）

这个目录是 **iOS 自动屏幕点击**两件交付物（越狱 `.deb` + 非越狱注入单应用的 `.dylib`）
的**共同内核**：一个纯 C99、零平台依赖的 `.auto` 脚本解析与执行引擎。

设计与语义依据：`.research/ios-design.md`。

---

## 1. 为什么是纯 C99、零平台依赖

同一个 `core/` 必须同时活在三个地方：

| 宿主 | 用途 | 编译器 |
|---|---|---|
| Windows x64 | **单元测试与语义验证**（本目录的全部测试都在这里跑） | MSVC 2022 `/std:c11` |
| iOS (jailbroken) | `tweak/`（Theos 的 deb） | clang / iPhoneOS SDK |
| iOS (non-jailbroken) | `dylib/`（注入单个 App） | clang / iPhoneOS SDK |

所以 `core/` 里**不允许**出现 `stdio.h` 之外的平台头（`auto_engine.c` 连 `stdio.h` 都没有，
它的头注释写着 "No stdio, no time source, no platform"）。取帧、点击、睡眠、时钟
全部通过 `am_engine_host` 的函数指针注入。**好处是引擎的正确性可以在 Windows 上先证明完，
再上真机。**

---

## 2. 目录

```
core/                 引擎（纯 C99，无平台依赖）
  am_json.[ch]        两趟扫描、零中间 malloc 的 JSON 解析器
  am_container.[ch]   ZIP（stored + deflate）读取 + PNG 解码（只接受 8 位真彩）
  am_fft.[ch]         混合基 / radix-2 FFT（互相关用）
  am_fft_accel.c      FFT 的 Accelerate/vDSP 后端（iOS 性能路径；非 Apple 平台退化成空实现）
  auto_match.[ch]     NCC 模板匹配（FFT 实现），逐位对齐 OpenCV 的 TM_CCOEFF_NORMED
  auto_script.[ch]    .auto 模型层：模板组 / 变量 / 场景 / 条件 / 动作 + 变体选择 + 坐标适配
  auto_engine.[ch]    执行引擎：条件折叠 / 场景派发 / 超时 / 动作执行 / 点击取点

ios/                  平台层（Objective-C，只在 CI 上编译过 —— 本机没有 clang）
  AMCapture.[hm]      hook -[EAGLContext presentRenderbuffer:] 后 glReadPixels 取帧
  AMTouch.[hm]        伪造 UITouch + -[UIApplication _touchesEvent] + sendEvent:
  AMRuntime.[hm]      把 am_engine_host 接到上面两个；脚本发现；引擎线程
  AMConfig.[hm]       部署期配置 + 面板状态（单独 plist，不用 NSUserDefaults）
  AMControlPanel.[hm] 悬浮球 + 控制板（导出当前帧 / 日志 / 启停）

tweak/                交付物①：越狱 deb（Theos）
  Makefile control AMAutoClick.plist Tweak.x
dylib/                交付物②：非越狱注入单个 App 的 dylib（Theos）
  Makefile control dylib.x
  tools/inject-dylib.mjs     插 LC_LOAD_DYLIB + 拷 Frameworks/（不移位，硬断言）
  tools/make-fake-dylib.mjs  造无代码 Mach-O，验证注入器的头部算术

tests/                七套测试（MSVC，见 §3）；build/ 与 decomp/ 都不入库
  test_fft.c          125 例（含 [6] 加速后端一致性 6 例）：与直接 DFT 逐元素对拍 + 卷积定理 + next_fast_size
  test_json.c          84 例：JSON 解析（含畸形输入与错误偏移）
  test_matcher.c       13 例：9 个正样本
  test_matcher_neg.c   18 例：错配峰值上界 0.422071（sim 0.80，余量 0.378）
  test_package.c       21 例：ZIP/PNG 断言 + 17 个真实匹配用例
  test_script.c        56 例：场景/条件/变体选择/坐标适配/点击矩形/ZIP 路径
  test_engine.c        60 例：条件折叠/场景派发/超时/缓存/合成夹具自检
  audit_caps.c        ★ 把真脚本装进引擎，量出每个编译期上限（AM_MAX_*）用了多少 + 溢出计数
  bench_fft.c         FFT 孤立计时（pad 策略的依据）
  bench_pkg.c         9 个真实 crop 搜索区计时
  pg_guard.[ch]       页守护分配器（没有调试器时的越界检测手段）

matcher_golden/       9 个正样本夹具（golden_cases.h + raw/*.bin）
matcher_golden_neg/   18 个负样本夹具（golden_neg_cases.h + raw/*.bin）
matcher_golden_pkg/   sample.auto + pkg/（54 张平铺 PNG + script.json）+ 17 个真实匹配用例
                      ★ **不入库**（真游戏素材，21 MB）：整目录由下面这条命令从真 .auto 重建 ——
                        python tools/make_package_golden.py <你的.auto> matcher_golden_pkg
                      重建后本机可跑全套；CI 上它缺席，只跑 test_fft / test_matcher /
                      test_matcher_neg 三套并打 ::warning::（见 §3 与工作流里的夹具分支）。
sample/               从「幻想连战.auto」解出的 script.json 与结构报告（人读用）
tools/                CI 与夹具工具（python 用 cv2 做参考实现；node/mjs 做各种体检）
  make_*.py                 生成夹具（matcher golden / 负样本 / package golden / bench cases）
  build-and-test-matcher.ps1 本机一键编 + 跑 matcher 两套
  ci-push.mjs               ★ 把 ios/auto 整棵树推成**一个**轻量提交触发 CI（不碰 dev）
  ci-poll.ps1               轮询某个 sha 的 CI 直到结束（PowerShell 5.1，需 BOM）
  lint-workflow.mjs         工作流 YAML 体检 + `--selftest` 阳性对照（5 个变异）
  check-run-shell.mjs       ★ 把每个 `run:` 块喂 `bash -n` + `--selftest`（2 个变异）
  check-test-patterns.mjs   拿真实测试输出核对 CI 里的 grep 模式
  check-objc.mjs            ObjC 结构体检（不是编译器）
  selftest-check-objc.mjs   同上，阳性对照（4 个变异）
  check-plist.sh            过滤器 plist 三级降级校验（0 命中 / 1 用法 / 3 未命中 / 4 解析失败）
  make-hostile-plist.py     造敌意 plist 夹具（`$Binary`、反引号、glob、块标量脱出文本）
  tsan-sanitize.sh          注解通道净化链的自检（含「原样文本确实会炸」的阳性对照）
*.py                  格式逆向与坐标模型的验证脚本（coord_model / extract_auto / verify_format …）
```

**`decomp/`、`apk/`、`vis/`、`tests/build/` 都不入库**（`.gitignore` 覆盖）：
分别是 29.7 MB 的反编译 Java 树、11.8 MB 的 dex 转储、100 MB 的可视化叠图、1.8 MB 的目标文件。
重建方式见 §4。

---

## 3. 构建与测试（Windows / MSVC）

```powershell
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$cf     = "/nologo /W4 /O2 /std:c11 /utf-8 /D_CRT_SECURE_NO_WARNINGS"
$inc    = "/I core /I tests /I matcher_golden /I matcher_golden_neg /I matcher_golden_pkg"
$core   = "core\auto_script.c core\am_json.c core\am_container.c core\auto_match.c core\am_fft.c"

cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_package.exe /Fo:tests\build\ $inc tests\test_package.c $core"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_script.exe  /Fo:tests\build\ $inc tests\test_script.c  $core"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_engine.exe  /Fo:tests\build\ $inc tests\test_engine.c core\auto_engine.c $core"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_fft.exe     /Fo:tests\build\ /I core tests\test_fft.c core\am_fft.c"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_json.exe    /Fo:tests\build\ /I core tests\test_json.c core\am_json.c"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_matcher.exe /Fo:tests\build\ $inc tests\test_matcher.c core\auto_match.c core\am_fft.c core\am_container.c"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_matcher_neg.exe /Fo:tests\build\ $inc tests\test_matcher_neg.c core\auto_match.c core\am_fft.c core\am_container.c"
```

运行（**参数是夹具目录，不是可选的 —— 少传会静默少跑用例**）：

```powershell
tests\build\test_fft.exe          # 125 passed, 0 failed
tests\build\test_json.exe         matcher_golden_pkg       #  84 passed, 0 failed
tests\build\test_matcher.exe      matcher_golden           #  13 passed, 0 failed
tests\build\test_matcher_neg.exe  matcher_golden_neg       #  18 passed, 0 failed
tests\build\test_script.exe       matcher_golden_pkg\pkg   # 56 passed, 0 failed
tests\build\test_package.exe      matcher_golden_pkg       # 21 passed, 0 failed（不是 ...\pkg）
tests\build\test_engine.exe       matcher_golden_pkg\pkg   # 60 passed, 0 failed（★ 少传 \pkg => 36 passed, 1 failed）
```

**合计 377 例，全部 0 failed、零 warning。**

> **`test_fft` 从 119 涨到 125 的原因**：新增 `[6] 加速后端一致性` 段（6 例）。
> 它用**与实现无关的不变量**（零频率分量 == 逐元素和、单位冲激 ⇒ 全 1、
> Parseval、逆→正往返）校验 DFT，所以既能在 Windows 上量标量路径，也能在
> macOS/CI 上量 vDSP 路径 —— 不能拿标量版当参考实现，因为 CI 上标量版
> 根本不会被调用。段尾还有一条断言专门查「Accelerate 可用时是否真走了 vDSP」，
> 忘了加 `-DAM_FFT_ACCELERATE=1` 会让那一整段变成「自己跟自己对」，
> 那条断言会把它抓成 CI 变红。

> **四个坑**：
> ① `golden_cases.h` / `golden_neg_cases.h` / `golden_pkg_cases.h` **不在 `tests\` 里**，
> 而在各自夹具目录 —— 上面 `$inc` 里的三个 `/I` 是承重的。缺了会报 `fatal error C1083`，
> 而**旧的可执行文件不加 `/I` 也能"通过"**（过期二进制）。改完代码务必重新编译。
> ② `D_CRT_SECURE_NO_WARNINGS` 必须走命令行，在源文件里 `#define` 无效
> （`<string.h>` 已被头文件先拉进来）。
> ③ **`test_engine` 必须带 `\pkg`**：它把参数当作存放 `script.json` + 散图的那一层。
> 少传不会崩，而是 **`36 passed, 1 failed`** —— 24 个用例被"目录里没东西"静默跳过。
> **任何"用例数变少"的现象都先怀疑夹具路径，再怀疑代码。**
> ④ 编译过一次之后别忘了 `tests\build\` 是 gitignore 的：换个 shell 可能跑到**旧二进制**。
> 拿不准就先 `Remove-Item -Recurse tests\build`。

工作流里的这些 `"125 passed"` 之类模式可用 `node tools/check-test-patterns.mjs .` 核对
（模式写错会让 CI 的某一格永远通过或永远失败，而在日志里只是一行字）。

### 3.1 iOS 侧（CI）

本机**没有 clang**，所以进 CI 之前先把能在 Windows 上做的检查做掉：

```powershell
node tools\lint-workflow.mjs ..\..\.github\workflows\ios-autoclick.yml --selftest  # 工作流 YAML 体检 + 阳性对照
node tools\check-run-shell.mjs ..\..\.github\workflows\ios-autoclick.yml --selftest # 每个 run 块喂 bash -n
node tools\selftest-check-objc.mjs .   # ★ 先证明检查器自己有效
node tools\check-objc.mjs .            # 再拿它查真代码
```
（第三道 `sh tools/tsan-sanitize.sh` 只在 macOS / Git-bash 下能跑，它验证**注解通道的
净化器**是否还有效 —— 见 §6 里「注解文本会被回灌成 shell」那条。`check-plist.sh`
的回归也在 CI 里跑五例，见下。）

这四道滤网各自负责一类**只有真跑一次才会暴露**的问题：

| 工具 | 抓什么 | 为什么别的工具抓不到 |
|---|---|---|
| `lint-workflow.mjs` | 块标量脱出（内容顶到第 0 列 ⇒ PyYAML 报 `while scanning a simple key`）、顶层键白名单、目录级 `git add`、`${{ }}` 不配对 | PyYAML 对「合法但语义错」的文件不报错 |
| `check-run-shell.mjs` | **YAML 合法但 shell 坏了** —— 例如 `edit` 结尾换行不对称把 `if …; then` 与下一行粘成 `if …; then echo x          while …` | PyYAML 通过、lint 也通过，**只有 `bash -n` 报** |
| `selftest-*.mjs` / `--selftest` | 检查器自己坏了 | 「什么都报不出来」与「代码很干净」在输出上无法区分 |
| `tsan-sanitize.sh` / `check-plist.sh` | 注解回灌、plist 格式/退出码 | 把日志当 shell 源码喂给下游，本机不会复现 |
| `check-test-patterns.mjs` | CI 里 `grep -q "<N> passed"` 的模式写错（会让该步**永远通过**或**永远失败**，在 CI 上只是"一条日志"） | 要跑真实测试才有输出；**且它的阳性结论「0 个不匹配」正是它失配时也会打印的东西** |

`check-objc.mjs` **不是编译器**（不做类型检查），只做三件能在本机抓住的事：
① 结构配平（`@interface`/`@implementation`/`@protocol` 与 `@end`、括号、CRLF）；
② 头里声明的方法在 `.m` 里有没有实现；
③ `@property` 少了分号这类低级错误。
**为什么必须连自检一起跑**：一个「什么都报不出来」的检查器与「代码很干净」在输出上完全
无法区分。`selftest-check-objc.mjs` 往 `AMTouch.m`/`AMTouch.h` 里植入 4 个已知必错的变体
（删一个 `}`、删一个 `@end`、改一个方法名、转成 CRLF），断言检查器**确实报了出来**，然后还原。
> 这个自检第一次跑就抓到了它自己的 bug：探针里写的声明与头文件里逐字存在的声明不一致
> （真身是 `- (NSString *)backendName;`，探针写成 `- (nullable NSString *)backendName;`）
> ⇒ 替换没生效 ⇒ 报 "MISS"。**探针本身也要有判据。**
> 同理，`lint-workflow.mjs --selftest` 注入 5 个已知必错的变异（两种块标量脱出、顶层键、
> 目录级 `git add`、`${{ }}` 不配对），`check-run-shell.mjs --selftest` 注入 2 个
> （两行粘连、未闭合的 `if`）。**这两组阳性对照都真的抓到过东西**：块标量脱出那条规则
> 第一版把 `$` 写成了 `\$`（JS 正则里 = 字面美元符），一条都没匹配到而照样打印「体检通过」。

`check-plist.sh`（过滤器 plist 的三级降级校验，退出码 0 命中 / 1 用法错 / 3 未命中 / 4 解析失败）
在 CI 里用五例回验：真 `tweak/AMAutoClick.plist`、`make-hostile-plist.py` 造的
good/nobundle/notplist、以及一个不存在的路径。**为什么值得写一个脚本**：我们的 plist 是
**NeXTSTEP 旧 ASCII 格式**（Cydia/Substrate 的老写法），`plistlib` 只认 XML 与 binary，
对它会一律 `InvalidFileException` —— 当初那段内联 python 在真文件上直接 rc=4，
CI 里只显示一行「plist 检查失败」，**看起来像内容不对，其实只是格式不在支持列表里**。

推送到 `ios/auto/**` 或手动触发 `.github/workflows/ios-autoclick.yml`：2×2 矩阵
（`tweak|dylib` × `rootless|rootful`），除编译外还跑上面 377 例并**逐个校验 `"N passed"` 数值**
（只看退出码会漏掉"少跑了一半用例"），再对产物做结构断言 ——
`lipo -info` 必须 arm64、tweak 必须 `nm -u` 到 `_MSHookMessageEx`（证明 logos 展开了）、
dylib **绝不能**出现 `MSHook*` 符号（非越狱 App 里会 dyld 报错）、
deb 里 dylib 与过滤器 plist 同目录、rootless 落在 `/var/jb`、过滤器里必须有 `com.leiting.wf`。

工作流共 18 步，其中**四步是"验证验证者"**（都在为「结论本身可能是假的」这一类失败兜底）：
`--selftest` 的两个（工作流体检 5 个变异、run 块 shell 检查 2 个变异）、
`check-objc.mjs` 的 4 个植入错误、以及 `grep 模式校验` 的阴性对照
（把 7 个期望值全改成 `1 passed`，断言它**确实报错**）。
另有 `core 回归` 末尾的**能力上限审计**（`tests/audit_caps.c`）：量出真脚本在每个
`AM_MAX_*` 上的实际用量并要求一个都不溢出 —— 上限估小了只会置 `s->overflow_*` 计数，
脚本照样"加载成功"，现场表现是「有些按钮不点」而日志里什么都看不出。

---

## 4. 重建 `decomp/`（反编译参考）

`decomp/` 是 `cn.autoeditor` v4.3.8 的反编译产物，**只读参考**，用来逐条核对执行语义。
它没有入库（5558 个 `.java` / 29.7 MB，纯噪音）。重建：

```powershell
# 1) 取 APK（附件的只读副本）
$apk = "C:\Users\relea\.dsh\attachments\v1\files\c9\c9494e9c...\自动化编辑器-v4.3.8.apk"
# 2) jadx 在 out/tools/jadx（1.5.3）；本目录 tools/ 下不留副本
python list_apk.py $apk                       # 先看 APK 里有什么
out\tools\jadx\bin\jadx.bat -d decomp $apk    # 反编译到 decomp/
python dex_dump.py                            # 或只 dump dex 字符串
python extract_auto.py  ...                   # 解 .auto（ZIP）到 sample/
python verify_format.py                       # 校验格式假设
python coord_model.py                         # 复算点击点模型（cv2 参考实现）
```

关键文件（**改 `core/` 语义前必须重新读这些**）：

| 文件 | 决定什么 |
|---|---|
| `decomp/sources/cn/autoeditor/editor/EditorCrop.java:197-230` | 坐标适配（`getAdapterValue`） |
| `decomp/sources/cn/autoeditor/editor/EditorImage.java:217-244,457-501` | 变体选择（精确匹配优先 → 最小 \|Δdensity\|） |
| `decomp/sources/cn/autoeditor/editor/EditorScript.java:2200-2230` | 当前屏幕信息归一化（`f866a` 恒为长边） |
| `decomp/sources/cn/autoeditor/framework/b.java` | 场景推进 + 事件循环（`f999a` 游标） |
| `decomp/sources/cn/autoeditor/framework/c.java:335-399` | 主循环（抓帧 → 场景派发 → sleep） |
| `decomp/sources/cn/autoeditor/framework/a.java:36-42` | 动作返回值 = **动作之后**的 sleep 秒数 |
| `decomp/sources/cn/autoeditor/framework/base/c.java:198-360` | 搜索矩形 / 模板适配 / 匹配（含帧号缓存） |
| `decomp/sources/i/m.java:39-64` | **条件组折叠**（第一个叶子取代累加器） |
| `decomp/sources/i/h.java` | 超时（`timeout` 挂在**叶子**上） |
| `decomp/sources/h/f.java` | 图像动作 = **命中矩形内均匀随机取点** |
| `decomp/sources/cn/autoeditor/editor/EditorEvent.java:92` | `breakable()` = 任一动作实现空标记接口 |

---

## 5. 与 Android 的三处【刻意偏离】（都有理由，改之前先读注释）

1. **`am_adapt_rect` 用单一均匀系数**（Android 是 x/w 与 y/h 两个不同系数）。
   Android 只在录制机型上跑，看不出非均匀缩放；iOS 屏幕比例必然不同，非均匀会让
   搜索矩形与模板矩形脱钩，破坏「crop 必须容得下模板」这个不变量。
   回归哨兵：**若某天看到 `x=278, w=857`，说明有人把 Android 的双系数规则搬回来了。**
2. **无门场景直接判为 active**（不复制 `framework/b.java` 的静态 `f998h` 握手）。
   对所有场景都无门的脚本（编辑器产出的全部样本），两者净效果相同。
3. **`cond_image` 的搜索区在交集为空时回退**（Android 无条件求交）。
   Android 的求交在异型分辨率下可能为空 ⇒ 场景**静默永不触发**；本实现回退到
   「模板 rect 外扩 `expand_size`」，仍把搜索限制在录制邻域内而非全帧。

---

## 6. 已知陷阱（踩过的坑，别再踩）

- **`am_script` 必须堆分配**（`calloc(1, sizeof(am_script))`，350 KB）。
  栈上会 `STATUS_STACK_OVERFLOW`，且**一行输出都不会打印**。
  `core/auto_script.h` 末尾有 `_Static_assert(sizeof(am_script) <= AM_SCRIPT_MAX_BYTES)` 守着。
- **`am_match_template()` 是文件级单例 + 频域缓存**。缓存键必须含**内容**
  （`tpl_copy` / `roi_copy` 的 `memcmp`），只放尺寸会让同尺寸的两个模板互相投毒 ——
  症状是「精确匹配却给 `peak=0.632184`」，极像「常量模板」分支的邻居。
- **`am_fft_execute()` 是 in-place 的**。任何"参考实现"必须**先在原地变换前保存输入副本**
  （这一点曾在 FFT 与卷积定理测试里各坑过一次）。
- **`am_engine_capture()` 是公开 API**。`am_engine_scene_active()` / `am_engine_eval_event()`
  也会读帧，首轮之前想检查条件必须先调它，否则帧缓冲是 NULL。
- **`.auto` 的 ZIP 保持打开**（模板惰性读取），所有权在 `am_script`；
  `am_script_free()` 负责 `am_auto_close` + `free(zip_ctx)`。
- **测试夹具的手写 PNG**（`tests/test_engine.c` 的 `write_gray_png`）必须：
  真彩 type 2/6（`am_png_decode_gray` 拒绝灰度 type 0）、zlib 头 `78 01`、
  stored 块头是**三比特一个字节**（LEN 紧跟其后不再对齐）、缓冲留满 `2 + 块头*5 + raw + 4`、
  **Adler-32 必须计入 IDAT 长度**。这些只用 python `zlib.decompress` 交叉验证才抓得住 ——
  C 侧不校验 Adler-32，出错时会**静默**解出错误像素。
- **`am_json` 的 `expected a string`** 不是"某个值本该是字符串"，而是"对象成员之间缺逗号"
  这类 token 位置问题。按字节位置上的 token 类型读，不要按字面意思猜语义。
- **不要用 PowerShell 做文本往返**（`Get-Content -Raw | -replace | Set-Content`）：
  会把 UTF-8 中文注释变成 mojibake 并触发 `warning C4819`。
  改文件只用 `edit` / `write` 工具。
- **取帧尺寸与触摸换算系数必须同源**。`AMCapture` 取帧时同时问 `GL_VIEWPORT` 与
  当前绑定的 renderbuffer 尺寸，而**不是**只用视口：hook 挂在 `presentRenderbuffer:` 上，
  present 之前当前绑定的 framebuffer 未必是即将上屏的那个（AIR 可能渲到离屏 renderbuffer
  再缩放上屏）。两者不一致时触摸坐标的换算系数会整体偏掉 —— 症状是"点偏了但方向对"，
  15% 级别的偏差在 1200 宽画面上就是 180 像素。
  同理，**坐标换算的 scale 不是 `nativeScale`**，而是「帧缓冲宽 / 窗口点宽」（见 §7 与
  `.research/ios-design.md` §10 风险 #11）。
- **`edit` 往函数体里插代码前先 `read` 那一块**：插一段带 `char path[1024]; int pass, fail;`
  的代码、而原处已有同样的声明 ⇒ `error C2086: redefinition`。这条重复踩过三次。
- **本机没有 clang / Xcode / 任何 debugger**。iOS 代码的首次编译发生在 CI 上，
  **运行行为只能在真机上验**。不要把"CI 绿了"当成"能跑"。
  没有调试器时的越界定位手段是 `tests/pg_guard.[ch]`（页守护分配器）；
  验证它自己是否可信，要先同时对**一个合法用例**和**一个非法用例**跑一遍。
  `tools/check-objc.mjs` / `selftest-check-objc.mjs` 只是结构体检，**对真实编译错误
  一个都报不出来**（要复现需要「A.h 被 B.m 第 N 行 include」这种 TU 上下文）——
  它们的价值是抓住手误，不是替代编译器。
- **vDSP 必须用 Double 那一套**：`DSPDoubleSplitComplex` + `vDSP_ctozD` / `vDSP_ztocD` /
  `vDSP_fft_zipD` + `vDSP_create_fftsetupD`。数据是 `double`，用单精度的
  `DSPSplitComplex` 只会得到 `-Wincompatible-pointer-types` 三条**警告**（不是错误！），
  而它的 `realp/imagp` 是 `float *` ⇒ 步长按 4 字节算 ⇒ **vDSP 读到的是垃圾**。
  Apple 侧的警告不是噪音，见 `core/am_fft_accel.c` 顶部注释。
- **`clang: error: no such file or directory: 'core/xxx.c'` = 新文件没进推送**。
  `ci-push.mjs` 用 `git stash create` 取快照，而它**只收已跟踪文件的改动** ——
  新写的、还没 `git add` 的源文件根本不在里面。现在有两道防线：
  推送前自动把 `--others` 的新文件收进树，推送后做**双向**回读校验
  （既查"远端那份对不对"，也查"本地源文件一个不缺"）。
- **判据要抄就抄零份**：`tools/check-test-patterns.mjs` 原来另抄了一张用例数表，
  于是它自己成了第三个要同步的地方（`test_fft` 119→125 时它反而报错）。
  现在它**从工作流现读** `run <exe> "<dir>" "<N passed>"`。
  同理：**用例数变少先怀疑夹具路径**（`test_engine` 少传 `\pkg` 会静默跳过 24 例、
  变成 36 passed），**文件数变少则先怀疑新文件没进快照**。
- **诊断/取证步骤绝不允许把 job 判红**。GitHub Actions 的默认 shell 是 `bash -e`，
  形如 `[ 条件 ] && 动作` 的「守卫 && 动作」在守卫为假时整行返回 1 ⇒ **该 step failure**。
  这个坑在本工作流里踩过三次（`emit()` 的 `&& break`、`通过性摘要` 的
  `[ -n "$dylib" ] && echo`、`错误注解` 的 `[ A ] || echo` —— 最后一次让四条腿在
  「编译/打包/断言全部 success」的情况下集体变红）。修法：写成 `if … then … fi`，
  可能非 0 的命令自带 `|| true`，末尾无条件 `exit 0`。
- **注解文本会被 GitHub 回灌成下游的 shell 脚本**。`::notice::` / `::error::` 后面的内容
  不只是"显示"：GitHub 把它原样写进**下一步的临时脚本文件**
  （`/Users/<runner>/work/_temp/<uuid>.sh`），于是它**就是 shell 源码**。第 15 次 CI 的
  `15.错误注解 = failure` 就是这么来的 —— deb 断言步骤 `cat` 过一个 binary plist 进
  `build.log`，注解通道把含 `$Binary` 的那一行原样发了出去 ⇒ `Binary: unbound variable`
  ⇒ 脚本带 1 退出，**而真正的构建其实是全绿的**（编译、打包、两条断言全部 success）。
  **两道防线都要有**：① 源头 —— 凡是会进 `build.log` 的二进制都换成文本
  （`python3 -c 'import plistlib…'`，失败退回 `strings | head`）；② 出口 —— 注解前逐行
  `sanitize()`（去 NUL/控制字符/反斜杠 → 只留可打印 ASCII → 把 `$ \` [ ] * ?` 换成 `?`）。
  `tools/tsan-sanitize.sh` 是这条净化链的自检：要求「原样文本**确实**报
  `unexpected EOF`」（阳性对照）**并且**「净化后不但不报错、注入的命令也确实没被执行」
  （用 `id` 的输出当哨兵，再配一个「把 `id` 放行首必须真的执行」的阳性对照）。
  ⚠️ `sanitize()` 里**不要写反斜杠**：`tr '$`[]*?\' '…'` 末尾的裸反斜杠会让 GNU tr 警告
  `an unescaped backslash at end of string is not portable`，而 BSD tr（macOS）的解释
  未定义 —— 反斜杠改用八进制 `\134` 在**删除**那一步处理掉。
  ⚠️ `cut` 那一步也**必须带 `LC_ALL=C`**：第 16 次 CI 的 `cut: stdin: Illegal byte sequence`
  就是它在 UTF-8 locale 下按字符计数、遇到孤立高位字节直接报错退出（C locale 下 `-c`
  就是按字节数且不校验编码）。
- **我们的过滤器 plist 是 NeXTSTEP 旧 ASCII 格式，`plistlib` 不认**。
  `tweak/AMAutoClick.plist` 只有 148 B、10 行（`{ Filter = { Bundles = ( "com.leiting.wf" ); … }; }`），
  这是 Cydia/Substrate 一直在用的老写法，而 `plistlib`（CPython 3.x）**只认 XML 与 binary**
  ⇒ 对它一律 `InvalidFileException: Invalid file`（`Get-ChildItem` 之类也会报
  `Invalid file`，**不是文件坏了**）。用 `tools/check-plist.sh`（三级降级：旧 ASCII 走
  `awk`+grep、XML/binary 走 `plistlib`、兜底走 macOS 的 `plutil -convert json`），
  退出码 0 命中 / 1 用法错 / 3 未命中 / 4 三种格式都解析失败。
  **判据要求 Bundles 与 Executables 两条都命中** —— 只判一条会让「Executables 写错但
  Bundles 对」漏过去，那正是「装上了但什么都不发生」的经典成因。
- **管道会吞掉退出码**：`cmd | tr …; rc=$?` 拿到的 `$?` 是**管道最后一段的**。
  `check-plist.sh` 第一版就是 `"$PY" … | tr -cd …` 之后 `rc=$?` ⇒ **恒为 0**，
  于是「未命中」（应 3）与「不是 plist」（应 4）都报 rc=0 还打 `ok` ——
  **判据全绿、事实全错，而 CI 上只看到一行 ok**。
  正解：先把 python 输出落进 `mktemp` 文件、拿到**真实退出码**，再做文本净化。
- **清理脚本不要 `rm` 自己目录里的东西**。`tsan-sanitize.sh` 的探针会在工作目录造出
  怪名文件（`>?Binary?id`，用来复现注解回灌的重定向），所以它加了个 `trap cleanup EXIT`
  删掉「跑之前不存在」的文件。第一版用
  `case "$before" in *"|$f|"*) continue ;; esac` —— **`case` 的 glob 是「包含」不是「等于」**，
  而 `|` 在路径里极常见 ⇒ `|build-and-test-matcher.ps1|` 作为子串命中，**把 1584 B 的真实
  源文件删了**（已 `git checkout HEAD --` 恢复，隔离目录里复现过）。
  修后：快照保留换行、`grep -qxF` 逐行**精确**比较，且探针脚本一律写进私有 `mktemp -d`。
  **教训：任何「跑完清理」的逻辑，都要先在隔离目录里对真实邻居文件跑一遍。**
- **危险数据必须从文件读，不能经 `python -c "…"` 传**。`tools/make-hostile-plist.py`
  的存在就是为了这个：PowerShell 里反引号是**转义字符**、`$` 会插值 ⇒
  `python -c "...$Binary\`id\`..."` 里的载荷**根本到不了 python**（实测拿到的是 `'\\id['`）
  ⇒ 那次「危险数据通过了测试」是**假的**，测的是一个被改写过的字符串。
- **`|` 收尾的模式最怕上游改写法**：`check-test-patterns.mjs` 原来用
  `^\s*run\s+(\S+)\s+"([^"]*)"\s+"([^"]+)"\s*$` 解析工作流里的
  `run test_fft "" "125 passed"`。后来为了绕开 `bash -e` 的守卫陷阱给每行加了
  `|| true` ⇒ **7 行一条都匹配不上**，而脚本打印的是
  「0 个不匹配 / 工作流里的 grep 模式与真实输出一致」——**全绿而什么都没验**。
  现在两处都补了：正则去掉 `$` 锚，并断言**至少解析出 7 条**。
  **通用规则：任何「解析另一个文件」的检查器，都要对「解析到几条」本身设下界。**
- **GitHub 的 job 级日志 API 是能用的**（之前记的"匿名 403"只针对 `runs` 端点）：
  `GET /repos/<owner>/<repo>/actions/runs/<run_id>/jobs` 拿 `steps[].conclusion` 与 `job.id`，
  再 `GET /repos/<owner>/<repo>/actions/jobs/<job_id>/logs` 取完整控制台日志（带 BOM，
  行首有时间戳）。**定位失败步骤优先走这两条**，不必每次都 fetch `ci-diag` 分支。
  PowerShell 5.1 读 UTF-8 的 YAML 要用 `[System.IO.File]::ReadAllLines()` ——
  `Get-Content` 会按 GBK 解码，中文行匹配必然失配。

---

## 7. 两个交付物怎么出（快速通道）

### ① 越狱 deb

```bash
cd ios/auto/tweak
make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless THEOS_PACKAGE_DIR="$PWD/dist/rootless"
make package FINALPACKAGE=1                          THEOS_PACKAGE_DIR="$PWD/dist/rootful"
```

装到 iPhone 7 Plus / iOS 15.8.3（A10 = arm64，Dopamine 2.x 或 palera1n rootless + ElleKit）。
过滤器 `AMAutoClick.plist` = `Bundles: com.leiting.wf` + `Executables: worldflipper`
（**两者是「或」** —— 即使 bundle id 被重签改了，可执行名还在，仍会注入）。
脚本放 `Documents/AutoClick/*.auto`，面板开机可选自动弹出。

### ② 非越狱 dylib

```bash
cd ios/auto/dylib && make package FINALPACKAGE=1
node tools/inject-dylib.mjs --app=/path/to/worldflipper.app --check   # 先干跑
node tools/inject-dylib.mjs --app=/path/to/worldflipper.app
# 然后重新签名整个 .app → 打包 → 侧载
```

注入器**不移位**（文件长度一个字节不变），并在目标二进制上实测过：
`ncmds 67→68`、`sizeofcmds 7584→7656`、整份 108 MB 里只有 52 字节不同且全部 `< 0x4000`。
它拒绝两类输入：`cryptid != 0`（加密包，改头会被设备的解密器拒绝）
和头部空闲区不够（AIR 的 AOT 加载器按偏移读文件，移位 = 启动黑屏）。

非越狱侧**没有人能点面板**，所以必须靠 `AMConfig` 的 `autoStart` + `preferredScriptName`
自动起跑；指名的脚本不在设备上时**不启动**（宁可不动，也不要跑错脚本乱点）。
这两个键都在 **bundle 根目录的 `AutoClick.plist`** 里（放进 `.app/`，不是 substrate 那个
过滤器 plist），**键名逐字是代码里读的那几个**：

| 键 | 类型 | 缺省 | 作用 |
|---|---|---|---|
| `autoStart` | bool | `NO` | 启动后自动加载并开跑 |
| `script` | string | 无 | 要跑哪个脚本，写 `"幻想连战.auto"` 或 `"幻想连战"` 都认；**不在设备上就不启动** |
| `panelVisibleAtLaunch` | bool | `YES` | 悬浮球面板是否开机就显示；非越狱侧通常写 `false` |

★ 属性名与键名**不是一回事**：属性的 `preferredScriptName` 读的键是 **`script`**
（`ios/AMConfig.m` 的 `-preferredScriptName` 里 `_bundle[@"script"]`）。写文档或
配置时按上表，按属性名写 `preferredScriptName` 进 plist 是读不到的。

真机验收按 `.research/ios-design.md` §12 的顺序做 —— **第 0 步（iOS 截图能否匹配上）
不过就不要往下走**。
