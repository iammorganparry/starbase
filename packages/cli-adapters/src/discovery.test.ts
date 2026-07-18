import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { DiscoveryService, meetsMinVersion } from "./discovery.js"
import { fakeCommandExecutor, runExit } from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * DiscoveryService probes the host for coding CLIs. Those binaries aren't present
 * in CI, so we drive detection with canned `which` / `--version` output and
 * assert the resulting availability per CLI — never the probe's two-phase steps.
 */
const run = (handler: FakeCommandHandler) =>
  runExit(DiscoveryService.list().pipe(Effect.provide(DiscoveryService.Default)), fakeCommandExecutor(handler))

const basename = (command: string) => command.split("/").pop() ?? command

/**
 * The e2e hermeticity guard.
 *
 * `STARBASE_DISCOVERY_BIN_DIR` pins discovery to one directory so a test run can
 * never find the developer's real harnesses — booting them is slow, varies per
 * machine, and (since `withOpencodeServer` inherits the environment untouched)
 * runs them against the developer's own credentials.
 *
 * The handlers below deliberately report a REAL install via both other routes —
 * `which` resolves, and the absolute candidates answer `--version` — so each test
 * proves the pin overrides them rather than merely coinciding with an empty host.
 */
describe("DiscoveryService.list — pinned bin dir", () => {
  const PIN = "/tmp/starbase-pinned-bin"

  afterEach(() => {
    delete process.env.STARBASE_DISCOVERY_BIN_DIR
  })

  /** A host where every harness is genuinely installed, by both discovery routes. */
  const fullyInstalled: FakeCommandHandler = (command, args) => {
    if (command === "which" || command === "where") return { stdout: `/opt/homebrew/bin/${args[0]}` }
    if (args.includes("--version")) return { stdout: "9.9.9" }
    return { stdout: "" }
  }

  it("finds nothing when the pinned dir is empty, despite a real install on PATH", async () => {
    process.env.STARBASE_DISCOVERY_BIN_DIR = PIN
    const exit = await run((command, args) => {
      // The pinned probe runs `<pin>/<bin> --version`; that binary doesn't exist.
      if (command.startsWith(PIN)) return { stdout: "" }
      return fullyInstalled(command, args)
    })

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.every((c) => !c.available)).toBe(true)
    expect(exit.value.every((c) => c.binPath === null)).toBe(true)
  })

  it("finds only what the pinned dir contains", async () => {
    process.env.STARBASE_DISCOVERY_BIN_DIR = PIN
    const exit = await run((command, args) => {
      if (command === `${PIN}/claude` && args.includes("--version")) return { stdout: "2.0.0 (Claude Code)" }
      if (command.startsWith(PIN)) return { stdout: "" }
      return fullyInstalled(command, args)
    })

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const byKind = Object.fromEntries(exit.value.map((c) => [c.kind, c]))
    expect(byKind.claude).toMatchObject({ available: true, binPath: `${PIN}/claude` })
    // The others are installed on this fake host, and must still be invisible.
    expect(byKind.codex?.available).toBe(false)
    expect(byKind.opencode?.available).toBe(false)
    expect(byKind.cursor?.available).toBe(false)
  })

  /** PATH scrubbing alone could never do this — the candidates are absolute. */
  it("ignores the hardcoded absolute candidates while pinned", async () => {
    process.env.STARBASE_DISCOVERY_BIN_DIR = PIN
    const exit = await run((command) => {
      if (command.startsWith(PIN)) return { stdout: "" }
      // Every absolute candidate answers, as it would on a real dev machine.
      if (command.includes("/opt/homebrew/bin/") || command.includes("/.local/bin/")) {
        return { stdout: "9.9.9" }
      }
      return { stdout: "" }
    })

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.every((c) => !c.available)).toBe(true)
  })

  it("still probes the real host when the pin is unset or blank", async () => {
    process.env.STARBASE_DISCOVERY_BIN_DIR = ""
    const exit = await run(fullyInstalled)

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.some((c) => c.available)).toBe(true)
  })
})

describe("DiscoveryService.list", () => {
  it("marks a PATH-resolvable CLI available with its version, others unavailable", async () => {
    const exit = await run((command, args) => {
      if (command === "which" || command === "where") {
        return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
      }
      if (args.includes("--version") && basename(command) === "claude") {
        return { stdout: "claude 2.1.0" }
      }
      return { stdout: "" }
    })

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const byKind = Object.fromEntries(exit.value.map((c) => [c.kind, c]))
    expect(exit.value).toHaveLength(4) // one entry per CLI spec

    expect(byKind.claude).toMatchObject({ available: true, version: "claude 2.1.0" })
    expect(byKind.claude?.binPath).toBe("/usr/local/bin/claude")
    expect(byKind.codex?.available).toBe(false)
    expect(byKind.cursor?.available).toBe(false)
    expect(byKind.opencode?.available).toBe(false)
  })

  it("marks every CLI unavailable when nothing resolves", async () => {
    const exit = await run(() => ({ stdout: "" }))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.every((c) => !c.available)).toBe(true)
    }
  })

  /**
   * opencode is the only CLI carrying a `minVersion`. The 1.0.x line can't be
   * driven the way the adapter expects (no `--auto`/`--fork`/`--variant`, and it
   * predates the SQLite session store), so it must read as unavailable — but
   * *with a note*, or a too-old binary is indistinguishable from a missing one.
   */
  const opencodeAt = (version: string) =>
    run((command, args) => {
      if (command === "which" || command === "where") {
        return args[0] === "opencode" ? { stdout: "/opt/homebrew/bin/opencode" } : { stdout: "" }
      }
      if (args.includes("--version") && basename(command) === "opencode") {
        return { stdout: version }
      }
      return { stdout: "" }
    })

  it("marks opencode available at the minimum version", async () => {
    const exit = await opencodeAt("1.18.0")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const opencode = exit.value.find((c) => c.kind === "opencode")
    expect(opencode).toMatchObject({ available: true, version: "1.18.0" })
    expect(opencode?.binPath).toBe("/opt/homebrew/bin/opencode")
    expect(opencode?.note).toBeUndefined()
  })

  it("rejects an installed-but-too-old opencode, explaining why", async () => {
    const exit = await opencodeAt("1.0.220")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const opencode = exit.value.find((c) => c.kind === "opencode")
    expect(opencode).toMatchObject({ available: false, binPath: null })
    // The note is the whole point: it names the version found and the fix.
    expect(opencode?.note).toContain("1.0.220")
    expect(opencode?.note).toContain("1.18")
    expect(opencode?.note).toContain("opencode upgrade")
  })
})

describe("meetsMinVersion", () => {
  it("compares major then minor", () => {
    expect(meetsMinVersion("1.18.0", [1, 18])).toBe(true)
    expect(meetsMinVersion("1.19.3", [1, 18])).toBe(true)
    expect(meetsMinVersion("2.0.0", [1, 18])).toBe(true)
    expect(meetsMinVersion("1.17.9", [1, 18])).toBe(false)
    // 1.0.220's patch is numerically large — a lexical compare would pass it.
    expect(meetsMinVersion("1.0.220", [1, 18])).toBe(false)
    expect(meetsMinVersion("0.99.0", [1, 18])).toBe(false)
  })

  it("reads the version out of a noisy banner", () => {
    expect(meetsMinVersion("codex-cli 0.5.0", [1, 18])).toBe(false)
    expect(meetsMinVersion("1.2.3 (Claude Code)", [1, 2])).toBe(true)
  })

  it("treats an unreadable version as passing, and a missing one as failing", () => {
    // Refusing to run a CLI because we couldn't parse its banner is worse than
    // trying and failing loudly. But no version at all means no binary.
    expect(meetsMinVersion("some-cli (dev build)", [1, 18])).toBe(true)
    expect(meetsMinVersion(null, [1, 18])).toBe(false)
  })
})
