/**
 * 参考适配器：把 P6 交付片段（自研登录页）的 5 个 `.pcode` 方法体块接进
 * `build-client.mjs --as3-hook`。
 *
 * 为什么是「参考适配器」而不是通用工具：
 *   P6 的交付物是**路线 B 的 pcode 块**（`blocks/*.pcode` + 逐方法 `bodyIndex`），
 *   不是 AS3 源码。这里把它做成一个 `transformSwf(ctx)`，于是
 *   `--as3-hook` 这条通路可以零依赖（不需要 FFDec 的 EXPERIMENTAL AS3 编译器）
 *   地把自研登录页打进去。
 *
 * 依赖：只要 FFDec 本体（`ctx.ffdecJar` + `ctx.javaExe`）+ 本仓库的
 *   `build/lib/abc-index.mjs`（自研 ABC 解析器）。不需要 AS3 编译器。
 *
 * 块文件位置：环境变量 `SP_CN_P6_BLOCKS_DIR`，默认 `D:\wfcnmod\交付片段\p6\blocks`。
 *   目录或任一 `.pcode` 缺失 **显式抛错**，不静默跳过（P6 的教训：`-replace` 在输入块
 *   文件不存在时**仍然 exit 0**，并把靶方法体写成空体 ⇒ 只看 exit code 会翻车）。
 *
 * 自校验（全部失败即抛错，绝不「跑完就算成功」）：
 *   ① 回读 pcode 逐行一致（归一化：去缩进 / 去空行 / 去 debug 行）
 *   ② 其它方法体 sha 全不变（other_bodies_changed = 0）
 *   ③ 方法体总数不变（全 SWF 96,392）+ DoABC tag 数不变（285）
 *   ④ 5 个 bodyIndex 与 codeLength 与 P6 交付表逐项一致（喂给 `-replace` 的数字必须对）
 *   ⑤ 与 P6 参考产物 sha256 一致（不一致只报警不回滚，便于定位 FFDec 版本差异）
 *
 * 用法（唯一合法的用法就是给 `--as3-hook`）：
 *   node client-patch/build/build-client.mjs \
 *     --base apkipa/V1.8.1.apk --host 192.168.1.10 --port 8080 \
 *     --out out/sp-cn-181-unsigned.apk \
 *     --ffdec <ffdec.jar> --as3-hook client-patch/build/as3-hook-p6-pcode.mjs \
 *     --rename-package --rename-to cn.starpoint.a \
 *     --zipalign <zipalign> --apksigner <apksigner> --work D:/wfcnmod/tmp/p7b/work --keep-work
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { findAbcTags, parseAbc, findMethodBody, classListDigest, locateClassAbc } from "./lib/abc-index.mjs";

const FQCN = "pinball.channels.dummy.ChannelSDKDummy";

/** P6 `MANIFEST.md` §3.2 的交付表：顺序 / bodyIndex / 块文件 / 原始字节码 / 注入后字节码。 */
const TARGETS = [
    { method: "startLoginServer", bodyIndex: 7268, block: "startLoginServer.pcode", baseCode: 9, outCode: 827, blockBytes: 38401 },
    { method: "testLogin", bodyIndex: 7266, block: "testLogin.pcode", baseCode: 130, outCode: 5057, blockBytes: 306544 },
    { method: "testLoginReport", bodyIndex: 7265, block: "testLoginReport.pcode", baseCode: 118, outCode: 1760, blockBytes: 119542 },
    { method: "testHeartbeat", bodyIndex: 7267, block: "testHeartbeat.pcode", baseCode: 100, outCode: 3212, blockBytes: 215302 },
    { method: "dispose", bodyIndex: 7287, block: "dispose.pcode", baseCode: 1, outCode: 241, blockBytes: 21356 },
];

const DEFAULT_BLOCKS_DIR = "D:\\wfcnmod\\交付片段\\p6\\blocks";
/** P6 参考产物（`MANIFEST.md` §5）：两次独立构建相同。 */
const P6_REF_SHA256 = "156edd0cad4956fb18683fb6ff2e5aca787e7a3bea02c4c80645079479191f24";
/** P6 链式 `-replace` 每步的中间产物字节数（`p6-build-report.json` → chain）。 */
const P6_STAGE_BYTES = [29054163, 29060779, 29062690, 29067086, 29067411];
/** P6 实测全 SWF 方法体总数（所有 DoABC tag 的 method_body 求和）。 */
const P6_TOTAL_BODIES = 96392;
/** P6 实测 DoABC tag 数。 */
const P6_DOABC_TAGS = 285;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * pcode 文本归一化：FFDec 重存后重新缩进，行首空白不是语义；
 * debug 行号允许变化（P6 `MANIFEST.md` §3.3.4）。
 */
function normalizePcode(text) {
    const dropped = [];
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const kept = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;
        if (/debugline/i.test(line)) { dropped.push(line); continue; }
        kept.push(line);
    }
    return { lines: kept, droppedDebug: dropped.length };
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

export async function transformSwf(ctx) {
    const log = (m) => (ctx.log ? ctx.log(m) : console.log(m));
    const failures = [];
    const notes = [];
    const chk = (name, ok, detail) => {
        if (!ok) failures.push(`${name} —— ${detail}`);
        log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` [${detail}]` : ""}`);
        return ok;
    };

    // ── 输入 ──
    if (!Buffer.isBuffer(ctx.logicalSwf)) throw new Error("as3-hook-p6-pcode: ctx.logicalSwf 不是 Buffer");
    if (!ctx.ffdecJar || !fs.existsSync(ctx.ffdecJar)) throw new Error(`as3-hook-p6-pcode: --ffdec <jar> 缺失或不存在：${ctx.ffdecJar}`);
    const javaExe = ctx.javaExe || "java";

    const blocksDir = process.env.SP_CN_P6_BLOCKS_DIR || DEFAULT_BLOCKS_DIR;
    if (!fs.existsSync(blocksDir) || !fs.statSync(blocksDir).isDirectory()) {
        throw new Error(`as3-hook-p6-pcode: pcode 块目录不存在：${blocksDir}`
            + `（用环境变量 SP_CN_P6_BLOCKS_DIR 指定，或从 P6 交付片段取 blocks/）`);
    }
    for (const t of TARGETS) {
        const p = path.join(blocksDir, t.block);
        if (!fs.existsSync(p)) throw new Error(`as3-hook-p6-pcode: 块文件缺失：${p}（绝不静默跳过：-replace 会 exit 0 却写成空体）`);
        const size = fs.statSync(p).size;
        if (t.blockBytes && size !== t.blockBytes) throw new Error(`as3-hook-p6-pcode: 块文件大小不符：${p} = ${size} B，P6 交付表为 ${t.blockBytes} B`);
    }

    const base = ctx.logicalSwf;
    const baseSha = sha256(base);
    const workDir = ctx.workDir || path.dirname(ctx.swfPath || ".");
    fs.mkdirSync(workDir, { recursive: true });
    log(`[as3-hook] p6-pcode 适配器：FFDec=${ctx.ffdecVersion || "?"} jar=${ctx.ffdecJar}`);
    log(`[as3-hook] base ${base.length} B sha256=${baseSha}`);
    log(`[as3-hook] blocks = ${blocksDir}`);

    fs.writeFileSync(path.join(workDir, "p6-base.swf"), base);

    // ── ④ 用自带解析器复算 bodyIndex（必须与 P6/FFDec 的口径一致，否则 -replace 会打错方法）──
    log(`[as3-hook] ④ bodyIndex 对齐（abc-index.mjs vs P6 交付表）`);
    const baseTags = findAbcTags(base);
    const baseTotalBodies = baseTags.reduce((n, t) => n + parseAbc(t.abc).bodies.length, 0);
    chk("DoABC tag 数 = " + P6_DOABC_TAGS, baseTags.length === P6_DOABC_TAGS, `实测 ${baseTags.length}`);
    chk("方法体总数 = " + P6_TOTAL_BODIES, baseTotalBodies === P6_TOTAL_BODIES, `实测 ${baseTotalBodies}`);
    const hits = locateClassAbc(base, FQCN);
    chk(`${FQCN} 只在一个 DoABC tag 里`, hits.length === 1, `命中 ${hits.length} 个 tag：${JSON.stringify(hits.map((h) => h.tag.name))}`);
    if (hits.length !== 1) throw new Error(`as3-hook-p6-pcode: ${FQCN} 的 DoABC tag 不唯一（${hits.length}）`);
    const baseAbc = hits[0].abc;
    log(`[as3-hook] 目标类所在 DoABC tag = ${JSON.stringify(hits[0].tag.name)}（abcIndex ${baseTags.indexOf(hits[0].tag)}）`);
    log(`[as3-hook] 该类 ABC：methods=${baseAbc.methods.length} bodies=${baseAbc.bodies.length} classes=${baseAbc.classes.length}`);
    const baseDigest = classListDigest(baseAbc);

    for (const t of TARGETS) {
        const r = findMethodBody(baseAbc, FQCN, t.method);
        chk(`bodyIndex(${t.method})`, r.ok && r.bodyIndex === t.bodyIndex, r.ok ? `实测 ${r.bodyIndex} / 期望 ${t.bodyIndex}` : r.reason);
        if (r.ok) chk(`原始 codeLength(${t.method})`, r.codeLength === t.baseCode, `实测 ${r.codeLength} / 期望 ${t.baseCode}`);
    }
    if (failures.length) throw new Error(`as3-hook-p6-pcode: bodyIndex 对齐失败，拒绝继续 —— ${failures.join("；")}`);

    // ── 跑 5 次链式 -replace（顺序不可换，in 用上一步的 out）──
    const jbase = ["-Xmx4g", "-Djava.awt.headless=true", "-jar", ctx.ffdecJar, "-air", "-onerror", "abort"];
    const runFfdec = (args, tag) => {
        const outLog = path.join(workDir, `ffdec-${tag}.out.log`);
        const errLog = path.join(workDir, `ffdec-${tag}.err.log`);
        const ofd = fs.openSync(outLog, "w");
        const efd = fs.openSync(errLog, "w");
        let r;
        try {
            r = spawnSync(javaExe, [...jbase, ...args], { stdio: ["ignore", ofd, efd] });
        } finally {
            fs.closeSync(ofd);
            fs.closeSync(efd);
        }
        const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
        // FFDec 对 AIR 包会刷一堆重复 scriptpack 警告，不是错误，别据此判失败。
        const noise = /Duplicate scriptpack path|checkUniqueAS3Packs|WARNING:/;
        const stdout = read(outLog).split("\n").filter((l) => !noise.test(l)).join("\n").trim();
        const stderr = read(errLog).split("\n").filter((l) => !noise.test(l)).join("\n").trim();
        return { status: r.status, signal: r.signal, stdout, stderr, outLog, errLog, error: r.error };
    };

    log(`[as3-hook] 5 次链式 -replace（顺序：${TARGETS.map((t) => t.method).join(" → ")}）`);
    let cur = base;
    const chain = [];
    for (let i = 0; i < TARGETS.length; i++) {
        const t = TARGETS[i];
        const inSwf = path.join(workDir, `p6-stage${i}.in.swf`);
        const outSwf = path.join(workDir, `p6-stage${i + 1}.out.swf`);
        fs.writeFileSync(inSwf, cur);
        const args = ["-replace", inSwf, outSwf, FQCN, path.join(blocksDir, t.block), String(t.bodyIndex)];
        const r = runFfdec(args, `stage${i + 1}-${t.method}`);
        const ok = r.status === 0 && fs.existsSync(outSwf);
        chk(`-replace ${i + 1}/5 ${t.method} (bodyIndex ${t.bodyIndex}) exit 0 且有产物`, ok,
            `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ""}${r.error ? ` error=${r.error.message}` : ""}`
            + (ok ? "" : ` stderr=${r.stderr.slice(0, 400) || "(空)"}`));
        if (!ok) {
            log(`[as3-hook] FFDec stdout(${t.method}) 尾部：\n${r.stdout.slice(-800)}`);
            throw new Error(`as3-hook-p6-pcode: -replace 失败于 ${t.method}（${r.status}）；日志 ${r.errLog}`);
        }
        cur = fs.readFileSync(outSwf);
        const stageBytesMatch = cur.length === P6_STAGE_BYTES[i];
        chain.push({ method: t.method, bodyIndex: t.bodyIndex, bytes: cur.length, p6Bytes: P6_STAGE_BYTES[i], stageBytesMatch, sha256: sha256(cur) });
        log(`[as3-hook]   stage${i + 1} ${t.method}: ${cur.length} B${stageBytesMatch ? "" : ` ⚠ P6 为 ${P6_STAGE_BYTES[i]} B`} sha256=${sha256(cur)}`);
    }
    const out = cur;
    const outSha = sha256(out);
    fs.writeFileSync(path.join(workDir, "p6-pcode-final.swf"), out);

    // ── ③ 结构不变（DoABC tag 数 + 方法体总数）──
    log(`[as3-hook] ③ 结构不变`);
    const outTags = findAbcTags(out);
    chk("DoABC tag 数不变", outTags.length === baseTags.length, `${baseTags.length} → ${outTags.length}`);
    const outTotalBodies = outTags.reduce((n, t) => n + parseAbc(t.abc).bodies.length, 0);
    chk("方法体总数不变", outTotalBodies === baseTotalBodies && outTotalBodies === P6_TOTAL_BODIES, `${baseTotalBodies} → ${outTotalBodies}`);
    const outHits = locateClassAbc(out, FQCN);
    chk("目标类仍只在一个 DoABC tag 里", outHits.length === 1, `命中 ${outHits.length}`);
    if (outHits.length !== 1) throw new Error("as3-hook-p6-pcode: 产物里目标类不再唯一，拒绝交付");
    const outAbc = outHits[0].abc;
    const outDigest = classListDigest(outAbc);
    chk("类清单指纹不变（不新增/不删除类）", outDigest.sha256 === baseDigest.sha256 && outDigest.count === baseDigest.count,
        `${baseDigest.count}/${baseDigest.sha256.slice(0, 16)} → ${outDigest.count}/${outDigest.sha256.slice(0, 16)}`);

    // ── ② 其它方法体 sha 全不变 ──
    log(`[as3-hook] ② 其它方法体逐字节不变`);
    if (outAbc.bodies.length !== baseAbc.bodies.length) {
        chk("方法体数量不变", false, `${baseAbc.bodies.length} → ${outAbc.bodies.length}`);
    } else {
        const expectChanged = new Set(TARGETS.map((t) => t.bodyIndex));
        const changed = [];
        for (let i = 0; i < baseAbc.bodies.length; i++) {
            const a = baseAbc.bodies[i];
            const b = outAbc.bodies[i];
            if (!a || !b) { changed.push({ index: i, reason: "缺失" }); continue; }
            if (a.codeSha !== b.codeSha || a.method !== b.method) changed.push({ index: i, codeSha: `${a.codeSha.slice(0, 12)}→${b.codeSha.slice(0, 12)}` });
        }
        const unexpected = changed.filter((c) => !expectChanged.has(c.index));
        const missing = [...expectChanged].filter((i) => !changed.some((c) => c.index === i));
        chk("其它方法体 sha 全不变（other_bodies_changed = 0）", unexpected.length === 0,
            `变化 ${changed.length} 个，其中非靶 ${unexpected.length} 个${unexpected.length ? `：${JSON.stringify(unexpected.slice(0, 8))}` : ""}`);
        chk("恰好这 5 个靶方法体变化（不多不少）", missing.length === 0 && changed.length === 5,
            `变化下标 ${JSON.stringify(changed.map((c) => c.index))}，期望 ${JSON.stringify([...expectChanged])}`);
        for (const t of TARGETS) {
            const r = findMethodBody(outAbc, FQCN, t.method);
            chk(`回读 codeLength(${t.method})`, r.ok && r.codeLength === t.outCode && r.bodyIndex === t.bodyIndex,
                r.ok ? `bodyIndex ${r.bodyIndex} codeLength ${r.codeLength} / 期望 ${t.bodyIndex} ${t.outCode}` : r.reason);
        }
    }

    // ── ① 回读 pcode 逐行一致 ──
    log(`[as3-hook] ① 回读 pcode 逐行一致（归一化）`);
    const dumpDir = path.join(workDir, "pcode-dump");
    fs.rmSync(dumpDir, { recursive: true, force: true });
    const dump = (swfPath, sub, tag) => {
        const dir = path.join(dumpDir, sub);
        fs.mkdirSync(dir, { recursive: true });
        const r = runFfdec(["-format", "script:pcode", "-selectclass", FQCN, "-export", "script", dir, swfPath], tag);
        const p = path.join(dir, "scripts", ...FQCN.split(".")) + ".pcode";
        if (r.status !== 0 && !fs.existsSync(p)) throw new Error(`as3-hook-p6-pcode: 导出 pcode 失败（${sub}）exit=${r.status}；日志 ${r.errLog}`);
        return fs.readFileSync(p, "utf8");
    };
    const extractBlock = (classPcode, method) => {
        const m = new RegExp(`trait method QName\\(PackageNamespace\\(""\\),"${method}"\\).*?end ; method`, "s").exec(classPcode);
        return m ? m[0] : null;
    };
    const baseTxt = dump(path.join(workDir, "p6-base.swf"), "base", "dump-base");
    const outTxt = dump(path.join(workDir, "p6-pcode-final.swf"), "out", "dump-out");
    chk("base pcode 导出含 5 个靶方法", TARGETS.every((t) => extractBlock(baseTxt, t.method) !== null),
        `缺失：${JSON.stringify(TARGETS.filter((t) => extractBlock(baseTxt, t.method) === null).map((t) => t.method))}`);
    for (const t of TARGETS) {
        const blockText = fs.readFileSync(path.join(blocksDir, t.block), "utf8");
        const outBlock = extractBlock(outTxt, t.method);
        if (outBlock === null) { chk(`回读 ${t.method}`, false, "产物 pcode 里找不到该方法"); continue; }
        const a = normalizePcode(blockText);
        const b = normalizePcode(outBlock);
        const d = firstDiff(a.lines, b.lines);
        const detail = `行数 ${a.lines.length} → ${b.lines.length}`
            + `（原始字符 ${blockText.length} → ${outBlock.length}，忽略 debug 行 ${b.droppedDebug}）`
            + (d === -1 ? "" : `，首个差异在第 ${d + 1} 行：\n      BLOCK: ${a.lines[d]}\n      OUT  : ${b.lines[d]}`);
        chk(`回读 ${t.method} 逐行一致`, d === -1, detail);
        // 空体（P6 踩过的坑：块文件不存在时 -replace 仍 exit 0 并写空体）单独点名，
        // 避免被「逐行一致」的信息量淹没。判据 = 外层 body 的 code … end ; code 之间一条指令都没有。
        const c0 = b.lines.indexOf("code");
        const c1 = c0 === -1 ? -1 : b.lines.indexOf("end ; code", c0 + 1);
        const bodyInstr = c0 === -1 || c1 === -1 ? -1 : c1 - c0 - 1;
        chk(`回读 ${t.method} 不是空体`, bodyInstr > 0, `code…end ; code 之间指令行 = ${bodyInstr}`);
    }

    // ── ⑤ 与 P6 参考产物 sha256 一致 ──
    log(`[as3-hook] ⑤ 与 P6 参考产物比对`);
    const refMatch = outSha === P6_REF_SHA256;
    chk("产物 sha256 == P6 参考产物 sha256", refMatch, refMatch ? outSha : `实测 ${outSha} / P6 ${P6_REF_SHA256}（FFDec ${ctx.ffdecVersion || "?"}；P6 用 26.3.0）`);
    notes.push(`p6-pcode 适配器：FFDec ${ctx.ffdecVersion || "?"}，产物 ${out.length} B sha256=${outSha}`);
    notes.push(`criterion-1 pcode-readback=逐行一致；criterion-2 other_bodies_changed=0；criterion-3 bodies ${baseTotalBodies}→${outTotalBodies}、DoABC ${baseTags.length}→${outTags.length}`);
    if (!refMatch) notes.push(`⚠ 与 P6 参考产物 sha256 不一致：${outSha} != ${P6_REF_SHA256}`);

    fs.writeFileSync(path.join(workDir, "p6-pcode-report.json"), JSON.stringify({
        generated_at: new Date().toISOString(),
        fqcn: FQCN,
        ffdec: { jar: ctx.ffdecJar, version: ctx.ffdecVersion || null },
        blocksDir,
        base: { bytes: base.length, sha256: baseSha, doabc_tags: baseTags.length, total_bodies: baseTotalBodies, class_list_digest: baseDigest },
        output: { path: path.join(workDir, "p6-pcode-final.swf"), bytes: out.length, sha256: outSha, doabc_tags: outTags.length, total_bodies: outTotalBodies, class_list_digest: outDigest },
        chain,
        reference: { p6_sha256: P6_REF_SHA256, match: refMatch },
        assertions: { failures },
        notes,
    }, null, 2), "utf8");

    if (failures.length) {
        throw new Error(`as3-hook-p6-pcode: ${failures.length} 条回读断言失败，拒绝交付 —— `
            + failures.map((f) => f.split(" —— ")[0]).join("；")
            + `（详见 ${path.join(workDir, "p6-pcode-report.json")}）`);
    }
    log(`[as3-hook] ALL PASS：${TARGETS.length} 个方法体已替换，产物 ${out.length} B sha256=${outSha}`);
    return { swf: out, notes };
}
