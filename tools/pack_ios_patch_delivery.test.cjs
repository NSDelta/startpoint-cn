#!/usr/bin/env node
// pack_ios_patch_delivery.cjs 的契约测试：
//   1. 打包出的 ZIP 顶层就是 <版本>/，其下直接是 patch-manifest.json 与 archive-*-diff/
//      （README「安装 CDN 增量补丁」要求解压进 CDN_DIR/patches/<版本>/ 后就是这个形状）；
//   2. ZIP 里的每个条目与磁盘逐字节一致，条目集合与 manifest 声明恰好一一对应；
//   3. manifest 少声明归档时拒绝打包，不产出半成品。

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const zlib = require("node:zlib")

const { main, writeZip } = require("./pack_ios_patch_delivery.cjs")
const { TEST_GROUPS } = require("./test-workflow/groups.cjs")

const EMPTY_ZIP_BYTES = Buffer.from("504b0506000000000000000000000000000000000000", "hex")

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex")
}

function writeStubArchive(targetPath, payload) {
    const name = Buffer.from(".empty", "utf8")
    const content = Buffer.from(payload, "utf8")
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0x6000, 10)
    localHeader.writeUInt16LE(0x5a21, 12)
    localHeader.writeUInt32LE(0x00000000, 14)
    localHeader.writeUInt32LE(content.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x031e, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(0x00000000, 16)
    centralHeader.writeUInt32LE(content.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(0, 42)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(46 + name.length, 12)
    end.writeUInt32LE(30 + name.length + content.length, 16)
    fs.writeFileSync(targetPath, Buffer.concat([localHeader, name, content, centralHeader, name, end]))
}

function readZipEntries(zipPath) {
    const buffer = fs.readFileSync(zipPath)
    let endOffset = -1
    for (let index = buffer.length - 22; index >= 0; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) { endOffset = index; break }
    }
    assert.notEqual(endOffset, -1, "ZIP 必须有 EOCD")
    const total = buffer.readUInt16LE(endOffset + 10)
    let offset = buffer.readUInt32LE(endOffset + 16)
    const entries = []
    for (let index = 0; index < total; index += 1) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50)
        const method = buffer.readUInt16LE(offset + 10)
        const compressedBytes = buffer.readUInt32LE(offset + 20)
        const uncompressedBytes = buffer.readUInt32LE(offset + 24)
        const nameLength = buffer.readUInt16LE(offset + 28)
        const extraLength = buffer.readUInt16LE(offset + 30)
        const commentLength = buffer.readUInt16LE(offset + 32)
        const localOffset = buffer.readUInt32LE(offset + 42)
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
        const payload = buffer.subarray(dataStart, dataStart + compressedBytes)
        const content = method === 0 ? payload : zlib.inflateRawSync(payload)
        assert.equal(content.length, uncompressedBytes, `${name} 解压长度必须与中央目录一致`)
        entries.push({ name, bytes: content.length, sha256: sha256(content) })
        offset += 46 + nameLength + extraLength + commentLength
    }
    return entries
}

function buildPatchTree(patchesRoot, version) {
    const fromVersion = `${version.split(".").slice(0, 2).join(".")}.${Number(version.split(".")[2]) - 1}`
    const versionRoot = path.join(patchesRoot, version)
    const layers = [
        { layer: "common", directory: "archive-common-diff", payload: "common-diff" },
        { layer: "medium", directory: "archive-medium-diff", payload: null },
        { layer: "android", directory: "archive-android-diff", payload: null },
        { layer: "ios", directory: "archive-ios-diff", payload: "0" },
    ]
    const archives = []
    layers.forEach((definition, index) => {
        const directory = path.join(versionRoot, definition.directory)
        fs.mkdirSync(directory, { recursive: true })
        const archivePath = path.join(directory, `pinball-${fromVersion}-${version}-1-${String(index).repeat(8)}.zip`)
        if (definition.payload === null) fs.writeFileSync(archivePath, EMPTY_ZIP_BYTES)
        else writeStubArchive(archivePath, definition.payload)
        const bytes = fs.statSync(archivePath).size
        archives.push({
            relativePath: `${definition.directory}/${path.basename(archivePath)}`,
            layer: definition.layer,
            order: 1,
            bytes,
            sha256: sha256(fs.readFileSync(archivePath)),
        })
    })
    const manifest = {
        schema: 1,
        targetVersion: version,
        baseVersion: fromVersion,
        compatibleClient: "CN 1.8.1",
        archives,
    }
    fs.writeFileSync(path.join(versionRoot, "patch-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return { manifest, archives }
}

function withTempRoot(run) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-pack-ios-"))
    try {
        return run(tempRoot)
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true })
    }
}

test("packs patch directories into a README-shaped delivery zip", () => {
    withTempRoot(tempRoot => {
        const patchesRoot = path.join(tempRoot, "patches")
        const outDir = path.join(tempRoot, "out")
        const fixture = buildPatchTree(patchesRoot, "1.4.55")

        assert.equal(main(["--patches", patchesRoot, "--out", outDir]), 0)

        const zipPath = path.join(outDir, "1.4.55-dev.zip")
        const entries = readZipEntries(zipPath)
        const names = entries.map(entry => entry.name).sort()
        const expected = [
            "1.4.55/patch-manifest.json",
            ...fixture.archives.map(archive => `1.4.55/${archive.relativePath}`),
        ].sort()
        assert.deepEqual(names, expected)
        for (const entry of entries) {
            assert.equal(entry.name.startsWith("1.4.55/"), true, `顶层必须是版本目录: ${entry.name}`)
            const physicalPath = path.join(patchesRoot, ...entry.name.split("/"))
            const onDisk = fs.readFileSync(physicalPath)
            assert.equal(entry.bytes, onDisk.length, `${entry.name} 字节数必须与磁盘一致`)
            assert.equal(entry.sha256, sha256(onDisk), `${entry.name} 内容必须与磁盘逐字节一致`)
        }
        const manifestEntry = entries.find(entry => entry.name === "1.4.55/patch-manifest.json")
        assert.notEqual(manifestEntry, undefined)
        const manifestOnDisk = fs.readFileSync(path.join(patchesRoot, "1.4.55", "patch-manifest.json"))
        assert.equal(manifestEntry.sha256, sha256(manifestOnDisk))
    })
})

test("rejects a package whose manifest does not declare every archive", () => {
    withTempRoot(tempRoot => {
        const patchesRoot = path.join(tempRoot, "patches")
        const outDir = path.join(tempRoot, "out")
        const fixture = buildPatchTree(patchesRoot, "1.4.56")
        const manifestPath = path.join(patchesRoot, "1.4.56", "patch-manifest.json")
        const trimmed = { ...fixture.manifest, archives: fixture.manifest.archives.slice(0, 1) }
        fs.writeFileSync(manifestPath, `${JSON.stringify(trimmed, null, 2)}\n`)

        assert.throws(
            () => main(["--patches", patchesRoot, "--out", outDir]),
            /归档未在 manifest 中声明/,
        )
        assert.equal(fs.existsSync(path.join(outDir, "1.4.56-dev.zip")), false)
    })
})

test("rejects a package whose manifest points at a missing archive", () => {
    withTempRoot(tempRoot => {
        const patchesRoot = path.join(tempRoot, "patches")
        const outDir = path.join(tempRoot, "out")
        const fixture = buildPatchTree(patchesRoot, "1.4.57")
        fs.rmSync(path.join(patchesRoot, "1.4.57", fixture.archives[0].relativePath))

        assert.throws(
            () => main(["--patches", patchesRoot, "--out", outDir]),
            /manifest 声明的归档不存在/,
        )
    })
})

test("writes deflated entries that inflate back to the source bytes", () => {
    withTempRoot(tempRoot => {
        const zipPath = path.join(tempRoot, "sample.zip")
        const sourcePath = path.join(tempRoot, "payload.bin")
        const payload = Buffer.alloc(4096, 7)
        fs.writeFileSync(sourcePath, payload)
        writeZip(zipPath, [{ name: "1.4.0/payload.bin", physicalPath: sourcePath }])
        const entries = readZipEntries(zipPath)
        assert.deepEqual(entries, [{ name: "1.4.0/payload.bin", bytes: payload.length, sha256: sha256(payload) }])
        assert.equal(fs.statSync(zipPath).size < payload.length, true, "重复内容必须被压缩")
    })
})

test("registers the delivery packer in the focused CDN group", () => {
    assert.ok(TEST_GROUPS["quick:cdn"].tests.includes("tools/pack_ios_patch_delivery.test.cjs"))
})
