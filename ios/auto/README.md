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
  auto_match.[ch]     NCC 模板匹配（FFT 实现），逐位对齐 OpenCV 的 TM_CCOEFF_NORMED
  auto_script.[ch]    .auto 模型层：模板组 / 变量 / 场景 / 条件 / 动作 + 变体选择 + 坐标适配
  auto_engine.[ch]    执行引擎：条件折叠 / 场景派发 / 超时 / 动作执行 / 点击取点

tests/                七套测试（MSVC，见 §3）；build/ 与 decomp/ 都不入库
  test_fft.c          119 例：与直接 DFT 逐元素对拍 + 卷积定理 + next_fast_size
  test_json.c          84 例：JSON 解析（含畸形输入与错误偏移）
  test_matcher.c       13 例：9 个正样本
  test_matcher_neg.c   18 例：错配峰值上界 0.422071（sim 0.80，余量 0.378）
  test_package.c       21 例：ZIP/PNG 断言 + 17 个真实匹配用例
  test_script.c        56 例：场景/条件/变体选择/坐标适配/点击矩形/ZIP 路径
  test_engine.c        60 例：条件折叠/场景派发/超时/缓存/合成夹具自检
  bench_fft.c         FFT 孤立计时（pad 策略的依据）
  bench_pkg.c         9 个真实 crop 搜索区计时
  pg_guard.[ch]       页守护分配器（没有调试器时的越界检测手段）

matcher_golden/       9 个正样本夹具（golden_cases.h + raw/*.bin）
matcher_golden_neg/   18 个负样本夹具（golden_neg_cases.h + raw/*.bin）
matcher_golden_pkg/   sample.auto + pkg/（54 张平铺 PNG + script.json）+ 17 个真实匹配用例
sample/               从「幻想连战.auto」解出的 script.json 与结构报告（人读用）
tools/                生成夹具的 python 脚本（cv2 参考实现）
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

运行：

```powershell
tests\build\test_fft.exe          # 119 passed, 0 failed
tests\build\test_json.exe         #  84 passed, 0 failed
tests\build\test_matcher.exe      matcher_golden        #  13 passed, 0 failed
tests\build\test_matcher_neg.exe  matcher_golden_neg    #  18 passed, 0 failed
tests\build\test_script.exe       matcher_golden_pkg\pkg   # 56 passed, 0 failed
tests\build\test_package.exe      matcher_golden_pkg       # 21 passed, 0 failed
tests\build\test_engine.exe       matcher_golden_pkg\pkg   # 60 passed, 0 failed
```

**合计 371 例，全部 0 failed、零 warning。**

> **两个坑**：
> ① `golden_cases.h` / `golden_neg_cases.h` / `golden_pkg_cases.h` **不在 `tests\` 里**，
> 而在各自夹具目录 —— 上面 `$inc` 里的三个 `/I` 是承重的。缺了会报 `fatal error C1083`，
> 而**旧的可执行文件不加 `/I` 也能"通过"**（过期二进制）。改完代码务必重新编译。
> ② `D_CRT_SECURE_NO_WARNINGS` 必须走命令行，在源文件里 `#define` 无效
> （`<string.h>` 已被头文件先拉进来）。

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
