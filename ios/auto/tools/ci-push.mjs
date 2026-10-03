/**
 * ci-push.mjs —— 把「iOS 自动点击」这一坨改动推成一个**独立的轻量提交**，用来触发
 * .github/workflows/ios-autoclick.yml，而不动本仓库的 dev 分支。
 *
 * 为什么需要它：
 *   本机的 dev 相对远端 ahead 151 / behind 29，直接 push 会把 151 个别人的提交一起
 *   推上去，其中包含一堆与本交付无关的改动（SpLogin、私服 auth、文档）。而
 *   ios/auto/ 是**自包含**的（tools/ 与工作流里零处引用仓库外的路径），所以
 *   只要把它整棵树 + 一个工作流文件挂到目标分支上，CI 就能完整跑完。
 *
 * 做法（本地 git 操作，不需要 GitHub API）：
 *   0. 用 `git stash create` 把**未提交的改动**也做进一个临时提交 —— 否则「改了但还没
 *      commit」时，脚本会拿 HEAD 的树去推，推上去的是旧内容，而输出里只会说
 *      「改动的文件数: 0」。第一次跑就是这么静默失败的。stash create 不碰工作树
 *      也不动 stash 栈（它只是造一个 commit 对象并打印 SHA）。
 *   1. 记下那棵树的 SHA（= 本机 ios/auto 等文件的当前内容）；
 *   2. 用 `git commit-tree <tree> -p <远端分支 SHA>` 造一个**只差这些文件**的提交
 *      （-p 指向远端分支 ⇒ push 时只传增量，几 MB 而不是 38 MB）；
 *   3. `git branch -f <branch> <sha>`；
 *   4. 用 GIT_ASKPASS 把令牌递给 git，`git push -f origin <branch>`。
 *
 * ⚠️ 一次 git 操作上的教训：**Git Data API 不能引用服务端还不存在的 blob**
 *   （`POST /git/trees` 会报 `422 tree.sha ... is not a valid blob`）。所以「本地造树、
 *   服务端补全」这条 API 路线是走不通的，必须走 git push 或逐个 POST blob。
 *   本脚本走 git push。
 *
 * 令牌来源（按顺序）：
 *   1. --token=xxx
 *   2. 环境变量 AM_GH_TOKEN / GH_TOKEN / GITHUB_TOKEN
 *   3. Windows 凭据管理器里的 `git:https://github.com`（dev 机上就是这个）
 * 令牌不会被写进任何文件；GIT_ASKPASS 临时脚本在退出前删除。
 *
 * 用法：
 *   node ios/auto/tools/ci-push.mjs --dry-run          # 只算，不推
 *   node ios/auto/tools/ci-push.mjs                    # 推到 ci-ios-autoclick
 *   node ios/auto/tools/ci-push.mjs --repo=NSDelta/startpoint-cn --branch=ci-ios-autoclick \
 *        --base=dev --paths=ios/auto,.github/workflows/ios-autoclick.yml
 */

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(2);
}


const opt = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};

const REPO   = opt("repo", "NSDelta/startpoint-cn");
const BRANCH = opt("branch", "ci-ios-autoclick");
const BASE   = opt("base", "dev");
const PATHS  = String(opt("paths", "ios/auto,.github/workflows/ios-autoclick.yml"))
  .split(",").map((s) => s.trim()).filter(Boolean);
const DRY    = opt("dry-run", false) === true;
const MSG    = String(opt("message", "ci: iOS 自动点击（改动快照，用于触发 ios-autoclick）"));

function out(label, r) {
  if (r.error) throw new Error(`${label}: 无法执行 git（${r.error.message}）`);
  if (r.status !== 0) {
    throw new Error(`${label}: git 退出码 ${r.status}\n${r.stderr || r.stdout || ""}`);
  }
  return (r.stdout || "").trim();
}

function git(args, opts = {}) {
  return spawnSync("git", args, { encoding: "utf8", ...opts });
}

/** 从 Windows 凭据管理器读 `git:https://github.com`（dev 机上令牌在这里）。 */
function tokenFromCredMan() {
  if (process.platform !== "win32") return null;
  const ps = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class AMCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string t) { IntPtr p; if (!CredRead(t,1,0,out p)) return null;
    try { CREDENTIAL c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob,(int)(c.CredentialBlobSize/2)); } finally { CredFree(p); } } }
'@
[AMCredMan]::Read('git:https://github.com')
`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const t = (r.stdout || "").trim();
  return t.length >= 20 ? t : null;
}

const token = String(opt("token", "")) ||
  process.env.AM_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
  tokenFromCredMan();
if (!token) {
  fail("没有令牌。用 --token=、或设 AM_GH_TOKEN，或确认凭据管理器里有 git:https://github.com");
}

// ── 1. 前置检查 ────────────────────────────────────────────────────────────
const pwd = out("rev-parse --show-toplevel", git(["rev-parse", "--show-toplevel"]));
for (const p of PATHS) {
  if (!existsSync(join(pwd, p))) fail(`路径不存在：${p}（在 ${pwd} 下）`);
}
// ── 1b. 新文件必须先进索引，否则它**根本不会出现在推送里** ──────────────────
//
// 第 13 次 CI 的真实教训：`core/am_fft_accel.c` 是新写的、还没 `git add` 过，
// 于是 `git stash create` 的快照里没有它 —— 推送报成功、回读校验也通过
// （回读只比对**远端有**的那些文件，新文件不在比对范围内），CI 却在第一步
// 就死在 `clang: error: no such file or directory: 'core/am_fft_accel.c'`。
// 「新文件被静默丢掉」是最难查的一类失败，所以这里显式把它捞进索引。
//
// 做法是往临时索引里 `git add -f`（**不碰真实索引，也就不会污染 git status**），
// 再用 `GIT_INDEX_FILE=<临时索引> git write-tree` 把它变成一棵树。
// **底座那棵树必须是「已含未提交改动」的那一棵**（stash 的树）—— 从 HEAD 起的话
// 会把已改但未提交的源码又退回旧版本，那是比丢掉新文件更难查的反向失败。
// 过滤规则与「只推 PATHS」一致：先列出所有候选，再按路径前缀筛。
function treeWithUntracked(baseTree, files) {
  const idx = join(tmpdir(), `am-ci-index-${process.pid}`);
  try { unlinkSync(idx); } catch { /* 不存在最好 */ }
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const rt = git(["read-tree", baseTree], { env });
  if (rt.status !== 0) { try { unlinkSync(idx); } catch { /* 同上 */ } return ""; }
  // -f 是必须的：被 .gitignore 挡住的文件（本仓库里现在没有，但将来可能有）也要能进。
  git(["add", "-f", "--", ...files], { env });
  const t = (git(["write-tree"], { env }).stdout || "").trim();
  try { unlinkSync(idx); } catch { /* 同上 */ }
  return t;
}

const untracked = (() => {
  const rs = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...PATHS]);
  const ig = git(["ls-files", "-z", "--others", "-i", "--exclude-standard", "--", ...PATHS]);
  const split = (s) => (s || "").split("\0").filter(Boolean);
  // 只统计源文件：`tests/build/` 是 .gitignore 的产物目录，几十个 .exe/.obj 列进来
  // 只会把真正的「新源码忘了 add」淹掉。
  const drop = (f) => /(^|\/)tests\/build\//.test(f) || /\.(exe|obj|pdb|ilk|exp|lib)$/i.test(f);
  return [...new Set([...split(rs.stdout), ...split(ig.stdout)])].filter((f) => !drop(f));
})();
if (untracked.length) {
  console.log(`新文件（还没 git add，已自动收进本次快照）：${untracked.length} 个`);
  for (const f of untracked.slice(0, 12)) console.log(`  + ${f}`);
  if (untracked.length > 12) console.log(`  … 还有 ${untracked.length - 12} 个`);
}

const localTree = (() => {
  // git stash create 在「没有任何未提交改动」时打印空行，那就退回 HEAD 的树。
  const r = git(["stash", "create"]);
  const c = (r.stdout || "").trim();
  const t = c
    ? out("stash^{tree}", git(["rev-parse", `${c}^{tree}`]))
    : out("HEAD tree", git(["rev-parse", "HEAD^{tree}"]));
  if (c) console.log(`（工作树有未提交的改动，已用 stash create 的快照：${c.slice(0, 12)}）`);
  if (!untracked.length) return t;
  // 有未跟踪文件时，以「含 HEAD + 未提交改动」的那棵树为底，把新文件也写进去。
  const withNew = treeWithUntracked(t, untracked);
  return withNew || t;
})();

console.log(`仓库根      : ${pwd}`);
console.log(`目标          : ${REPO}  分支 ${BRANCH}（父 = ${BASE}）`);
console.log(`路径          : ${PATHS.join("  ")}`);
console.log(`本地内容 tree: ${localTree}`);

// ── 2. 远端分支的当前 SHA（作为父提交）────────────────────────────────────
const url = `https://github.com/${REPO}.git`;
const lsRemote = out("ls-remote", git(["ls-remote", url, `refs/heads/${BASE}`, `refs/heads/${BRANCH}`]));
const refs = new Map();
for (const line of lsRemote.split("\n").filter(Boolean)) {
  const [sha, ref] = line.split(/\s+/);
  refs.set(ref, sha);
}
const baseSha = refs.get(`refs/heads/${BASE}`);
if (!baseSha) fail(`远端没有 refs/heads/${BASE}`);
const branchSha = refs.get(`refs/heads/${BRANCH}`);
console.log(`远端 ${BASE}     : ${baseSha}`);
console.log(`远端 ${BRANCH}${branchSha ? ":" : "（不存在）"} ${branchSha || ""}`);

// ── 3. 造提交：只把 PATHS 的内容换成当前工作树的样子 ─────────────────────
//     commit-tree 用本地树 + 远端父 ⇒ push 只会传「两边树的差」，即 PATHS 的新内容。
const parent = branchSha || baseSha;
const commit = out("commit-tree", git(
  ["commit-tree", localTree, "-p", parent],
  { input: `${MSG}\n\n（ci-push.mjs 生成的改动快照；父提交 = ${parent}）\n` }
));
console.log(`新提交        : ${commit}`);

const changed = out("diff --name-only", git(["diff", "--name-only", parent, commit, "--", ...PATHS]));
const n = changed ? changed.split("\n").length : 0;
console.log(`本提交改动的文件数: ${n}`);
if (n === 0) {
  console.log("⚠️  与父提交相比这些路径没有任何变化 —— CI 会跑到和上次一样的内容。");
}

if (DRY) {
  console.log("\n--dry-run：到此为止，没有创建分支、没有推送。");
  process.exit(0);
}

// ── 4. 建分支 + 推 ────────────────────────────────────────────────────────
out("branch -f", git(["branch", "-f", BRANCH, commit]));

const askpass = join(tmpdir(), `am-ci-askpass-${process.pid}.cmd`);
writeFileSync(askpass, `@echo ${token}\r\n`, "ascii");
const env = {
  ...process.env,
  GIT_ASKPASS: askpass,
  GIT_TERMINAL_PROMPT: "0",
  // 推送 URL 里带用户名，密码由 askpass 提供 —— 不走 URL 里的明文，免得它落进
  // .git/config 或 shell 历史。
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.https://x-access-token@github.com/.insteadOf`,
  GIT_CONFIG_VALUE_0: "https://github.com/",
};
try {
  const r = git(["push", "-f", url, `${BRANCH}:${BRANCH}`], { env, stdio: "inherit" });
  if (r.status !== 0) fail(`推送失败，退出码 ${r.status}`);
} finally {
  try { unlinkSync(askpass); } catch { /* 删不掉就算了，它只含一个令牌且路径随机 */ }
}

console.log(`\n✅ 已推送 ${BRANCH} -> ${REPO}`);

// ── 5. 回读校验：远端那一份**真的**是本地工作树里的这一份吗？ ────────────────
//
// 为什么必须有这一步（第 7 次 CI 的真实教训）：
// 有一次 `git hash-object <工作树文件>` 与远端 blob 的内容**不同**，而推送本身
// 报的是成功 —— 于是 CI 编译的是「改动做到一半」的源码，错误信息指向的行号
// 与本地对不上（`use of undeclared identifier 'gLastGLReadMs'`，而本地文件里
// 那一行明明就在）。**没有这一步，我花在"为什么本地有、CI 说没有"上的时间
// 全都是白花的。**
//
// 做法：把推送目标的 ref 拉下来，逐文件比 `git hash-object` 与远端 blob 的 SHA。
// 只比源文件（PATHS 下的），不比生成物。任何一处不一致就硬失败 —— 宁可现在就
// 失败，也不要让 CI 去编译一份我没打算推的东西。
{
  // 注意 refspec 的目标写成**本地分支名**（而不是 refs/remotes/...）：
  // git 默认拒绝用 fetch 去更新本地分支，而这里正是想要的行为 —— 顺手把
  // BRANCH 同步到刚推上去的那一个，不留临时 ref。
  const f = git(["fetch", "-q", url, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`], { env });
  if (f.status !== 0) {
    console.log("⚠️  回读校验跳过：拉取远端 ref 失败（推送本身已成功）。");
  } else {
    const files = (out("verify ls-tree", git(["ls-tree", "-r", "--name-only", BRANCH])) || "")
      .split("\n")
      .filter((p) => p && PATHS.some((pre) => p === pre || p.startsWith(pre.endsWith("/") ? pre : pre + "/")));
    let bad = 0;
    for (const p of files) {
      const local = (out(`hash ${p}`, git(["hash-object", p])) || "").trim();
      const remote = (out(`remote ${p}`, git(["rev-parse", `${BRANCH}:${p}`])) || "").trim();
      if (!local || !remote || local !== remote) {
        bad++;
        if (bad <= 8) console.log(`   ✗ ${p}  本地 ${local.slice(0, 8)} ≠ 远端 ${remote.slice(0, 8)}`);
      }
    }
    if (bad === 0) {
      console.log(`🔎 回读校验通过：${files.length} 个文件与本地工作树逐字节一致`);
    } else {
      console.log(`🔎 回读校验失败：${bad} / ${files.length} 个文件与本地不一致 —— CI 编译的不是你现在的代码！`);
      fail("推送内容与本地工作树不一致");
    }

    // ★ 反向检查：本地有、远端**没有**的源文件。
    // 这一条是第 13 次 CI 的产物：新写的 `core/am_fft_accel.c` 没进快照，而上面
    // 那个循环只遍历「远端有」的文件，于是它一个都没提示、回读还报「通过」，
    // CI 却死在 `no such file or directory`。**只校验"远端那份对不对"是不够的，
    // 还要校验"该在的都在不在"。**
    const worktree = (out("local ls-files", git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...PATHS])) || "")
      .split("\n")
      .filter(Boolean);
    const remoteSet = new Set(files);
    const missing = worktree.filter((p) => !remoteSet.has(p));
    if (missing.length) {
      console.log(`🔎 有 ${missing.length} 个本地源文件**没有**出现在推送里：`);
      for (const p of missing.slice(0, 12)) console.log(`   ✗ ${p}`);
      fail("推送内容缺文件 —— CI 会编译一份不完整的树");
    }
    console.log(`🔎 双向校验通过：${files.length} 个文件一致，且本地源文件一个不缺`);
  }
}

console.log(`   看运行结果：`);
console.log(`     GET https://api.github.com/repos/${REPO}/actions/runs?branch=${BRANCH}`);
console.log(`   拿真实构建日志（job 日志 API 需要更高权限，所以走 ci-diag 分支）：`);
console.log(`     git fetch ${url} "refs/heads/ci-diag/<run_id>/<leg>:refs/remotes/nsdiag/<leg>"`);
console.log(`     git cat-file -p refs/remotes/nsdiag/<leg>:ci-diag/<run_id>/<leg>/build.log`);
