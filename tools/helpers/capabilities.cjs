"use strict"

// Test-only capability probes.
//
// Some suites exercise host features that a given machine may simply not provide:
// creating real symbolic links, and having POSIX permission bits reported and
// enforced. Those are properties of the host, not of the code under test, so the
// suite must say so out loud instead of failing as though the product were broken.
//
// Rules for callers:
//   * Gate on the probed capability, never on process.platform alone. A Windows
//     host with Developer Mode enabled can create symlinks and must keep running
//     these cases; a POSIX host keeps running them unconditionally.
//   * When the capability is missing, skip with the message this module builds. It
//     names both the missing capability and how to enable it.
//   * Never turn a missing capability into a weakened assertion: either the real
//     assertion runs, or the case is reported skipped.
//
// The probe runs once per process and the verdict is cached, so a suite can ask
// on every case without paying for a filesystem round-trip each time.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const PROBE_DIRECTORY_PREFIX = "capability-probe-"

/**
 * @typedef {object} Capability
 * @property {string} name Human-readable capability name used in skip messages.
 * @property {string} enable How to make the capability available.
 * @property {() => true | string} probe Returns true when available, else the
 *     reason it is unavailable.
 */

/** @type {Map<string, true | string>} */
const results = new Map()

function withScratchDirectory(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), PROBE_DIRECTORY_PREFIX))
    try {
        return run(directory)
    } finally {
        try {
            fs.rmSync(directory, { recursive: true, force: true })
        } catch {
            // A leftover probe directory must never fail a suite.
        }
    }
}

function errorCode(error) {
    if (error !== null && typeof error === "object" && typeof error.code === "string") {
        return error.code
    }
    return error instanceof Error ? error.message : String(error)
}

/** @type {Record<string, Capability>} */
const CAPABILITIES = {
    symlink: {
        name: "creating symbolic links",
        enable: process.platform === "win32"
            ? "enable Developer Mode (Settings > System > For developers) or run the test process elevated"
            : "this host should support symbolic links; check the filesystem and mount options",
        probe: () => withScratchDirectory(directory => {
            const target = path.join(directory, "target.txt")
            fs.writeFileSync(target, "probe", "utf8")
            try {
                fs.symlinkSync(target, path.join(directory, "link-file.txt"), "file")
            } catch (error) {
                return `creating a file symbolic link failed with ${errorCode(error)}`
            }
                try {
                    fs.symlinkSync(directory, path.join(directory, "link-dir"), "dir")
                } catch (error) {
                    return `creating a directory symbolic link failed with ${errorCode(error)}`
                }
            return true
        }),
    },
    posixFileMode: {
        name: "POSIX file permission bits (0o600)",
        enable: process.platform === "win32"
            ? "Windows does not report or enforce POSIX mode bits; run this suite on Linux/macOS to cover it"
            : "this host should report POSIX mode bits; check the filesystem and mount options",
        probe: () => withScratchDirectory(directory => {
            const file = path.join(directory, "mode-probe.txt")
            fs.writeFileSync(file, "probe", { encoding: "utf8", mode: 0o600 })
            fs.chmodSync(file, 0o600)
            const mode = Number(fs.statSync(file).mode) & 0o777
            if (mode !== 0o600) {
                return `a file created with mode 0o600 reports 0o${mode.toString(8)}`
            }
            return true
        }),
    },
    posixDirMode: {
        name: "POSIX directory permission bits (0o700)",
        enable: process.platform === "win32"
            ? "Windows does not report or enforce POSIX mode bits; run this suite on Linux/macOS to cover it"
            : "this host should report POSIX mode bits; check the filesystem and mount options",
        probe: () => withScratchDirectory(directory => {
            const nested = path.join(directory, "mode-probe-dir")
            fs.mkdirSync(nested, { recursive: true, mode: 0o700 })
            fs.chmodSync(nested, 0o700)
            const mode = Number(fs.statSync(nested).mode) & 0o777
            if (mode !== 0o700) {
                return `a directory created with mode 0o700 reports 0o${mode.toString(8)}`
            }
            return true
        }),
    },
}

function capabilityNames() {
    return Object.keys(CAPABILITIES)
}

/**
 * @param {string} capability
 * @returns {true | string} True when the capability is available, else the reason.
 */
function probe(capability) {
    const definition = CAPABILITIES[capability]
    if (definition === undefined) {
        throw new Error(`Unknown capability "${capability}"`)
    }
    if (!results.has(capability)) {
        let verdict
        try {
            verdict = definition.probe()
        } catch (error) {
            verdict = `the capability probe threw ${errorCode(error)}`
        }
        results.set(capability, verdict)
    }
    return results.get(capability)
}

function skipMessage(capability) {
    const definition = CAPABILITIES[capability]
    const reason = probe(capability)
    const detail = reason === true ? "unavailable" : reason
    return `capability unavailable: ${definition.name} (${detail}). To enable: ${definition.enable}.`
}

/**
 * Skip `t` unless the host provides `capability`.
 *
 * @param {{skip: (message?: string) => void}} t The node:test context.
 * @param {string} capability
 * @returns {boolean} True when the caller should continue with its assertions.
 */
function requireCapability(t, capability) {
    const verdict = probe(capability)
    if (verdict === true) return true
    t.skip(skipMessage(capability))
    return false
}

module.exports = {
    capabilityNames,
    probe,
    requireCapability,
    skipMessage,
}
