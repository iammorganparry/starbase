import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { killAllChildren, liveChildCount, stopChild, trackChild } from "./child-registry.js"

/**
 * The orphan guard. A harness subprocess that outlives the app is invisible,
 * holds a port, and accumulates one per launch — under the e2e suite that meant
 * one leaked `opencode serve` per test until the machine was cleared by hand.
 */

/** A child that ignores SIGTERM, standing in for a server that won't go quietly. */
const stubborn = (): ChildProcess =>
  trackChild(
    spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    })
  )

/** A child that exits on SIGTERM, like a well-behaved server. */
const polite = (): ChildProcess =>
  trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }))

const exited = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once("exit", () => resolve())
  })

const isRunning = (proc: ChildProcess): boolean => {
  if (proc.pid === undefined) return false
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(proc.pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  // Never let a test leak the very thing this module exists to prevent.
  killAllChildren()
})

describe("trackChild", () => {
  it("registers a spawned child", () => {
    const before = liveChildCount()
    polite()
    expect(liveChildCount()).toBe(before + 1)
  })

  it("deregisters it once it exits, so the set can't grow forever", async () => {
    const before = liveChildCount()
    const proc = polite()
    proc.kill("SIGKILL")
    await exited(proc)
    // The 'exit' listener runs on the same tick as the event.
    expect(liveChildCount()).toBe(before)
  })

  it("returns the same child, so it can wrap a spawn call directly", () => {
    const proc = polite()
    expect(typeof proc.pid).toBe("number")
  })
})

describe("stopChild", () => {
  it("stops a child that honours SIGTERM", async () => {
    const proc = polite()
    stopChild(proc)
    await exited(proc)
    expect(isRunning(proc)).toBe(false)
  })

  /**
   * The reason SIGTERM alone was not enough. opencode is a compiled Bun binary and
   * codex an app-server; neither is obliged to honour a polite request, and an
   * unheeded SIGTERM leaves exactly the process we were trying to reap.
   */
  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const proc = stubborn()
    // Give it a moment to install its SIGTERM handler before we signal.
    await new Promise((r) => setTimeout(r, 200))
    stopChild(proc, 300)
    await exited(proc)
    expect(proc.signalCode).toBe("SIGKILL")
    expect(isRunning(proc)).toBe(false)
  }, 10_000)

  it("is a no-op for a child that has already exited", async () => {
    const proc = polite()
    proc.kill("SIGKILL")
    await exited(proc)
    expect(() => stopChild(proc)).not.toThrow()
  })
})

describe("killAllChildren", () => {
  /** The quit path: everything still running dies, politely or otherwise. */
  it("kills every tracked child, including ones ignoring SIGTERM", async () => {
    const a = polite()
    const b = stubborn()
    await new Promise((r) => setTimeout(r, 200))

    const killed = killAllChildren()
    expect(killed).toBeGreaterThanOrEqual(2)

    await Promise.all([exited(a), exited(b)])
    expect(isRunning(a)).toBe(false)
    expect(isRunning(b)).toBe(false)
  }, 10_000)

  it("empties the registry", () => {
    polite()
    stubborn()
    killAllChildren()
    expect(liveChildCount()).toBe(0)
  })

  it("reports zero and does nothing when there is nothing to kill", () => {
    killAllChildren()
    expect(killAllChildren()).toBe(0)
  })

  /**
   * The e2e shape: a child spawned and then abandoned mid-flight, exactly as when
   * the app quits while the model catalogue is still being fetched. Nothing else
   * in the process holds a reference to it — the registry is the only way back.
   */
  it("reaps a child nobody kept a reference to", async () => {
    const pid = (() => {
      const orphan = stubborn()
      return orphan.pid
    })()
    await new Promise((r) => setTimeout(r, 200))
    expect(pid).toBeDefined()

    killAllChildren()
    await new Promise((r) => setTimeout(r, 500))

    let alive = true
    try {
      process.kill(pid!, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 10_000)
})
