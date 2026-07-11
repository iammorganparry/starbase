import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { DiscoveryService } from "./discovery.js"
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
    expect(exit.value).toHaveLength(3) // one entry per CLI spec

    expect(byKind.claude).toMatchObject({ available: true, version: "claude 2.1.0" })
    expect(byKind.claude?.binPath).toBe("/usr/local/bin/claude")
    expect(byKind.codex?.available).toBe(false)
    expect(byKind.cursor?.available).toBe(false)
  })

  it("marks every CLI unavailable when nothing resolves", async () => {
    const exit = await run(() => ({ stdout: "" }))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.every((c) => !c.available)).toBe(true)
    }
  })
})
