#!/usr/bin/env node
// Runtime Pack v1 manifest 生成器。
//
// 校验规则见 tools/runtime-pack/verify.cjs（同一根目录），本文件只负责"从磁盘产出
// 一份必然能通过校验的 runtime-pack-manifest.json"：
//   - files：递归收集 node/ 与 node_modules/ 下的普通文件，路径为 POSIX 相对路径，
//     按 UTF-8 字节序排序（verify.cjs 用 Buffer.compare 同序比较）；
//   - runtimeId：删掉 runtimeId 后的 canonical JSON（键递归排序 + 结尾换行）的 SHA-256；
//   - manifest 自身写成同一份 canonical JSON 字节，保证逐字节相等。
//
// 用法：
//   node tools/runtime-pack/build.cjs --root <runtime-pack 目录> \
//       --node-version 20.12.2 --node-abi 115 --platform linux --arch x64 \
//       --dependency-lock sha256:<package-lock.json 原始字节摘要> [--check]
//
//   Windows 平台用 --entry node/bin/node.exe 指定可执行文件名（缺省 node/bin/node）。
//
// --check：只校验现有 manifest 与磁盘一致，不写文件。

"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { canonicalJsonBuffer, sha256Hex } = require("../server-bundle/canonical-json.cjs")
const { verifyRuntimePack } = require("./verify.cjs")

const MANIFEST_NAME = "runtime-pack-manifest.json"
const DEFAULT_ENTRY = "node/bin/node"
const SCHEMA_VERSION = 1
const RUNTIME_API = 1
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

// 允许的 entry：POSIX 平台 node，Windows 平台 node.exe。其它名字一律拒绝，
// 免得 entry 变成任意可执行文件。
const ALLOWED_ENTRIES = ["node/bin/node", "node/bin/node.exe"]

function fail(message) {
    throw new Error(message)
}

function compareRelativePaths(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function isOwnedRuntimePath(relativePath) {
    return relativePath === "node"
        || relativePath.startsWith("node/")
        || relativePath === "node_modules"
        || relativePath.startsWith("node_modules/")
}

function collectFiles(root) {
    const files = []

    function visit(absoluteDirectory, relativeDirectory) {
        const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        for (const entry of entries) {
            const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`
            const absolutePath = path.join(absoluteDirectory, entry.name)
            const status = fs.lstatSync(absolutePath)
            if (status.isSymbolicLink()) {
                fail(`Runtime Pack entry "${relativePath}" must not be a symbolic link`)
            }
            if (!isOwnedRuntimePath(relativePath) && relativePath !== MANIFEST_NAME) {
                fail(`Runtime Pack has an extra path "${relativePath}"`)
            }
            if (status.isDirectory()) {
                visit(absolutePath, relativePath)
                continue
            }
            if (!status.isFile()) {
                fail(`Runtime Pack entry "${relativePath}" must be a regular file or directory`)
            }
            if (relativePath === MANIFEST_NAME) continue
            const bytes = fs.readFileSync(absolutePath)
            files.push({ bytes: bytes.length, path: relativePath, sha256: sha256Hex(bytes) })
        }
    }

    visit(root, "")
    files.sort((left, right) => compareRelativePaths(left.path, right.path))
    return files
}

function buildManifest(options) {
    const root = path.resolve(options.root)
    const status = fs.lstatSync(root)
    if (!status.isDirectory()) fail("Runtime Pack root must be a directory")

    const entry = options.entry ?? DEFAULT_ENTRY
    if (!ALLOWED_ENTRIES.includes(entry)) {
        fail(`entry must be ${ALLOWED_ENTRIES.join(" or ")}`)
    }
    const executables = [entry]
    if (!fs.existsSync(path.join(root, ...entry.split("/")))) {
        fail(`Runtime Pack is missing the entry file "${entry}"`)
    }

    const files = collectFiles(root)
    if (!files.some(file => file.path.startsWith("node_modules/"))) {
        fail("Runtime Pack must contain production dependencies under node_modules")
    }

    const manifest = {
        dependencyLock: options.dependencyLock,
        entry,
        executables,
        files,
        node: {
            abi: options.nodeAbi,
            arch: options.nodeArch,
            platform: options.nodePlatform,
            version: options.nodeVersion,
        },
        runtimeApi: RUNTIME_API,
        schemaVersion: SCHEMA_VERSION,
    }
    manifest.runtimeId = `sha256:${sha256Hex(canonicalJsonBuffer(manifest))}`
    return manifest
}

function parseArguments(argv) {
    const options = { check: false }
    const flags = new Map([
        ["--root", "root"],
        ["--entry", "entry"],
        ["--node-version", "nodeVersion"],
        ["--node-abi", "nodeAbi"],
        ["--platform", "nodePlatform"],
        ["--arch", "nodeArch"],
        ["--dependency-lock", "dependencyLock"],
    ])
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--check") {
            options.check = true
            continue
        }
        const key = flags.get(argument)
        if (key === undefined) fail(`Unknown argument: ${argument}`)
        if (options[key] !== undefined || argv[index + 1] === undefined) {
            fail(`${argument} requires one value`)
        }
        options[key] = argv[++index]
    }
    if (options.root === undefined) fail("--root is required")
    for (const required of ["nodeVersion", "nodeAbi", "nodePlatform", "nodeArch", "dependencyLock"]) {
        if (options[required] === undefined) fail(`--${required} is required`)
    }
    if (!/^\d+\.\d+\.\d+$/.test(options.nodeVersion)) fail("--node-version must be a complete semantic version")
    if (!/^\d+$/.test(options.nodeAbi)) fail("--node-abi must be a decimal string")
    if (!/^[a-z][a-z0-9-]*$/.test(options.nodePlatform)) fail("--platform is invalid")
    if (!/^[a-z0-9_-]+$/.test(options.nodeArch)) fail("--arch is invalid")
    if (!DIGEST_PATTERN.test(options.dependencyLock)) fail("--dependency-lock must be a lowercase SHA-256 digest")
    return options
}

function dependencyLockDigest(lockfilePath) {
    const bytes = fs.readFileSync(lockfilePath)
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
}

function main(argv) {
    const options = parseArguments(argv)
    const root = path.resolve(options.root)
    const manifestPath = path.join(root, MANIFEST_NAME)
    const manifest = buildManifest(options)
    const bytes = canonicalJsonBuffer(manifest)

    if (options.check) {
        if (!fs.existsSync(manifestPath)) fail(`Runtime Pack manifest is missing at ${manifestPath}`)
        const existing = fs.readFileSync(manifestPath)
        if (!existing.equals(bytes)) fail("Runtime Pack manifest does not match the disk contents")
        verifyRuntimePack({
            runtimeRoot: root,
            expectedPlatform: options.nodePlatform,
            expectedArch: options.nodeArch,
            expectedNodeAbi: options.nodeAbi,
            expectedRuntimeApi: RUNTIME_API,
            expectedDependencyLock: options.dependencyLock,
        })
        process.stdout.write(`Runtime Pack manifest matches the disk contents (${manifest.files.length} files)\n`)
        return
    }

    fs.writeFileSync(manifestPath, bytes)
    verifyRuntimePack({
        runtimeRoot: root,
        expectedPlatform: options.nodePlatform,
        expectedArch: options.nodeArch,
        expectedNodeAbi: options.nodeAbi,
        expectedRuntimeApi: RUNTIME_API,
        expectedDependencyLock: options.dependencyLock,
    })
    process.stdout.write(`Wrote ${manifestPath}\n${manifest.runtimeId} with ${manifest.files.length} files\n`)
}

if (require.main === module) {
    try {
        main(process.argv.slice(2))
    } catch (error) {
        process.stderr.write(`Runtime Pack build failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
        process.exitCode = 1
    }
}

module.exports = { buildManifest, collectFiles, dependencyLockDigest }
