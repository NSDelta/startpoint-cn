// ABC（AVM2 字节码容器）最小索引器 —— P7b 的 AS3 通路需要两件用 FFDec 拿不到的东西：
//   1) `abc.bodies` 的**全局**下标：FFDec 的 `-replace <in> <out> <FQCN> <块文件> <bodyIndex>` 走的是
//      `abc.bodies.get(bodyIndex)`（CommandLineArgumentParser.replaceAS3PCode），越界会抛
//      `IndexOutOfBoundsException: Index N out of bounds for length M`，所以下标语义是全局的、不是类内序。
//   2) 独立回读校验：方法体总数/类数/类清单指纹、逐方法体 code sha256、other_bodies_changed 计数。
//      这些必须由我们自己算（FFDec 的 exit code 与自述日志都不可信：块文件不存在它照样 exit 0 并写出空体）。
//
// 只做「定位 + 摘要」，不做反编译。解析严格失败（抛错），绝不在可疑输入上给「差不多」的结果。
import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

// ─────────────────────────── SWF 标签流 ───────────────────────────

/**
 * 解开 FWS/CWS 的外壳，返回**标签流**（跳过 8 字节头 + RECT 帧尺寸 + frameRate + frameCount）。
 * 忘了跳 RECT 会让整个标签流错位（第一个短标签会被误读成 DefineShape），这一点踩过。
 * ZWS（LZMA）交给 FFDec，这里不支持。
 */
export function unwrapSwfForIndex(raw) {
    const magic = raw.subarray(0, 3).toString("latin1")
    const version = raw.readUInt8(3)
    if (magic !== "FWS" && magic !== "CWS") {
        throw new Error(`不支持的 SWF 压缩格式：${magic}（只支持 FWS/CWS；ZWS 请走 FFDec）`)
    }
    const afterHeader = magic === "FWS" ? raw.subarray(8) : inflateSync(raw.subarray(8))
    const nbits = afterHeader[0] >> 3
    const rectBytes = Math.ceil((5 + 4 * nbits) / 8)
    const tagStreamOffset = rectBytes + 4
    if (tagStreamOffset >= afterHeader.length) throw new Error("SWF 头之后没有标签流（RECT 解析越界）")
    return { magic, version, body: afterHeader.subarray(tagStreamOffset), headerBytes: 8 + tagStreamOffset }
}

/**
 * 遍历标签流，返回 `[{code, offset, length}]`（offset/length 指**载荷**在 body 里的位置）。
 * SWF 短标签的 length 字段是 6 bit，等于 0x3f 时后面跟 u32 长长度。
 */
export function walkSwfTags(body) {
    const tags = []
    let pos = 0
    while (pos + 2 <= body.length) {
        const codeAndLength = body.readUInt16LE(pos)
        const code = codeAndLength >> 6
        let length = codeAndLength & 0x3f
        pos += 2
        if (length === 0x3f) {
            if (pos + 4 > body.length) break
            length = body.readUInt32LE(pos)
            pos += 4
        }
        if (code === 0) break // End
        if (pos + length > body.length) throw new Error(`标签 ${code} 越界（offset=${pos} length=${length} total=${body.length}）`)
        tags.push({ code, offset: pos, length })
        pos += length
    }
    return tags
}

/**
 * DoABC（82）/DoABC2（72）标签里的 ABC 载荷。返回 `[{code, offset, name, abc}]`。
 *
 * 载荷布局（实测确认，别凭印象改）：`u32 flags` + **NUL 结尾的 name 字符串** + ABC 数据。
 * 曾经漏掉这一段，直接从载荷开头当 ABC 解析 ⇒ 常量池错位、报「未知的 trait kind 15」。
 */
export function findAbcTags(swfBuffer) {
    const { body } = unwrapSwfForIndex(swfBuffer)
    const out = []
    for (const tag of walkSwfTags(body)) {
        if (tag.code !== 82 && tag.code !== 72) continue
        const end = tag.offset + tag.length
        let start = tag.offset + 4 // flags（u32；DoABC 与 DoABC2 同布局）
        if (start >= end) continue
        const nul = body.indexOf(0, start)
        if (nul < 0 || nul >= end) continue
        const name = body.subarray(start, nul).toString("utf8")
        const abcStart = nul + 1
        if (abcStart + 4 > end) continue
        out.push({ code: tag.code, offset: tag.offset, name, abc: body.subarray(abcStart, end) })
    }
    return out
}

// ─────────────────────────── ABC 读取器 ───────────────────────────

/** 排障开关（`SPI_ABC_TRACE=1`）：打印每个区段解析结束时的偏移，用来定位常量池错位。 */
const TRACE = process.env.SPI_ABC_TRACE === "1"
function trace(label, reader) {
    if (TRACE) console.error(`[abc] ${label}: pos=${reader.pos}`)
}

class AbcReader {
    constructor(buffer) {
        this.buf = buffer
        this.pos = 0
    }
    need(n) {
        if (this.pos + n > this.buf.length) throw new Error(`ABC 越界：需要 ${n} B，剩余 ${this.buf.length - this.pos} B（offset=${this.pos}）`)
    }
    u8() { this.need(1); return this.buf[this.pos++] }
    u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
    u30() {
        let value = 0
        for (let i = 0; i < 5; i++) {
            this.need(1)
            const byte = this.buf[this.pos++]
            value |= (byte & 0x7f) << (7 * i)
            if ((byte & 0x80) === 0) break
        }
        return value >>> 0
    }
    s32() { return this.u30() | 0 }
    double() { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v }
    slice(n) { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v }
}

const NS_KIND = {
    0x05: "PrivateNs", 0x08: "Namespace", 0x16: "PackageNamespace", 0x17: "PackageInternalNs",
    0x18: "ProtectedNamespace", 0x19: "ExplicitNamespace", 0x1a: "StaticProtectedNs",
}

/** 解析常量池里的一个 multiname（必须完整吃掉它的所有字段，否则后面的下标全会错位）。 */
function readMultiname(reader) {
    const kind = reader.u8()
    switch (kind) {
        case 0x07: case 0x0d: return { kind, ns: reader.u30(), name: reader.u30() }
        case 0x0f: case 0x10: return { kind, name: reader.u30() }
        case 0x11: case 0x12: return { kind }
        case 0x09: case 0x0e: return { kind, name: reader.u30(), nsSet: reader.u30() }
        case 0x1b: case 0x1c: return { kind, nsSet: reader.u30() }
        case 0x1d: {
            const name = reader.u30()
            const count = reader.u30()
            const params = []
            for (let i = 0; i < count; i++) params.push(reader.u30())
            return { kind, name, params }
        }
        default: throw new Error(`未知的 multiname kind 0x${kind.toString(16)}（offset=${reader.pos - 1}）`)
    }
}

/**
 * trait 的字段布局（**按 AVM2 规范逐 kind 对齐，弄错一个 kind 整个 ABC 就会错位**）：
 *   0 Slot / 6 Const      → slot_id, type_name, vindex, [vkind（vindex≠0 时多 1 B）]
 *   1 Method / 2 Getter / 3 Setter → disp_id, method
 *   4 Class               → slot_id, classi
 *   5 Function            → slot_id, function
 * 属性位在高 4 位：ATTR_Metadata = 0x40。曾经把 4/5 当成 Slot/Const 解析 ⇒ 常量池之后的整块错位。
 */
function readTraits(reader, out, owner) {
    const count = reader.u30()
    for (let i = 0; i < count; i++) {
        const nameIdx = reader.u30()
        const kindAndAttr = reader.u8()
        const kind = kindAndAttr & 0x0f
        const attr = kindAndAttr >> 4
        const trait = { owner, nameIdx, kind, attr }
        if (kind === 0 || kind === 6) {
            trait.slotId = reader.u30()
            trait.typeName = reader.u30()
            trait.vindex = reader.u30()
            if (trait.vindex !== 0) trait.vkind = reader.u8()
        } else if (kind === 1 || kind === 2 || kind === 3) {
            trait.dispId = reader.u30()
            trait.methodIdx = reader.u30()
        } else if (kind === 4) {
            trait.slotId = reader.u30()
            trait.classIdx = reader.u30()
        } else if (kind === 5) {
            trait.slotId = reader.u30()
            trait.functionIdx = reader.u30()
        } else {
            throw new Error(`未知的 trait kind ${kind}（offset=${reader.pos}）`)
        }
        if (kindAndAttr & 0x40) {
            const metadataCount = reader.u30()
            trait.metadata = []
            for (let k = 0; k < metadataCount; k++) trait.metadata.push(reader.u30())
        }
        out.push(trait)
    }
    return count
}

/**
 * 解析一份 ABC。返回的 `bodies[i]` 就是 FFDec `abc.bodies.get(i)` 的那一项。
 * `codeSha` 是方法体**原始 code 字节**的 sha256（这是我们对比「只有靶方法变」的锚）。
 */
export function parseAbc(buffer) {
    const reader = new AbcReader(buffer)
    const minor = reader.u16()
    const major = reader.u16()

    const counts = {}
    counts.int = reader.u30()
    for (let i = 1; i < counts.int; i++) reader.s32()
    counts.uint = reader.u30()
    for (let i = 1; i < counts.uint; i++) reader.u30()
    counts.double = reader.u30()
    for (let i = 1; i < counts.double; i++) reader.double()

    counts.string = reader.u30()
    const strings = new Array(counts.string).fill(null)
    for (let i = 1; i < counts.string; i++) {
        const length = reader.u30()
        strings[i] = reader.slice(length).toString("utf8")
    }

    counts.namespace = reader.u30()
    const namespaces = new Array(counts.namespace).fill(null)
    for (let i = 1; i < counts.namespace; i++) {
        const kind = reader.u8()
        namespaces[i] = { kind, kindName: NS_KIND[kind] || `0x${kind.toString(16)}`, name: reader.u30() }
    }

    counts.nsSet = reader.u30()
    const nsSets = new Array(counts.nsSet).fill(null)
    for (let i = 1; i < counts.nsSet; i++) {
        const count = reader.u30()
        const set = []
        for (let k = 0; k < count; k++) set.push(reader.u30())
        nsSets[i] = set
    }

    counts.multiname = reader.u30()
    const multinames = new Array(counts.multiname).fill(null)
    for (let i = 1; i < counts.multiname; i++) multinames[i] = readMultiname(reader)

    trace(`cp done (int=${counts.int} uint=${counts.uint} double=${counts.double} string=${counts.string} ns=${counts.namespace} nsSet=${counts.nsSet} mn=${counts.multiname})`, reader)
    // ★ AVM2 有两套计数约定，别混：cpool_info 里的 count **含 0 号槽**（条目数 = count − 1），
    //   而 method/metadata/class/script/method_body 的 count 是**纯计数**（条目数 = count）。
    //   把后者也按 −1 处理会让每个区段少读一条 ⇒ 方法段恰好短 4 B，之后全错位（踩过）。
    counts.method = reader.u30()
    const methods = new Array(counts.method).fill(null)
    for (let i = 0; i < counts.method; i++) {
        const method = { paramCount: reader.u30(), returnType: reader.u30(), paramTypes: [] }
        const start = reader.pos - 2
        for (let k = 0; k < method.paramCount; k++) method.paramTypes.push(reader.u30())
        method.name = reader.u30()
        method.flags = reader.u8()
        if (method.flags & 0x08) {
            method.options = []
            const optionCount = reader.u30()
            for (let k = 0; k < optionCount; k++) method.options.push({ value: reader.u30(), kind: reader.u8() })
        }
        if (method.flags & 0x80) {
            method.paramNames = []
            for (let k = 0; k < method.paramCount; k++) method.paramNames.push(reader.u30())
        }
        if (TRACE) console.error(`[abc]   method#${i} start=${start} pc=${method.paramCount} rt=${method.returnType} name=${method.name} flags=0x${method.flags.toString(16)} end=${reader.pos}`)
        methods[i] = method
    }

    trace(`methods=${counts.method} done`, reader)
    counts.metadata = reader.u30()
    const metadata = new Array(counts.metadata).fill(null)
    for (let i = 0; i < counts.metadata; i++) {
        const item = { name: reader.u30(), items: [] }
        const count = reader.u30()
        for (let k = 0; k < count; k++) item.items.push({ key: reader.u30(), value: reader.u30() })
        metadata[i] = item
    }

    trace(`metadata=${counts.metadata} done`, reader)
    counts.class = reader.u30()
    const classes = new Array(counts.class).fill(null)
    for (let i = 0; i < counts.class; i++) {
        const info = { instanceTraits: [], classTraits: [] }
        const instStart = reader.pos
        info.name = reader.u30()
        info.superName = reader.u30()
        info.flags = reader.u8()
        if (info.flags & 0x08) info.protectedNs = reader.u30()
        const interfaceCount = reader.u30()
        info.interfaces = []
        for (let k = 0; k < interfaceCount; k++) info.interfaces.push(reader.u30())
        info.iinit = reader.u30()
        if (TRACE) console.error(`[abc]   class#${i} start=${instStart} name=${info.name} super=${info.superName} flags=0x${info.flags.toString(16)} ifaces=${info.interfaces.length} iinit=${info.iinit} traitsAt=${reader.pos}`)
        readTraits(reader, info.instanceTraits, `class#${i}`)
        classes[i] = info
    }
    // ★ 必须分成两趟：ABC 里是「先全部 instance_info，再全部 class_info」。
    //   把 cinit + class traits 并进上面那趟循环会拿下一个 instance 的字节当 class traits 解析（踩过，症状是随机 trait kind）。
    for (let i = 0; i < counts.class; i++) {
        const info = classes[i]
        info.cinit = reader.u30()
        readTraits(reader, info.classTraits, `class#${i}`)
    }

    trace(`classes=${counts.class} done`, reader)
    counts.script = reader.u30()
    const scripts = new Array(counts.script).fill(null)
    for (let i = 0; i < counts.script; i++) {
        const script = { traits: [] }
        script.init = reader.u30()
        readTraits(reader, script.traits, `script#${i}`)
        scripts[i] = script
    }

    trace(`scripts=${counts.script} done`, reader)
    counts.body = reader.u30()
    const bodies = new Array(counts.body).fill(null)
    for (let i = 0; i < counts.body; i++) {
        const body = { index: i }
        body.method = reader.u30()
        body.maxStack = reader.u30()
        body.localCount = reader.u30()
        body.initScopeDepth = reader.u30()
        body.maxScopeDepth = reader.u30()
        body.codeLength = reader.u30()
        body.codeOffset = reader.pos
        const code = reader.slice(body.codeLength)
        body.codeSha = sha256(code)
        body.exceptionCount = reader.u30()
        body.exceptions = []
        for (let k = 0; k < body.exceptionCount; k++) {
            body.exceptions.push({ from: reader.u30(), to: reader.u30(), target: reader.u30(), type: reader.u30(), varName: reader.u30() })
        }
        body.traits = []
        readTraits(reader, body.traits, `body#${i}`)
        bodies[i] = body
    }

    return { minor, major, counts, strings, namespaces, nsSets, multinames, methods, metadata, classes, scripts, bodies, endOffset: reader.pos, totalBytes: buffer.length }
}

// ─────────────────────────── 命名与查找 ───────────────────────────

function nsName(abc, index) {
    const ns = abc.namespaces[index]
    return ns ? abc.strings[ns.name] : null
}

/** 把 multiname 渲染成人类可读名字：QName 给 `pkg::name`，其余给 kind 标签。 */
export function multinameToString(abc, index) {
    const mn = abc.multinames[index]
    if (!mn) return null
    if (mn.kind === 0x07 || mn.kind === 0x0d) {
        const ns = nsName(abc, mn.ns)
        const name = abc.strings[mn.name]
        if (!name) return null
        return ns ? `${ns}:${name}` : name
    }
    if (mn.kind === 0x09 || mn.kind === 0x0e || mn.kind === 0x0f || mn.kind === 0x10) {
        const name = abc.strings[mn.name]
        return name || null
    }
    return null
}

/** 类 FQCN（包名 + 类名）；拿不到包名时退化成裸类名。 */
export function classNameOf(abc, classIndex) {
    const info = abc.classes[classIndex]
    if (!info) return null
    const rendered = multinameToString(abc, info.name)
    if (!rendered) return null
    const colon = rendered.indexOf(":")
    return colon === -1 ? rendered : `${rendered.slice(0, colon)}.${rendered.slice(colon + 1)}`
}

/** 类清单指纹：全部 instance 的 FQCN 排序后 sha256（用于「类清单没变」的硬校验）。 */
export function classListDigest(abc) {
    const names = []
    for (let i = 0; i < abc.classes.length; i++) {
        const name = classNameOf(abc, i)
        if (name) names.push(name)
    }
    names.sort()
    return { count: names.length, sha256: sha256(Buffer.from(names.join("\n"), "utf8")) }
}

/**
 * 按「类 FQCN + 方法名」找方法体在 `abc.bodies` 里的**全局**下标。
 * 这是喂给 FFDec `-replace` 的那个数字。歧义（同名方法/多方法体）一律报错不猜。
 */
export function findMethodBody(abc, className, methodName) {
    const matches = []
    for (let i = 0; i < abc.classes.length; i++) {
        if (classNameOf(abc, i) !== className) continue
        const info = abc.classes[i]
        for (const trait of [...info.instanceTraits, ...info.classTraits]) {
            if (trait.kind !== 1 && trait.kind !== 2 && trait.kind !== 3) continue
            if (multinameToString(abc, trait.nameIdx) !== methodName) continue
            matches.push({ classIndex: i, traitKind: trait.kind, methodIdx: trait.methodIdx })
        }
    }
    if (matches.length === 0) return { ok: false, reason: `类 ${className} 里找不到方法 ${methodName}` }
    if (matches.length > 1) {
        return { ok: false, reason: `类 ${className} 里方法名 ${methodName} 不唯一（命中 ${matches.length} 个 trait：kind=${matches.map(m => m.traitKind).join(",")}）` }
    }
    const hit = matches[0]
    const bodyIndexes = []
    for (let i = 0; i < abc.bodies.length; i++) {
        if (abc.bodies[i] && abc.bodies[i].method === hit.methodIdx) bodyIndexes.push(i)
    }
    if (bodyIndexes.length !== 1) {
        return { ok: false, reason: `方法 ${className}/${methodName} 对应 ${bodyIndexes.length} 个方法体（期望恰好 1 个）` }
    }
    const body = abc.bodies[bodyIndexes[0]]
    return {
        ok: true, bodyIndex: bodyIndexes[0], methodIdx: hit.methodIdx, traitKind: hit.traitKind,
        codeLength: body.codeLength, codeSha: body.codeSha, maxStack: body.maxStack, localCount: body.localCount,
    }
}

/**
 * 逐方法体的比对：返回「哪些下标的 code 变了」。AS3 通路的硬断言「other_bodies_changed = 0」靠它。
 * 只比 code 字节；方法体数量/方法个数变化单独报。
 */
export function diffBodies(baseAbc, patchedAbc) {
    const changed = []
    const baseCount = baseAbc.bodies.length
    const patchedCount = patchedAbc.bodies.length
    const limit = Math.min(baseCount, patchedCount)
    for (let i = 0; i < limit; i++) {
        const a = baseAbc.bodies[i]
        const b = patchedAbc.bodies[i]
        if (!a || !b) continue
        if (a.codeSha !== b.codeSha || a.method !== b.method) changed.push(i)
    }
    const appended = []
    for (let i = limit; i < patchedCount; i++) appended.push(i)
    return { changed, appended, baseCount, patchedCount, countDelta: patchedCount - baseCount }
}

/** 在 SWF 的所有 ABC 里找包含该类的那个，连同其下标一起返回。 */
export function locateClassAbc(swfBuffer, className) {
    const tags = findAbcTags(swfBuffer)
    const hits = []
    for (const tag of tags) {
        const abc = parseAbc(tag.abc)
        for (let i = 0; i < abc.classes.length; i++) {
            if (classNameOf(abc, i) === className) hits.push({ tag, abc, classIndex: i })
        }
    }
    return hits
}
