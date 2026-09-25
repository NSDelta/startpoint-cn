#!/usr/bin/env node
// ⚠️ 墓碑（tombstone）—— 本文件已废弃，**不再包含任何补丁逻辑**。
//
// A1b 重基线（P10-A）把本文件曾经独有的三项能力全部并入**唯一入口**
// `client-patch/build/patch-ipa.mjs`：
//   ① lib/ios-abc.mjs 的 ABC 常量池等长改写（DevConfig_gf_ios.apiServer 的
//      Custom("https","shijtswygamegf.leiting.com") 一对条目）
//   ② 回读断言 + `<out>.build-report.json`（含"改动字节范围 = 声明窗口"的越界检查）
//   ③ lib/zip-ipa.mjs 替代 `jar uf0`（jar 丢外部属性/可执行位 → AltStore 报
//      "The app is in an invalid format."）
// 并**同时补齐了**本文件当初漏掉的基线六项功能补丁（实名提示 / 全新安装登录弹窗 /
// 欢迎横幅 / 使用许可协议+隐私政策门 / Bundle ID 资源校验 / sohu 外发屏蔽）——
// 缺这六项的产物装到真机会卡在 SDK 弹窗与首登流程（B0 产物实测差分为证）。
//
// 为什么还留着这个文件而不是直接删：
//   `tools/ios_ipa_patch.test.cjs`（P7 的写入集，本线不得修改）里有一条用例把这个路径
//   当 CLI 入口来 spawn。为了让那条用例继续反映"缺 --host 必须拒绝并报出 --host"的契约，
//   这里保留文件、只留"已废弃 + 正确用法"的提示并**非零退出**。真正的入口契约由
//   `client-patch/build/patch-ipa.mjs` 承担（同一条用例把它当入口也成立）。
//
// 删除片段（交给集成者/P7 落地）：删掉本文件，并把
//   tools/ios_ipa_patch.test.cjs:163 的 cli 常量改为 "patch-ipa.mjs"；
//   ios/README.md 里的 "patch-ios-ipa.mjs" 已由本线改为 "patch-ipa.mjs"。

const ENTRY = 'client-patch/build/patch-ipa.mjs';

console.error(`ERROR ${'client-patch/build/patch-ios-ipa.mjs'} 已废弃（A1b 重基线，B0 派生件已并入唯一入口）。`);
console.error('本文件不再接受任何参数、不会改写任何文件。');
console.error(`请改用：node ${ENTRY} --ipa=<输入.ipa> --host=<局域网地址> --port=<端口> --out=<输出.ipa> [--guard-mode=launch]`);
console.error('缺少 --host 时唯一入口同样会拒绝执行（目标端点只能来自参数，仓库内不内嵌任何实例地址）。');
process.exit(2);
