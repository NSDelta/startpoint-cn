# iOS 自动点击插件 —— 设计方案（冻结版）

> 交付目标（用户 m00002）：iOS 可用的自动屏幕点击插件两件套
> ① 越狱可用的 **deb**
> ② 非越狱注入**单个应用**的 **dylib**
> 两者都必须**兼容 .auto 脚本格式**（自动化编辑器 v4.3.8 导出）
>
> 本文所有结论均标注证据等级：`[实证]` 本机实测/反编译确认 · `[源码]` 官方源码 · `[推断]` · `[未证实]`

---

## 0. 一句话结论

`.auto` 的执行语义已在 Windows 上**完整复刻并通过全部黄金测试**（匹配内核与 Android/OpenCV 判定等价），
iOS 端只需补上「取帧」与「注入触摸」两个薄适配层即可。目标游戏是 **Adobe AIR + OpenGL ES 2**，
且是**竖屏应用** —— 这两点让两个交付物都比预想简单：

- **取帧**：AIR 用 Stage3D 渲染到 `EAGLView` 的默认 framebuffer ⇒ hook `-[EAGLContext presentRenderbuffer:]` + `glReadPixels` 拿真帧，不需要 `drawHierarchy`（对 GL 内容是黑帧），也不需要越狱。
- **注入**：游戏是竖屏、坐标系与 `.auto` 录制空间一致 ⇒ 无需任何坐标变换，且可以在**同进程内**合成事件。

---

## 1. .auto 格式（已完整逆向）`[实证]`

`.auto` = ZIP(deflate)。条目：

| 条目 | 说明 |
|---|---|
| `version` | 内容 `4308` = App 版本 4.3.8 |
| `script_version` | `7` |
| `script.json` | 脚本主体（UTF-8） |
| `image/<ts>.png` | 模板裁剪图（24 张） |
| `ori/<ts>.png` | 全屏原始截图（30 张） |

文件名是毫秒时间戳。

### 1.1 script.json 顶层

样本 `幻想连战.auto` 实测 31 个键。运行期真正参与执行的：

```
init, id, name, loop_mode(1), version(7), lowest_app_version("4.3"),
concurrency(true), expand_size(0), capture_direction(-1*), task_mode(0),
input_type(1), adapter(1), loop_interval(30),
image_list, var_list, scene_list, default_scene,
common_event, common_event_low, gesture_group_list, ...
```

`*` `capture_direction` **只被序列化/反序列化，运行期引擎从不读取**（`grep` 全仓无消费者）`[实证]`。

### 1.2 image_list[]（模板组）

```jsonc
{ "name":"招募", "id":"BqhUaUbSkADiXx5r", "sim":"0.8", "adapter_type":1 /*可缺省*/,
  "images":[ { "file":"image/1789816658174.png", "ori":"ori/1789816658174.png",
               "rect":"444,1221,186,46", "type":1, "threshold":0,
               "filter_color":0, "filter_sim":0,
               "screen_info":{"width":1080,"height":1920,"density":280,"pixelStride":?, "rowPadding":?} } ] }
```

- `sim` 在**组级**（阈值，默认 0.8）。
- `images[]` 是**多分辨率变体**（样本 23 个变体，覆盖 1080x1920@280 / 1200x2000@280 / 1440x3200@560）。
- `rect` = 模板在 `ori` 截图中的**绝对左上角 + 宽高**。`[实证]` 23/23 逐像素相等。

### 1.3 var_list[]（变量 → **点击矩形**）

```jsonc
{ "type":2, "id":"…", "name":"", "value":"…",
  "crops":[ { "ori":"ori/…png", "rect":"262,989,577,504",
              "orientation":2, "screen_info":{…} } ] }
```

**`crops[].rect` 就是点击矩形的来源。** 条件/动作通过 `search_id` → 变量 id 引用它。

### 1.4 default_scene[]（执行入口）

```jsonc
{ "name":"招募", "id":"…",
  "item_group":{ "type":5, "relation":1, "item_list":[ {…条件项…} ] },
  "action_list":[ {…动作…} ] }
```

- 条件项：`{type:1, id, relation:1, state:1, image_id, search_id, timeout:0, reset_timeout:false}`
- 动作：`{type:2, id, postpone:1, image_id, search_id, button:1, press_time:0, click_times:1, interval:0}`
- 样本 = **10 个场景，每场景恰 1 条件 + 1 动作**，全部 `type=2`；两个场景 `disabled:true`；均无 `scene_event` 门。

**`search_id` 的角色（关键）**：它是「在**哪个矩形内**找模板」+「在**哪个矩形内**点」。

---

## 2. 执行语义（反编译 Android 参考实现 `cn.autoeditor` v4.3.8 得出）`[实证]`

### 2.1 点击点算法 ★

```
在 search_id 所指变量的 crop 矩形内做模板匹配
  → 若命中(峰值 ≥ sim)：在【命中矩形】内均匀随机取一点点击
  → 若给定了 deviation(偏移变量)：在【偏移矩形】内随机取点
```

逐层证据：

| 层 | 位置 | 关键代码 |
|---|---|---|
| 匹配 | `cn/autoeditor/framework/base/c.java:299-365` | `Imgproc.d(d8, this.f1050e, mat2)` → `Core.minMaxLoc` → `p1Var.f1446e = max(maxVal,0)`；`f1442a = (int)mm.maxLoc.x + rect.x`（**全帧像素坐标**）；`f1444c/f1445d = 模板宽高` |
| 判定 | `cn/autoeditor/framework/i/c.java` | `return p1Var.f1446e >= f7959i.f1049d ? 1 : 2;`（位1=找到，位2=未找到） |
| 取点 | `cn/autoeditor/framework/base/h.java:60-72` + `framework/k5.java:36-38` | `k5.c(Rect)` = `new Point(nextInt(rect.width)+rect.x, nextInt(rect.height)+rect.y)` —— **矩形内随机** |
| 动作 | `h/f.java:58-120` | `i8/i9 = rect.width/height`；`i10 = rect.x - point.x`；最终 `nextInt(i8)+f7960j.x+i10` |
| 派发 | `cn/autoeditor/framework/e.java:686-705` | `GestureDescription.Builder().addStroke(StrokeDescription(path,0,dur))` → `AccessibilityService.dispatchGesture` |

**`sim` 的语义 = 归一化互相关的峰值，直接比大小。** 匹配方式 `[实证]`：

`cv2.matchTemplate(ori, tpl, TM_CCOEFF_NORMED)` 的全局最大点 = 模板 `rect` 左上角，23/23 `delta=0, score=1.0000`。

### 2.2 场景推进（`cn/autoeditor/framework/b.java:34-137`）

- 运行期场景列表 = `scene_list` 全部 + **`default_scene` 追加在最后**。
- `common_event` / `common_event_low` 的事件列表被 `addAll(0, …)` **插到每个场景前面**（仅当该场景有 `scene_event` 门）。
- 每轮：先评估**场景门**（有 `scene_event` 才有）；门通过后，**只对索引 `i > f999a` 的事件**逐条评估条件组；
  命中则 `f999a = i` 并执行其动作；命中 break 类动作就跳出；走到末尾后 `f999a = -1` 回绕。
- 场景门 false→true 时执行门自己的动作（`onSceneIn`）；true→false 时重置该场景所有事件条件。
- `loop_mode == 2` 时每轮把 `f999a` 重置为 -1。

### 2.3 条件组（`i/m.java:39-64`）

```java
z8 = (c8 == 1 || c8 != 2) ? (z8 & d8) : (z8 | d8);   // relation==2 → OR，其余 → AND
```

- 嵌套组展平（`i.m.a()`）；JSON 嵌套形态 `{type:5, item_state:-1, group:[…]}`。
- **timeout**：`>0` 时条件变成「必须**连续满足** timeout 秒」；`==0` 时就是「本帧是否满足」。
  预检查 `b()` 只在**门**那一轮调用 ⇒ 事件级条件即使写了 timeout 也退化为瞬时判定。**Android 行为如此，照抄。**

### 2.4 搜索矩形的构造

```
无 search_id：搜索区 = 模板自身 rect 外扩 expand_size 像素
有 search_id：搜索区 = 该变量 crop 矩形（可含多个，逐个试）
模板比搜索区大 → 放弃该搜索区（返回未命中）
命中即停（取最优）
```

### 2.5 分配置适配

两个独立算法，都已在 C 侧复刻：

- **模板变体选择**（`EditorImage.getAdapterInfo`）：先找 `screen_info` **精确相等**的变体；找不到时 `adapter==2` 按**长宽比最接近**，否则按 **`|Δdensity|` 最小**。
- **组级 `adapter_type`** 缺省 `-1` ⇒ 落到**脚本级 `adapter`**（样本 = 1）⇒ 长边等比缩放分支：`x` 乘 `max`、`y` 乘 `max2`、模板尺寸乘 `f8`。
- **crop 矩形跨分辨率映射**（`EditorCrop.getAdapterValue`）：`d8 = 当前长边/录制长边`（作用于 x），`d9 = 当前短边/录制短边`（作用于 y）。

### 2.6 ★ 坐标空间（重要，本轮新确认）`[实证]`

- `ori_infos` 去重 4 类：`1080x1920@280`×9、`1200x2000@280`×11、`1440x3200@560`×3、`1920x1080@280`×7。
- **但 `ori/*.png` 实际只有竖屏帧**：1080x1920×16、1200x2000×11、1440x3200×3 —— **没有任何 1920x1080 的帧**。
- `var_list` 的 9 个 crop **全部 `orientation=2`**，`screen_info` 是 1080x1920 或 1200x2000。
- 全部 23 个模板变体的 `rect` 在其 `ori` 截图内**逐像素成立**（23/23），且可视化后**红框严丝合缝套住**「招募」「挑战」等按钮、**界面文字正立可读**。
  ⇒ **`世界弹射物语` iOS/Android 客户端是竖屏应用**（`Default-Portrait*` 启动图也印证）。
- **结论：`.auto` 的坐标 = 竖屏归一化像素空间，与运行时帧空间一致，运行时不需要任何旋转变换。**
- iOS 侧对应量：`am_screen` 的 `long_edge = max(buf_w, buf_h)`、`short_edge = min(...)`（复刻 Android `updateScreenInfo()` 的 `f866a/f867b`）。
  1080x1920 的 iOS 帧命中 `screen_info` 精确匹配分支 ⇒ 连缩放都不需要。

---

## 3. 目标游戏客户端（iOS）`[实证]`

`apkipa\苹果v15.2.ipa` (160905608 B) → `out\ipa-extract\Payload\worldflipper.app\`：

| 文件 | 大小 | 含义 |
|---|---|---|
| `worldflipper` | 108757200 | 主二进制，**无 `Frameworks/` 目录** |
| `worldflipper_ios_release.swf` | 11242032 | **Flash/AIR 应用包** |
| `BackgroundWorker.swf` / `BackgroundWorker-app.xml` | | AIR worker |
| `DeviceList.plist` / `leiting_Config.plist` | | AIR / 雷霆 SDK 配置 |
| `Default-Portrait-*.png` | | **仅竖屏**启动图 |

主二进制字符串证据：`AdobeAIR`×7、`air.`×40、`FlashRuntime`×4（`FlashRuntimeIsolate`）、`Stage3D`×15、`Context3D`×129、
`platform.gpu.kind` = **`opengles2`**、`/System/Library/Frameworks/OpenGLES.framework/OpenGLES`、`kEAGLDrawable`×4、
`_OBJC_CLASS_$_EAGLContext`、`presentRenderbuffer:` / `renderbufferStorage:fromDrawable:` / `setDrawableProperties:`。
（`Metal` 的 8 次命中全是 `FunnelMetalKind` 之类业务类名，**非渲染路径**。）

⇒ **Adobe AIR + OpenGL ES 2 + Stage3D，竖屏。**

---

## 4. 架构

### 4.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│  core/            纯 C99，零平台依赖，Windows/macOS/iOS 同源 │
│    am_container    ZIP(deflate) + PNG 解码（内置 inflate）   │
│    auto_match      NCC 模板匹配（≡ OpenCV TM_CCOEFF_NORMED） │
│    am_json         最小 JSON 解析器                          │
│    auto_script     .auto 模型层（image_list/var_list/scene） │
│    auto_engine     执行器：场景门/条件组/动作派发/缓存       │
│    auto_screen     屏幕抽象（长边/短边、分辨率适配）         │
│    auto_log                                                    │
├─────────────────────────────────────────────────────────────┤
│  ios/             平台适配（Objective-C / C）                │
│    AMCapture      取帧：hook presentRenderbuffer + glReadPixels │
│    AMTouch        注入：HID 事件链（主）/ 响应链（备）        │
├─────────────────────────────────────────────────────────────┤
│  tweak/           deb 交付物（Theos）                        │
│    Tweak.xm       注入游戏进程：装配引擎 + 悬浮控制面板      │
│    AMControlPanel 悬浮球 / 脚本选择 / 启停 / 日志            │
│  dylib/           dylib 交付物（Theos，同一套源码）          │
└─────────────────────────────────────────────────────────────┘
```

两个交付物**共用同一套 core + ios 适配层**，差别只在装配方式与 UI 呈现：

| | deb（越狱） | dylib（非越狱） |
|---|---|---|
| 注入目标 | App Store 版 `worldflipper`（**加密包，无需重打包**） | 已解密 IPA，经 `ios/importer/tools/inject-dylib.mjs` 注入后侧载 |
| 安装路径 | `/var/jb/Library/MobileSubstrate/DynamicLibraries/` | `Payload/worldflipper.app/Frameworks/` |
| install_name | — | `@executable_path/Frameworks/AMAutoClick.dylib` |
| 取帧 | 同 dylib（**同进程 framebuffer**） | hook `presentRenderbuffer:` + `glReadPixels` |
| 注入 | 同 dylib + 可升级为全局 HID | 同进程 HID 事件链 |
| 额外能力 | 可注入 SpringBoard 做**全局**取帧/注入（系统弹窗也能点）→ **v2** | 仅宿主 App 自己的窗口 |

> **为什么 v1 不做 SpringBoard 侧？**
> `[实证]` 项目里已解包的 IPA 是 `cryptid=0` 的 dump；App Store 正版是加密的，非越狱侧载**无法**注入它。
> 反过来，越狱设备上 deb 用与 dylib 相同的同进程方案就已经能完整工作，且 game 是竖屏、坐标系天然对齐。
> 全局取帧（`IOSurface` + `CARenderServerRenderDisplay`）留作 v2 增强，接口已预留。

### 4.2 引擎数据流

```
每秒 ~N 轮（loop_interval 毫秒）：
  AMCapture 取帧 → BGRA/RGBA 缓冲
      ↓ am_gray_from_rgb
  灰度帧 + 帧号(frame_no)++
      ↓ per 场景
  场景门？→ 条件组求值
      ↓
  事件循环（单调索引，i > last_index）
      条件：在 search 矩形内 am_match_template → 峰值 ≥ sim ?
      动作：am_match_template → k5 式矩形内随机点 → AMTouch tap
      ↓
  记录统计 / 面板刷新
```

**结果缓存**：复刻 Android —— 按「搜索矩形」缓存 `(peak, x, y, w, h)`，**帧号变化即全部失效**。

### 4.2.1 性能实测与预算（★ 本节的数字决定 iOS 侧必须做什么）

引擎已实现并全部通过测试（`ios/auto/core/`）。在**本机 Windows、标量 C、`/O2`** 上实测：

| 项目 | 实测 |
|---|---|
| 单个 crop 搜索区（`幻想` 167x49 in 476x505，稳态） | **73.9 ms** |
| 最差单个 crop 搜索（`挑战` 214x48 in 703x497） | **127.8 ms** |
| 9 个 crop 搜索合计 | **676 ms** |
| 全帧单个搜索（1200x2000） | 316 ms |
| `loop_interval` 预算 | **30 ms** |

⇒ **最差单个搜索超预算 4.26 倍。** 这是纯 FFT 卷积的代价，不是可以靠调参绕过的。

**已经吃掉的优化（1512 ms → 676 ms，2.2 倍）**：pad 尺寸一律取 **2 的幂**。踩过的坑值得记：一开始按「最小的 5-smooth 数」选 pad（648x512 而不是 1024x1024），**结果更慢**——因为混合基路径每元素比 radix-2 慢约 11 倍。实测对比（`tests/bench_fft.c`）：

```
  576x648  (373k 点, mixed)  58.0 ms      1080x1920 (2074k 点, mixed) 332 ms
 1024x512  (524k 点, pow2)   17.3 ms      2048x2048 (4194k 点, pow2)  134 ms
 1024x1024(1049k 点, pow2)   33.7 ms
```

**结论：核函数与业务必须解耦，性能靠换核解决。** 具体：
1. iOS 侧把 FFT 的快路径换成 **Accelerate/vDSP**。**已落地**（`core/am_fft_accel.c`，只在 `__APPLE__ && AM_FFT_ACCELERATE` 下编译，非 Apple 退化成空实现 ⇒ Windows 单测照跑标量）：
   - 接法**不是**替换 `am_fft`，而是在 `core/am_fft.c` 的 `fft_pow2()` 开头问一句「有加速后端吗」。只有**相邻的（stride == 1）、2 的幂长度**的一维变换走 vDSP；带跨距的行与非 2 的幂长度仍走标量。ND 驱动里最后一维的 stride 恒为 1，二维匹配的绝大多数工作量都在这一维。
   - 用的是 **Double** 那一套（`vDSP_create_fftsetupD` / `vDSP_fft_zipD` / `vDSP_ctozD` / `vDSP_ztocD` + `DSPDoubleSplitComplex`）。第一次写错成单精度的 `DSPSplitComplex`，clang 报三条 `-Wincompatible-pointer-types` —— 那不只是警告，vDSP 会按 4 字节步长去读 double 数据，跑出来是垃圾。
   - 逆变换在 `am_fft_execute()` 里是「共轭 → 正向 → 除 N → 再共轭」拼的，所以生产路径**只走正向**，不涉及 vDSP 的符号/缩放约定。
   - 等价性验证**不能拿标量版当参考实现**（macOS 上标量路径根本不会被调用，那是「自己跟自己对」）。`tests/test_fft.c` 的 `[6]` 段改用与实现无关的不变量：`X[0] == Σx`、单位冲激 ⇒ 全 1、Parseval、以及「逆变换后再正变换应还原同一谱」。段尾还有一条断言：Apple 上若 `am_fft_accelerate_active()` 为假就报错 ⇒ 忘加 `-DAM_FFT_ACCELERATE=1` 的后果是当轮 CI 变红，而不是悄悄少测一截。
2. **不要每帧匹配所有模板**。复刻 Android 的单调索引（§2.2）：每帧只评估可达的节点，正常稳态是 1~3 次匹配/帧。
3. FFT 与模板尺寸无关 ⇒ **模板频域结果跨帧复用**（已实现），搜索区频域在 `expand_size`/crop 固定时也可复用。

> ⚠️ 仍未在真机上量过 vDSP 版的实际耗时。§4.2.1 的 4.26 倍是**标量 C 在 Windows/MSVC 上**的数字；A10 上 vDSP 的收益只是预期（5~20 倍），要到 §12 验收清单第 6 步才能确认是否进 30 ms 预算。

> 混合基（5-smooth）路径保留且有测试覆盖（`am_fft_plan_create` 接受 5-smooth 长度），在小尺寸 1D 上有用；**大尺寸 N 维变换不要用它**。理由与数据已写进 `core/am_fft.h` 的注释，防止后人"优化"回 5-smooth。

### 4.3 必须与 Android 逐位一致的三处

1. **匹配打分**：NCC（`TM_CCOEFF_NORMED`），负相关/NaN 钳 0，常数模板按 OpenCV 分母 0 行为处理。已复刻并验证。
2. **灰度公式**：`(R*77 + G*150 + B*29) >> 8`（OpenCV 定点、不舍入）。已复刻并验证。
3. **取点**：命中矩形内**均匀随机**（不是中心），`press_time` 缺省 `nextInt(30)+20` ms。照抄。

### 4.4 一处必须记住的实现陷阱：匹配缓存的键

`core/auto_match.c` 的 `am_match_template()` 是**文件级单例**（`static am_match_ctx g_ctx`）+ 频域缓存：
模板频谱、pad 尺寸、积分图都只在尺寸变化时重建。

**初版判据是「`(pw,ph,rw,rh,tw,th)` 全等就复用」，这是错的。** `.auto` 脚本里每个按钮裁切
都是不同图像，但**尺寸常常相同**（样本 11 个模板组里有 4 组是 8 的倍数级同尺寸）。于是
模板 A 先被匹配过之后，模板 B 会直接复用 **A 的频谱**，算出一个"看起来很合理"的错分数。

症状极具误导性：**同一个 8x8 的精确匹配 ROI+模板给出 `peak=0.632184`，而孤立探针给 `1.000000`**；
而且 `0.6322` 这种"不大不小的分数"恰好也是「常量模板」分支（`var_t <= AM_EPS` ⇒ `peak=0.0`）
的邻居，很容易被误读成模板方差为 0。

**修法**：`am_match_ctx` 里保存模板与 ROI 的像素副本（`tpl_copy` / `roi_copy`），
`ctx_prepare` 的复用判据追加 `tpl_same()` / `roi_same()`（`memcmp` 整块）。
**教训：任何跨模板复用的缓存都必须把【内容】纳入键，不能只放尺寸。**

---

## 5. 取帧方案（iOS）

| 方案 | 可行性 | 帧率 | 说明 |
|---|---|---|---|
| **hook `-[EAGLContext presentRenderbuffer:]` + `glReadPixels(默认 FBO)`** | ✅ 首选 | 快 | AIR/Stage3D 渲染到默认 framebuffer，读默认 FBO = 真帧（含 3D 内容）。`glReadPixels` 从 back buffer 读，需处理上下翻转（OpenGL 原点在左下） |
| `drawViewHierarchyInRect:afterScreenUpdates:NO` | ⚠️ 兜底 | 慢 | `[社区]` Sentry 2025 在 iPhone 8/iOS 15.7 实测 25.4 ms/帧（占主线程）；**对 GL 内容可能黑帧** |
| `layer.renderInContext:` | ⚠️ 兜底 | 中 | 20.7 ms；渲染不完整（漏 tab bar 图标之类） |
| `IOSurface` + `CARenderServerRenderDisplay` | ❌ 非越狱不可用 | — | `[社区]` 自 iOS 9 起被 Apple 阻断；越狱侧需在 SpringBoard/backboardd 内（tweak 继承宿主 entitlement） |

**采集节流**：只有「上一帧匹配已完成」时才发起下一次采集，避免主线程堆积；面板可调间隔（默认 100 ms，`.auto` 请求 30 ms）。

---

## 6. 触摸注入方案（iOS）

> 专项调研：`.research/ios-touch-synthesis.md`（1096 行，全部结论带 `[源码]/[文档]/[社区]/[自写]/[未找到]` 标签）。
> **该调研推翻了两条我先前的假设**，结论也据此改了 —— 见下方「裁决变更」。

### 6.1 裁决（已按证据修正）

| 目标 | 路径 | 理由 |
|---|---|---|
| **非越狱 sideload（主交付物）** | **`UITouch` + `-[UIApplication _touchesEvent]` + `-[UIApplication sendEvent:]`** | HID 路在普通 App 进程内**不可用**（见下）。此路是 PTFakeTouch(698★) 的血统，明确是 "User mode"、不需越狱 |
| **越狱 deb** | 先跑 `IOSTouchHIDProbe`，成功则用 HID；**失败自动回退 `sendEvent:`** | 越狱侧 HID 有正面证据（ignuslabs 注入 dylib，iOS 15/16 rootless），但证据链薄 |

**★ 关键判断：HID 路的可用性是「进程身份 / 沙箱 / entitlement」问题，不是 iOS 版本问题。**

### 6.2 推翻的两条假设（记下来以免重犯）

1. `lyft/Hammer` **没有任何 Objective-C 源码，全是 Swift**；`Hammer/EventGenerator*.m`、`HMTouch*.m`、`IOHIDEvent+KIF.{h,m}` 都不存在（后者在 KIF 里）。
2. KIF **从不调用 `_enqueueHIDEvent:`**，它走公开的 `-[UIApplication sendEvent:]`。KIF 里也**没有** `KIF_findViewAtPoint:withEvent:`。

### 6.3 为什么不以 HID 为主

| 证据 | 内容 |
|---|---|
| `KQAR/Reticle#281`（iOS 26 真机）`[社区]` | digitizer IOHID 事件在设备进程内「constructible, accepted and **routed nowhere**」——16 种 sink/senderID/displayIntegrated/坐标空间组合**全部无报错、全部无效**；改走 `UITouch`→`sendEvent:` 后「hit-testing, gesture recognizers, scroll views and momentum all behave as they do under one」 |
| `google/EarlGrey#293`（维护者）`[社区]` | 「**doesn't work on devices due to entitlement issues**」 |
| Apple WebKit `HIDEventGenerator.mm`（至今 main）`[源码]` | 只用 `BKSHIDEventSetDigitizerInfo` + `_enqueueHIDEvent:`，**零版本分支** ⇒ 只能证明「API 存在」，不能证明「在第三方进程内有效」 |
| SimulateTouch(512★) / ZXTouch(1407★) `[源码]` | 两条经典 HID 注入实现**都跑在 SpringBoard 里**，不是 App 进程内 |
| `IOHIDEventSystemClientDispatchEvent` | 非越狱 App 进程内不行；且 iOS 15+ 必须先 `IOHIDEventSystemClientScheduleWithRunLoop(client, CFRunLoopGetMain(), kCFRunLoopDefaultMode)` 否则静默不投递 |

### 6.4 实现要点（`ios/AMTouch.m`）

**`sendEvent:` 路（主）**
- 事件对象：`-[UIApplication _touchesEvent]`；`UIEvent` 私有 `_clearTouches` / `_addTouch:forDelayedDelivery:` / `_setHIDEvent:` / `_setTimestamp:`。
- `UITouch` 私有 selector：`setWindow:`（**必须第一个调** —— KIF 注释 "Wipes out some values. Needs to be first."）、`setView:`、`setTapCount:`、`setIsTap:`、`setTimestamp:`、`setPhase:`、`setGestureView:`、`_setLocationInWindow:resetPrevious:`、`_setIsFirstTouchForView:`、`_setIsTapToClick:`（iOS 14 分支：用 `_setIsTapToClick:NO`，否则 `_setIsFirstTouchForView:YES` + `setIsTap:NO`）、`_setHidEvent:`（**iOS 9 起必需**）。
- 每个触摸仍用 IOKit 的 `IOHIDEventCreateDigitizerFingerEvent` 造 HID 事件喂给 `_setHidEvent:` —— 被丢掉的是「把 HID 事件当**输入**提交」，不是「构造 HID 事件」。
- **抬起必须复用同一个 `UITouch` 对象**。
- 坐标是 **window points**（WebKit 用 `roundf`）。

**HID 路（越狱备选）**
- 全用 `dlopen`+`dlsym`（`/System/Library/Frameworks/IOKit.framework/IOKit`、`BackBoardServices.framework`），不需要私有头文件。
- `BKSHIDEventSetDigitizerInfo` 七参（WebKit/Hammer/ignuslabs 逐字一致）：
  `(IOHIDEventRef ev, uint32_t contextID, uint8_t systemGestureIsPossible, uint8_t isSystemGestureStateChangeEvent, CFStringRef displayUUID, CFTimeInterval initialTouchTimestamp, float maxForce)`；
  Hammer 传 `(event, window.contextId, false, false, nil, 0, 0)`。**`contextID` 来自 `-[UIWindow _contextId]`**（`GSGetMainDisplay` 在 WebKit/Hammer/KIF/SimulateTouch 里**全库零命中**）。
- 必须设：hand 事件 `kIOHIDEventFieldDigitizerIsDisplayIntegrated = 1`；finger `MajorRadius = MinorRadius = 5.0`（`[社区]` 0.04 会被 OS 判成噪声）；`IOHIDEventSetSenderID` **非 0**（Hammer 注释 "Can be any value except 0"）。Hammer 用 `0x0000000123456789`，SimulateTouch digitizer 用 `0x000000010000027F`，键盘用 `0xDEFACEDBEEFFECE5`。
- 时序照抄 WebKit：`fingerLiftDelay=0.05`、`multiTapInterval=0.15`、`fingerMoveInterval=0.016`、`longPressHoldDelay=2.0`、`fingerIdentifiers[]={2,3,4,5,1}`。
- **按压时长由构造时的时间戳决定**（`mach_absolute_time()`），不是投递间隔 ⇒ 想要 30 ms 按压必须**真 sleep 30 ms** 再构造 up 事件。

### 6.5 失败检测（唯一可靠手段）

`swizzle -[UIApplication _handleHIDEvent:]`，发一个 **vendor-defined marker 事件**
（usagePage = `kHIDPage_VendorDefinedStart + 100` = `0xFF64`，字段 `data` = `(1<<16)+4 = 0x10004`），等它回来：
- 回来 ⇒ HID 真进管线，可用；
- 不回来 ⇒ 被静默丢弃，**立刻切 `sendEvent:` 路**。

已封装为 `IOSTouchHIDProbe(timeout)`。这是 WebKit / Hammer 同款机制 —— **它们都自己做了 marker/ack 栅栏，这本身就是「Apple 也不相信发了就算送达」的证据**。

> 不要用 `respondsToSelector:` / `dlsym` 判断可用性：**全是 YES，事件仍可能被静默丢弃。**

### 6.6 未证实项（别当可靠路径用）

- **Adobe AIR 是否响应同进程合成触摸：正反证据都没有**（7 组搜索全空，唯一沾边是 `airsdk/Adobe-Runtime-Support#3375` 证明 AIR 把 UIKit 触摸映射成 `flash.events.TouchEvent`）。⇒ **上真机第一步就做三步验证法**（见 §12）。
- 「忽略 `userInteractionEnabled`/`alpha`/`hidden` 的强制命中」是调研 agent **自写**的（KIF 没做这件事）。
- 手动 `beginTrackingWithTouch:`+`endTrackingWithTouch:` 能否触发 `UIButton` action：**`[未找到]`**。只有 `sendActionsForControlEvents:UIControlEventTouchDown` + `...TouchUpInside` 有硬证据（公开 API；**不检查 isEnabled、不驱动高亮**）。

### 6.7 硬性前置条件 `[社区]`

`-[UIView hitTest:withEvent:]` 决定 `UITouch.view` ⇒ 目标视图必须
`userInteractionEnabled == YES`、`hidden == NO`、`alpha > 0.01`。
**游戏若把容器关掉，两条路会同时失效** —— 这是必须在真机上先验证的点。

---

## 7. UI / 交互

一个悬浮控制面板（`UIWindow`，`windowLevel = UIWindowLevelAlert + 1`）：

- **悬浮球**：点一下展开展板；可拖动，位置持久化。
- **脚本管理**：从 `Documents/AutoClick/`（越狱另支持任意路径）列出 `.auto`，也支持「导入」（`UIDocumentPicker` / `iTunes 文件共享` / `Open In`）。
  > **实现勘误**：本节初稿写的是 `Documents/AMAutoClick/`，而代码（`AMRuntime.m` 的 `-discoverScripts`）用的是 `Documents/AutoClick/`。
  > **以代码为准**（`Documents/AutoClick/`）。三处搜索顺序：`Documents/AutoClick/*.auto` → `Library/Application Support/AutoClick/*.auto` → main bundle 根。
- **控制**：开始 / 暂停 / 停止 / 单步执行一轮；显示当前场景名、帧率、命中数。
- **参数**：轮询间隔、全局 sim 覆盖、点击后延迟、调试模式（叠加显示搜索区与命中框）。
- **日志**：最近 N 行 + 导出。
- 面板自身**不参与匹配**（截图前隐藏或直接从 framebuffer 排除）。

---

## 8. 目录结构（**实况**，与初稿的三处偏差已标注）

```
ios/auto/
├─ core/                     # 纯 C99，零平台依赖 ✅ 全部已实现
│   ├─ auto_match.{h,c}      # NCC 匹配（FFT TM_CCOEFF_NORMED）✅
│   ├─ am_fft.{h,c}          # 混合基 Cooley-Tukey，被上者用 ✅
│   ├─ am_container.{h,c}    # ZIP + inflate + PNG ✅
│   ├─ am_json.{h,c}         # JSON 解析器（两遍零 malloc）✅
│   ├─ auto_script.{h,c}     # .auto 模型层 + 变体选择 + 坐标适配 ✅
│   └─ auto_engine.{h,c}     # 执行器（条件折叠 / 场景派发 / 动作）✅
│   ✗ auto_screen.{h,c}      # **不存在**：屏幕抽象在 auto_script.{h,c} 里
│   ✗ auto_log.{h,c}         # **不存在**：日志走 am_engine_host.trace 回调
├─ ios/                      # 平台适配 ✅ 已实现（编译验证在 CI）
│   ├─ AMCapture.{h,m}       # presentRenderbuffer hook + glReadPixels
│   ├─ AMTouch.{h,m}         # 伪造 UITouch + _touchesEvent + sendEvent:（HID 仅越狱侧）
│   ├─ AMRuntime.{h,m}       # am_engine_host 接线、脚本发现、引擎线程
│   ├─ AMConfig.{h,m}        # 部署期配置 + 面板状态持久化（单独 plist）
│   └─ AMControlPanel.{h,m}  # 悬浮球 + 控制板
├─ tweak/                    # Theos：deb ✅
│   ├─ Makefile  control  AMAutoClick.plist  Tweak.x
│   ✗ layout/DEBIAN/*        # 初稿写的，实际不需要（无 postinst/prerm）
├─ dylib/                    # Theos：dylib ✅
│   ├─ Makefile  control  dylib.x  tools/inject-dylib.mjs
│   └─ tools/make-fake-dylib.mjs   # 造无代码 Mach-O，验证注入器头部算术
├─ tests/                    # ✅ 七套（377 例）
│   ├─ test_fft test_json test_script test_matcher
│   ├─ test_matcher_neg test_package test_engine
│   └─ pg_guard.{c,h}  bench_*.c  bench_cases.h
├─ tools/                    # ✅ 夹具生成 + 构建脚本 + lint-workflow.mjs
├─ matcher_golden/  matcher_golden_neg/  matcher_golden_pkg/
└─ decomp/                   # jadx 反编译参考实现（已 gitignore，勿提交）
```

**目录位置的勘误**：平台层的初稿目录是顶层 `ios/autoclick/`，实际按本节冻结在 `ios/auto/ios/`（`ios/autoclick/` 已删）。
`ios/tweak/`、`ios/deb/`、`ios/prototype/`、`ios/patched/` 都是 **SpLogin（P10-B）** 的，与本交付无关。

---

## 9. 构建与出包

### 9.1 已具备（本机 Windows）`[实证]`

```powershell
# 七套测试（MSVC；/utf-8 必需，否则中文注释报 C4819/C1071）
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$cf     = "/nologo /W4 /O2 /std:c11 /utf-8 /D_CRT_SECURE_NO_WARNINGS"
$inc    = "/I core /I tests /I matcher_golden /I matcher_golden_neg /I matcher_golden_pkg"
$core   = "core\auto_script.c core\am_json.c core\am_container.c core\auto_match.c core\am_fft.c"

# 容器+格式+匹配+FFT 全链路（21 例：ZIP/PNG 断言 + 17 个真实匹配用例）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_package.exe /Fo:tests\build\ $inc tests\test_package.c $core"
# .auto 模型层（56 例：场景/条件/变体选择/坐标适配/点击矩形/ZIP 路径）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_script.exe /Fo:tests\build\ $inc tests\test_script.c $core"
# 执行引擎（60 例：条件折叠/场景派发/点击矩形/缓存/超时/合成夹具自检）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_engine.exe /Fo:tests\build\ $inc tests\test_engine.c core\auto_engine.c $core"
# FFT 自身（125 例：与直接 DFT 逐元素对比 + 卷积定理 + 尺寸查询 + [6] 加速后端一致性 6 例）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_fft.exe /Fo:tests\build\ /I core tests\test_fft.c core\am_fft.c"
# JSON 解析（84 例）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_json.exe /Fo:tests\build\ /I core tests\test_json.c core\am_json.c"
# 正/负样本匹配（13 + 18 例）
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_matcher.exe /Fo:tests\build\ $inc tests\test_matcher.c core\auto_match.c core\am_fft.c core\am_container.c"
cmd /c "call `"$vcvars`" >nul && cl $cf /Fe:tests\build\test_matcher_neg.exe /Fo:tests\build\ $inc tests\test_matcher_neg.c core\auto_match.c core\am_fft.c core\am_container.c"
```

> **两个坑**：① `golden_cases.h` / `golden_neg_cases.h` / `golden_pkg_cases.h` **不在 `tests\` 里**，
> 而在各自夹具目录 —— 所以 `$inc` 里那三个 `/I` 是承重的，缺了会报 `fatal error C1083`，
> 而**旧的可执行文件不加 `/I` 也能"通过"**（过期二进制）。② `D_CRT_SECURE_NO_WARNINGS` 必须
> 走命令行，在源文件里 `#define` 无效（`<string.h>` 已被头文件先拉进来）。

运行（参数是夹具目录 —— **这几个参数都是承重的，实测过少传会失败**）：

```powershell
tests\build\test_package.exe   matcher_golden_pkg       # 不是 ...\pkg
tests\build\test_script.exe    matcher_golden_pkg\pkg   # 不传也行，会自己找同级 sample.auto
tests\build\test_engine.exe    matcher_golden_pkg\pkg   # ★ 少传 \pkg => 36 passed, 1 failed
tests\build\test_fft.exe ;  tests\build\test_json.exe  matcher_golden_pkg
tests\build\test_matcher.exe   matcher_golden ;  tests\build\test_matcher_neg.exe matcher_golden_neg
```

> **两个实测出来的参数陷阱**（都是"看着像产品 bug，其实只是路径"）：
> ① `test_package` 要的是**没有 `pkg` 的那一层** —— 它的 17 个匹配用例读 `<dir>/pkg/<file>`，
> 而 `sample.auto` 在 `matcher_golden_pkg/` 里。现在两个路径都能开（逐个候选探测），
> 但 CI 与文档统一按上表写。
> ② `test_engine` **必须带 `\pkg`**：它把 `<arg>` 当作存放 `script.json` + 散图的那一层。
> 少传的后果不是崩溃，而是 **`36 passed, 1 failed`** —— 有 24 个用例被"目录里没东西"静默跳过。
> ⇒ 任何"用例数变少"的现象都**先怀疑夹具路径**，再怀疑代码；这也是 CI 里逐套校验
> `"N passed"` 数值（而不只看退出码）的原因。

结果：`test_engine` **60 passed** / `test_script` **56 passed** / `test_package` **21 passed** /
`test_fft` **125 passed** / `test_json` **84 passed** / `test_matcher` **13 passed** /
`test_matcher_neg` **18 passed**，**合计 377 例，全部 0 failed、零 warning**。
（`test_matcher_neg` 另报「错配峰值区间上界 = 0.422071，sim = 0.80，最小余量 = 0.378」。）

> `test_engine` 的合成夹具（`tests\test_engine.c` 的 `write_gray_png`）是**手写 PNG**：
> 真彩 type 2 + zlib 头 `78 01` + stored deflate 块 + Adler-32 + IHDR/IEND（CRC 写 0，`am_container` 不校验）。
> 四个字段全部踩过坑：**颜色类型必须是 type 2/6**（`am_png_decode_gray` 对灰度 type 0 返回
> `AM_ERR_UNSUPPORTED`）、**stored 块头是三比特一个字节，LEN 紧跟其后不再对齐**、
> **缓冲要留满 `2 + 块头*5 + raw + 4`**、**Adler-32 必须计入 IDAT 长度**。
> 这些只有用**独立实现交叉验证**（python `zlib.decompress`）才抓得住 —— C 侧不校验 Adler-32，
> 出错时会静默解出错误像素。


### 9.2 iOS/theos（CI 侧）`[实证]`

- **`TARGET` 的 SDK 版本必须从系统探测，不能写死**：初稿写的 `iphone:clang:16.5:15.0`
  在 GitHub 的 `macos-latest` 上直接
  `Error: Your chosen SDK, "iPhoneOS16.5.sdk", does not appear to exist.` ⇒ 整个构建挂掉，
  **而失败信息只有一行**。实测 runner 上是 Xcode 26.6 / `iPhoneOS26.5.sdk`。
  现在的写法（`tweak/Makefile` 与 `dylib/Makefile` 同）：
  ```make
  SDKVER := $(shell xcodebuild -showsdks 2>/dev/null | sed -n 's/.*-sdk iphoneos\([0-9.]*\)$$/\1/p' | sort -V | tail -1)
  TARGET = iphone:clang:$(SDKVER):15.0
  $(info [AMAutoClick] xcodebuild -showsdks 选出的 iPhoneOS SDK = "$(SDKVER)" …)
  ```
  `$(info)` 那行是承重的：它被 `tee` 抓进 build.log，**SDK 到底选了哪个是可观测的**。
  （写死版本的动机——"防 SDK 漂移"——在真 runner 上被反噬了。）
- **`dylib` 必须自己加 `-Wl,-not_for_dyld_shared_cache`**：rootful 那条腿报
  `ld: Shared cache eligible dylibs cannot use '-undefined dynamic_lookup' or '-U' …` 而
  rootless 成功（是否给这个标志取决于 Theos 的 packaging scheme，不是源码）。
  语义上也对：这个 dylib 被注入 App 包的 `Frameworks/`、靠 `LC_LOAD_DYLIB` 载入，
  本来就不该进 dyld 共享缓存。★ **写法不能统一**：`-undefined dynamic_lookup` 是 clang
  认识的驱动选项，而 `-not_for_dyld_shared_cache` 只认链接器 ⇒ 必须写 `-Wl,-not_for_dyld_shared_cache`
  （裸写会得到 `clang: error: unknown argument`）。
- **Theos 的 Debug 构建带 `-Werror`** ⇒ `-Wdeprecated-declarations` 是**硬失败**而不是警告。
  `ios/AMCapture.m` 是平台层**唯一** include OpenGLES 并大量调用 GL 的文件（66 处），
  所以在那一个文件顶部 `#pragma clang diagnostic push` + `ignored "-Wdeprecated-declarations"`、
  文件末尾 `pop`；**不要**用全局 `-DGLES_SILENCE_DEPRECATION`（那是把整个项目的
  deprecation 都关掉，越权）。
- **属性的存储不是 ivar 时，既不要写 `@synthesize` 也不要声明 ivar**。
  `AMCapture` 的 `hasFrame`/`backend` 读写文件级 `gFrame`/`gBackend`，加了 `@synthesize`
  之后 clang 报 `error: ivar '_backend' which backs the property is not referenced in this
  property's accessor [-Werror,-Wunused-property-ivar]`。（class extension 只能把 readonly
  「升级」成 readwrite，且内存修饰符集合必须与头里**逐字一致**。）
- `brew install ldid xz dpkg`（**不是** `ldid`；`xz` 提供 `lzma`，否则 dm.pl 打包失败；
  `dpkg` 是 deb 结构断言要用的 `dpkg-deb`，macOS runner 上默认没有）。
- `Architecture: iphoneos-arm`（rootless 时 Theos 自动改写为 `iphoneos-arm64`）；`Depends: mobilesubstrate`（ElleKit 声明 `Provides: mobilesubstrate (= 99)`）。
- 过滤器 plist：`Filter = { Bundles = ("com.leiting.wf"); Executables = ("worldflipper"); }`
  （**不要写 `Mode` 键**，无任何证据）。★ 这个文件是 **NeXTSTEP 旧 ASCII 格式**
  （Cydia/Substrate 的老写法，148 B / 10 行），**`plistlib` 只认 XML 与 binary、对它一律
  `InvalidFileException`** —— 校验要用 `ios/auto/tools/check-plist.sh` 的三级降级。
  另注：substrate 的语义是「不同键之间是**或**」⇒ 只要可执行名叫 `worldflipper` 就会注入，
  即使 bundle id 被重签改了（这正是想要的兜底）。
- 引用私有框架符号用 `-undefined dynamic_lookup`（Theos 不会自动加）。
- 双 deb：`make package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless THEOS_PACKAGE_DIR="$PWD/dist/rootless"` 与不带 scheme 的 rootful 版。
- 越狱设备：iPhone 7 Plus / iOS 15.8.3 / **A10 = arm64（非 arm64e）** ⇒ Dopamine 2.x 或 palera1n rootless + ElleKit。

#### 9.2.1 CI 里的「验证验证者」`[实证]`

**本机没有 clang/Xcode/调试器**，iOS 代码的首次编译发生在 CI 上，所以 CI 里有一半的
步骤在检查「刚才那个结论本身是不是假的」。踩过的三类假绿：

| 假绿 | 真实症状 | 现在的对照 |
|---|---|---|
| 检查器自己不工作 | `lint-workflow.mjs` 的块标量判据把 `$` 写成 `\$`（JS 正则里 = 字面美元符），一条都没匹配到，**而它照样打印「体检通过」** | `--selftest` 注入 5 个已知必错的变异，断言报错（5/5） |
| 解析别人文件的检查器失配 | `check-test-patterns.mjs` 的正则以 `$` 结尾，而工作流为绕开 `bash -e` 的守卫陷阱给每行加了 `|| true` ⇒ **7 行一条都匹配不上**，脚本打印「0 个不匹配 / 模式与真实输出一致」 | 正则去掉 `$` 锚 + **断言至少解析出 7 条** + `--selftest` 把期望值全改成 `1 passed` 断言报错 |
| 诊断通道自己把 job 判红 | `::notice::` 后的文本**就是 shell 源码**（GitHub 把它写进下一步的临时脚本）⇒ 含 `$Binary` 的那行让脚本 `unbound variable` 退出，**而编译/打包/断言全绿** | 源头换文本 + 出口 `sanitize()` + `tsan-sanitize.sh`（要求「原样文本确实会炸」的阳性对照） |

另有 `tests/audit_caps.c`（core 回归末尾）：量出真脚本在每个 `AM_MAX_*` 上的用量并要求
一个都不溢出 —— **上限估小了只会置 `s->overflow_*` 计数，脚本照样"加载成功"**，
现场表现是「有些按钮不点」而日志里什么都看不出。实测这份脚本完整装进引擎：
11/128 组、9/128 变量、10/256 场景、单场景 1 事件、单事件 2 条件 / 1 动作、
单变量 1 裁切、单组 3 变体，`sizeof(am_script) = 371264` 字节。

### 9.3 非越狱侧载

真身是 **`ios/auto/dylib/tools/inject-dylib.mjs`**（本节初稿写的 `ios/importer/tools/inject-dylib.mjs`
**不存在** —— `ios/importer/` 下只有 `tools/`，没有这个脚本；`ios/patched/` 里只有一个 `.gitignore`）。
用法：`node inject-dylib.mjs --app=<.app 目录> [--dylib=<路径>] [--name=AMAutoClick] [--check] [--force]`。

**⚠️ 本节初稿的一条前提是错的，已作废**：「必须在 `client-patch/build/patch-ipa.mjs` **之后**运行」。
`patch-ipa.mjs` 里 grep 不到任何 `LC_LOAD_DYLIB` / `Frameworks/` / `@executable_path` 相关代码
（`client-patch/build/lib/ios-macho.mjs` 也只有**只读**解析），两者互不依赖，**顺序随便**。

**它在目标二进制上实测过的数字**（`worldflipper`，108757200 B）：
- 头部空闲区：`ncmds=67` / `sizeofcmds=7584`（0x1DA0）⇒ 命令区末尾 `0x1dc0`，到首页边界 `0x4000`
  之间有 **8768 字节且逐字节为 0**；一条 `LC_LOAD_DYLIB` 是 72 B。
- 注入后逐字节比对整份文件（108 MB）：**只有 52 字节不同** —— `ncmds`(0x10) +1、
  `sizeofcmds`(0x14) +72、命令本身（到 0x1e04）。**文件长度一个字节都没变。**
- `ipsw macho info --loads` 复核：`067: LC_LOAD_DYLIB @executable_path/Frameworks/AMAutoClick.dylib (1)`，
  排在 `066: LC_CODE_SIGNATURE` 之前。幂等：重跑报「已经注入过了，不改动」。
- 为什么不惜代价不移位：**AIR 的 AOT 加载器按偏移读文件**，一旦越界就要挪整个文件、
  改 `__TEXT` 之后所有 `fileoff` —— client-patch 那边的启动黑屏就是这么来的。**宁可直接失败。**

⚠️ 未加密才能注入：`LC_ENCRYPTION_INFO_64 cryptid = 0`（本包来自 DumpDecrypter）。
`cryptid != 0` 时脚本直接 fail，**不要**绕过 —— 改完头部的加密包在设备上会被解密器拒绝。
⚠️ dylib 内**不可**用 MSHookFunction/ellekit API，**不可** include `rootless.h`。
⚠️ 注入之后必须**重新签名整个 `.app`**（改过头的主二进制的原签名已失效），再打包侧载。

---

## 10. 风险与未证实项

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | iOS 版游戏 UI 布局是否与 Android 模板一致 | **致命**（匹配全失败） | ⚠️ **必须在真机取一张 iOS 截图，用 `ios/auto/tools/make_matcher_golden.py` 跑一遍**（本节初稿写的 `tools/make_matcher_golden.py` 路径不存在）。这是上真机前唯一无法在 Windows 上消除的未知 |
| 2 | `_enqueueHIDEvent:` 在 iOS 15.8.3 是否可用 | 高（决定注入方案） | 主/备双路 + 失败自愈；见 `.research/ios-touch-synthesis.md` |
| 3 | AIR 是否响应同进程合成触摸 | 高 | ⚠️ **仍无任何直接证据**（7 次搜索全空，无正反例）。但已证伪的相邻命题：`KQAR/Reticle#281` 在 iOS 26 真机上试了 16 种组合全部**无错误且无效果**；`EarlGrey#293` 明说 device 上因 entitlement 不行。⇒ HID 路是**进程身份/沙箱/entitlement 问题，不是版本问题**，非越狱 App 进程内基本死路。**落地方案：非越狱走伪造 `UITouch` + `sendEvent:`；越狱侧才把 HID 当第二条腿，且必须先跑 §2.5 的 marker 探针确认**。真机三步验收见 `.research/ios-touch-synthesis.md` §5-Q3 |
| 4 | `glReadPixels` 读到的是当前帧还是上一帧 | 中 | 落在 `presentRenderbuffer:` **之前**读（present 之后 back buffer 内容未定义）；最坏滞后一帧。`AMCapture` 在取帧失败时**沿用上一帧**并计入 `dropped`，`-stats` 里可见。真机实测确认 |
| 5 | 非越狱侧载 7 天续签 | 中 | 用户体验问题，文档说明 |
| 6 | ~~`am_inflate_zlib` 已改非 static 但头文件未声明~~ | — | ✅ 已补进 `core/am_container.h` |
| 7 | 风控：固定轨迹点击可能被判定为脚本 | 低（私服） | 已复刻「矩形内随机取点」，天然带抖动 |
| 8 | **标量 C 的 FFT 比预算慢 4.26 倍**（§4.2.1） | 高 → **中** | ✅ 已落地 vDSP 后端（`core/am_fft_accel.c`，见 §4.2.1 第 1 条）。**剩余风险改为"没在真机上量过"**：4.26 倍是 Windows/MSVC 上的标量数字，A10 上 vDSP 的 5~20 倍只是预期。缓解：`am_engine_match` 已有帧号缓存（同一帧不重算），场景门每轮只评估可达节点，正常稳态 1~3 次匹配/帧 |
| 9 | FFT 内核已在 Windows 上被证正确（125 例，含 `[6]` 段的实现无关不变量），但 vDSP 路径是**另一份实现** | 中 | 已处置：CI 在 macOS 上**开着** vDSP 跑全部七套（377 例），其中 `test_package` 的 21 个用例有 17 个是真实图像 ⇒ 等价性验证在每轮 CI 上都做。**注意不能拿标量版当参考实现**（macOS 上标量路径根本不会被调用，那是自己跟自己对） |
| 10 | ~~`am_match_template` 的 ROI 缓存键只含尺寸不含内容~~ | — | ✅ 已修：`ctx_prepare` 现在也 `memcmp` 模板与 ROI 的像素副本（见 §4.4） |
| 11 | ~~iOS 版 `nativeScale` 需合成伪 densityDpi 供变体选择（§2.5）~~ | 中 | ✅ 口径已纠正：density **不是**由 `nativeScale` 算，而是 **`帧缓冲宽 / 窗口点宽 × 160`**（`AMTouch -pixelToPointScaleInWindow:` 现算，优先用 `[AMCapture shared].frameSize.width / window.bounds.size.width`）。iPhone 7 Plus 逻辑 1242×2208（scale 3.0）/ 物理 1080×1920（nativeScale 2.608），**GL 帧缓冲是 1242×2208** ⇒ 用 nativeScale 会让 density 偏小 13%、**触摸坐标整体偏 1.15 倍**（1200 宽画面上 180 像素）。变体选择只比 density，故该值必须与录制机同一量纲 |
| 12 | 本机**没有任何 iOS 编译能力**（无 clang / 无 Xcode / 无 debugger） | 中 | 平台层代码的正确性只能靠 **CI 编译 + `nm -u` 符号断言**兜住；**运行时行为（hook 是否装上、触摸是否生效）必须在真机上验**。不要把"CI 绿了"当成"能跑" |
| 13 | AIR/Stage3D 可能渲到一个**尺寸与窗口不同的离屏 renderbuffer**再缩放上屏 | **高**（坐标整体偏 ⇒ 全点不中） | 已处置：取帧时同时问 `GL_VIEWPORT` **和**当前绑定的 renderbuffer 尺寸（`AMGLRenderbufferSize`），不一致时以 renderbuffer 为准；触摸换算系数用「帧缓冲宽 / 窗口点宽」**现算**，与帧同源。真机验收第 7 步专门查这一项 |

---

## 11. 实施顺序

1. ✅ `core/auto_match` + `core/am_container` + 三套黄金测试（**已完成，全绿**）
2. ✅ `core/am_fft` —— 混合基/radix-2 FFT（**119 例全绿**；pad 取 2 的幂，见 §4.2.1）
3. ✅ `core/am_json` —— 最小 JSON 解析器（**84 例全绿**，两趟扫描零中间 malloc）
4. ✅ `core/auto_script` —— 模型层 + 变体选择 + 坐标适配（**56 例全绿**，见 §9.1）※§2.5 的三条语义
   已按反编译产物逐条核对；`am_adapt_rect` 从 Android 的**非均匀**双系数改成了**单一均匀系数**（理由见 §2.5）
5. ✅ `core/auto_engine` —— 场景/条件/动作执行器（复刻 §2.2–2.4；**60 例全绿**，含合成夹具自检）※
   与 Android 的两处**刻意偏离**：① 无门场景直接判为 active（不复制 `framework/b.java` 的静态
   `f998h` 握手 —— 对所有场景都无门的脚本，两者净效果相同）；② `cond_image` 的搜索区在
   「模板 rect ∩ 搜索变量 crop」为空时回退到「模板 rect 外扩 `expand_size`」（Android 无条件求交，
   异型分辨率下交集可能为空 ⇒ 场景静默永不触发）
6. ✅ **Windows 侧端到端验证**：`test_engine` 的 `[A]` 段用「幻想连战.auto」+ `matcher_golden_pkg`
   的真实 ori 截图喂帧，断言点击点落在动作自己的 `crop` 矩形内；`[B]` 段用手写 PNG 合成的
   两张互不相同的标记图，验证「条件折叠 → 场景派发 → 点击落点」整条链（**60 例全绿**）。
7. ✅ iOS 侧换 FFT 核（Accelerate/vDSP）—— **已落地且每轮 CI 都在验**（`core/am_fft_accel.c`；
   等价性靠 `test_fft` `[6]` 段的「与实现无关不变量」+ `test_package` 的 17 个真实图像用例，
   CI 在 macOS 上是**开着 vDSP** 跑完 377 例的）。**仍未在真机上量过耗时**（§10 风险 #8）。
8. ✅ `ios/auto/ios/` 五个类（`AMCapture` / `AMTouch` / `AMRuntime` / `AMConfig` / `AMControlPanel`）
   —— 源码已完成。**注意：本机无 clang，首次编译发生在 CI 上，运行行为必须真机验（风险 #12）**
9. ✅ `tweak/`（deb）+ `dylib/` 两个 Theos 工程 + `dylib/tools/inject-dylib.mjs`（已在真实
   `worldflipper` 上跑通，见 §9.3）
10. ✅ CI（`.github/workflows/ios-autoclick.yml`，2×2 矩阵 + 377 例回归 + 产物结构断言）；
    ⬜ **真机验收清单**（见 §12）
11. ⬜ 真机：先验风险 #1（iOS 截图跑匹配），再验 #2/#3（注入），最后跑完整脚本

---

## 12. 真机验收清单（按顺序做，每一步失败都会让后面的话没意义）

**第 0 步 —— 先确认 iOS 上的画面能不能匹配（风险 #1，最致命）**
1. 越狱 iPhone 7 Plus 装上 deb，进游戏到主界面。
2. 面板上按「导出当前帧」→ 得到一张 PNG（`AMCapture -previewImage` / 内部帧缓冲）。
3. 把这张 PNG 拷回本机，用 `ios/auto/tools/make_matcher_golden.py` 对 `幻想连战.auto`
   的 24 个模板各跑一遍，看**峰值**。判据：`>= sim (0.8)`。
   - 若普遍低于 0.8 但形状对得上 ⇒ 大概率是**缩放**问题（§2.5 的适配口径），不是匹配坏了。
   - 若峰值普遍 ≈ 0 ⇒ 画面完全不同（分辨率/UI 改版）⇒ **必须先重录模板**，别再往下走。

**第 1 步 —— 取帧是否真的在跑**
4. Console 里过滤 `[AMAutoClick]`；`AMCapture -stats` 的 `frames` 应随游戏画面持续增长。
   `dropped` 若持续增长说明消费端跟不上（正常，见 §4.2.1），但 `frames` 必须涨。
   - `frames == 0` ⇒ hook 没装上（`presentRenderbuffer:` 没被调用 / 不是 GL 主路）⇒ 查 `backendName`。

**第 2 步 —— 触摸是否真的到达游戏（风险 #3，第二致命）**
5. 先用 `AMTouch -describeHitAtPoint:` 在 Console 打印目标点的 `hitTest:` 链
   （`.research/ios-touch-synthesis.md` §5-Q3 第 1 步）。**必须打印出 AIR 的 UIView 子类**，
   不能是 nil、也不能只有 UIWindow。
   - 若链里出现 `uie=0`（`userInteractionEnabled == NO`）或 `hidden=1` / `alpha≈0`
     ⇒ 合成触摸一定会被丢弃，需要用 §4.1 的强制命中。
6. 再 swizzle `-[UIApplication sendEvent:]` 只打日志，**用手指点一下**目标按钮，记录真实手指
   到达的 `touch.view` 类名；与第 5 步合成时命中的类名对比。**不一致就还不能往下走。**
7. 面板上按「测试点击」：在游戏画面上画一个准星，点一次，看准星位置。
   - 点偏但方向对 ⇒ 坐标换算错（先怀疑 §10 风险 #11 的 density 口径）。
   - 完全没反应但 Console 无报错 ⇒ 回到第 6 步。

**第 3 步 —— 完整脚本**
8. 把 `幻想连战.auto` 放进 `Documents/AutoClick/`（**不是 `Documents/AMAutoClick/`**，见 §7）。
9. 面板上选脚本 → 启动；观察是否按预期的场景顺序推进。
10. 打开面板的「日志」页，确认 `am_engine_last_error` 与 `taps` 计数；`taps` 为 0 而 `frames` 在涨
    ⇒ 所有条件都不成立 ⇒ 回到第 0 步。

**第 4 步 —— 非越狱侧**
11. `node ios/auto/dylib/tools/inject-dylib.mjs --app=<解密的 worldflipper.app>`（先 `--check`）。
12. 重新签名整个 `.app` → 打包 → 侧载 → 7 天内启动。
13. 因为没有人能点面板，必须靠 `AMConfig` 的 `autoStart` + `preferredScriptName`（见 §7）。
    Console 里 `[AMAutoClick] dylib 已就绪：…` 是唯一的存活证据。
