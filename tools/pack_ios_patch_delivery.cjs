#!/usr/bin/env node
// 把已装好的补丁目录（CDN_DIR/patches/<版本>/）重新打包成分发 ZIP。
//
// 口径按 README「安装 CDN 增量补丁」一段：使用方保持现有 CDN_DIR/cn 不变，
// 手动创建与补丁目标版本一致的目录（例如 CDN_DIR/patches/1.4.55/），再把本 ZIP
// 的内容解压进去；解压后 patch-manifest.json 与 archive-*-diff/ 必须直接位于
// 该版本目录内。所以 ZIP 的顶层就是 <版本>/，不夹带别的东西。
//
// 用法：
//   node tools/pack_ios_patch_delivery.cjs --patches <patchesRoot> --out <outDir> [--versions 1.4.55,1.4.56]
//
// 自带极简 ZIP 写入（deflate + CRC32，不写目录条目），不依赖外部打包器。

const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function writeZip(targetPath, entries) {
  const local = []
  const central = []
  let offset = 0
  const { time, date } = dosDateTime(new Date())
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8")
    const raw = fs.readFileSync(entry.physicalPath)
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const payload = deflated.length < raw.length ? deflated : raw
    const method = deflated.length < raw.length ? 8 : 0
    const crc = crc32(raw)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(date, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)
    local.push(localHeader, nameBytes, payload)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x031e, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + payload.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  fs.writeFileSync(targetPath, Buffer.concat([...local, centralBuffer, end]))
}

function sha256(buffer) {
  return require("node:crypto").createHash("sha256").update(buffer).digest("hex")
}

function collectVersionFiles(versionRoot) {
  const files = []
  const walk = directoryPath => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const physicalPath = path.join(directoryPath, entry.name)
      if (entry.isDirectory()) walk(physicalPath)
      else if (entry.isFile()) files.push(physicalPath)
    }
  }
  walk(versionRoot)
  return files
}

function parseArguments(argv) {
  const options = { patches: null, out: null, versions: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--patches") { options.patches = path.resolve(value); index += 1 }
    else if (flag === "--out") { options.out = path.resolve(value); index += 1 }
    else if (flag === "--versions") { options.versions = value.split(",").map(item => item.trim()).filter(Boolean); index += 1 }
    else if (flag === "--help" || flag === "-h") { options.help = true }
    else throw new Error(`unknown argument: ${flag}`)
  }
  return options
}

const HELP = [
  "用法: node tools/pack_ios_patch_delivery.cjs --patches <patchesRoot> --out <outDir> [--versions 1.4.55,1.4.56]",
  "",
  "把 <patchesRoot>/<版本>/ 整棵子树打包成 <outDir>/<版本>-dev.zip，顶层即 <版本>/。",
].join("\n")

function main(argv) {
  const options = parseArguments(argv)
  if (options.help) { process.stdout.write(`${HELP}\n`); return 0 }
  if (!options.patches || !options.out) throw new Error("--patches 与 --out 都是必需的")
  if (!fs.existsSync(options.patches)) throw new Error(`patches root 不存在: ${options.patches}`)
  const versions = options.versions.length > 0
    ? options.versions
    : fs.readdirSync(options.patches, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => /^\d+\.\d+\.\d+$/.test(name))
      .sort()
  if (versions.length === 0) throw new Error(`在 ${options.patches} 下找不到形如 <major>.<minor>.<patch> 的版本目录`)
  fs.mkdirSync(options.out, { recursive: true })
  const report = []
  for (const version of versions) {
    const versionRoot = path.join(options.patches, version)
    if (!fs.existsSync(versionRoot)) throw new Error(`版本目录不存在: ${versionRoot}`)
    const manifestPath = path.join(versionRoot, "patch-manifest.json")
    if (!fs.existsSync(manifestPath)) throw new Error(`缺少 patch-manifest.json: ${versionRoot}`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    const files = collectVersionFiles(versionRoot)
    const archiveFiles = files.filter(filePath => path.basename(filePath) !== "patch-manifest.json")
    const manifestPaths = new Set(manifest.archives.map(archive => archive.relativePath))
    for (const filePath of archiveFiles) {
      const relativePath = path.relative(versionRoot, filePath).split(path.sep).join("/")
      if (!manifestPaths.has(relativePath)) throw new Error(`归档未在 manifest 中声明: ${version}/${relativePath}`)
    }
    for (const relativePath of manifestPaths) {
      if (!fs.existsSync(path.join(versionRoot, ...relativePath.split("/")))) {
        throw new Error(`manifest 声明的归档不存在: ${version}/${relativePath}`)
      }
    }
    const targetPath = path.join(options.out, `${version}-dev.zip`)
    writeZip(targetPath, files.map(filePath => ({
      name: `${version}/${path.relative(versionRoot, filePath).split(path.sep).join("/")}`,
      physicalPath: filePath,
    })))
    const buffer = fs.readFileSync(targetPath)
    report.push({
      version,
      targetVersion: version,
      baseVersion: manifest.baseVersion ?? null,
      manifestBytes: fs.statSync(manifestPath).size,
      fileCount: files.length,
      archiveCount: archiveFiles.length,
      layers: manifest.archives.map(archive => archive.layer).sort(),
      bytes: buffer.length,
      sha256: sha256(buffer),
      output: targetPath,
    })
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", count: report.length, packages: report }, null, 2)}\n`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`失败：${error.stack ?? error}\n`)
    process.exitCode = 1
  }
}

module.exports = { main, writeZip, crc32 }
