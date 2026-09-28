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
const { spawnSync } = require("node:child_process")

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
    posixSignals: {
        name: "POSIX signal delivery (a child's SIGTERM handler running)",
        enable: process.platform === "win32"
            ? "Windows has no POSIX signals: it terminates the target process instead of delivering SIGTERM, so a graceful-shutdown handler never runs; run this suite on Linux/macOS to cover it"
            : "this host should deliver POSIX signals; check the container init and the process signal mask",
        probe: () => {
            // A process that installs a SIGTERM handler, signals itself, and proves the
            // signal was delivered by exiting 0 from that handler (9 if it never ran).
            const script = [
                "process.on('SIGTERM', () => process.exit(0))",
                "process.kill(process.pid, 'SIGTERM')",
                "setTimeout(() => process.exit(9), 5000)",
            ].join("; ")
            const result = spawnSync(process.execPath, ["-e", script], {
                encoding: "utf8",
                timeout: 15_000,
            })
            if (result.error !== undefined && result.error !== null) {
                return `running the SIGTERM probe failed with ${errorCode(result.error)}`
            }
            if (result.status !== 0) {
                return "SIGTERM never reached the child's handler (the process was terminated instead)"
            }
            return true
        },
    },
    zipCli: {
        name: "the external `zip` command-line tool",
        enable: process.platform === "win32"
            ? "install `zip` and put it on PATH (e.g. the usr/bin directory of Git for Windows, MSYS2, or 7-Zip's zip.exe)"
            : "install the `zip` package for this distribution",
        probe: () => {
            const result = spawnSync("zip", ["-v"], { encoding: "utf8" })
            if (result.error !== undefined && result.error !== null) {
                return `running "zip -v" failed with ${errorCode(result.error)}`
            }
            if (result.status !== 0) {
                return `"zip -v" exited with status ${result.status}`
            }
            return true
        },
    },
    oNoFollow: {
        name: "the POSIX O_NOFOLLOW open flag",
        enable: process.platform === "win32"
            ? "Windows has no O_NOFOLLOW at all; run this suite on Linux/macOS to cover it"
            : "this host should define O_NOFOLLOW; check how Node.js was built for it",
        probe: () => (typeof fs.constants.O_NOFOLLOW === "number"
            ? true
            : "fs.constants.O_NOFOLLOW is not defined on this platform"),
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

/**
 * Whole-file guard for suites written as plain scripts instead of node:test files,
 * which have no `t` to skip on and whose assertions run at module scope.
 *
 * Prints the repo's whole-file skip line and returns false; the caller must then stop
 * with `process.exit(0)`. The runner classifies that combination as SKIPPED rather than
 * passed or failed (tools/test-workflow/run.cjs:154-173), which is the same convention
 * tools/gacha_odds_export.test.cjs:15 already uses for an absent external input.
 *
 * @param {string} label Suite label used in the skip line.
 * @param {() => true | string} check Returns true when the input is present, else the
 *     reason it is missing.
 * @param {string} enable How to make the input available.
 * @returns {boolean} True when the caller should continue with its assertions.
 */
function requireExternalInput(label, check, enable) {
    let verdict
    try {
        verdict = check()
    } catch (error) {
        verdict = `the probe threw ${errorCode(error)}`
    }
    if (verdict === true) return true
    console.log(`${label} tests skipped: capability unavailable: ${verdict}. To enable: ${enable}.`)
    return false
}

module.exports = {
    capabilityNames,
    probe,
    requireCapability,
    requireExternalInput,
    skipMessage,
}
