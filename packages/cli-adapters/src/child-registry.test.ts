import { spawn } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { killTrackedChildren, trackChild, trackedChildCount } from "./child-registry.js"

/**
 * A long-lived child that won't exit on its own, so a test can assert it's still
 * alive before the reap and gone after. `sleep 30` is enough; every test kills it.
 */
const spawnSleeper = () => spawn("sleep", ["30"], { stdio: "ignore" })

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a spawned child to actually acquire a pid (spawn is async on some OSes). */
const untilExit = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once("exit", () => resolve())
  })

afterEach(() => {
  // Never leak a real sleeper out of the suite, whatever a test did.
  killTrackedChildren("SIGKILL")
})

describe("child registry", () => {
  it("reaps a tracked child that outlives its owner", async () => {
    const child = trackChild(spawnSleeper())
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    const killed = killTrackedChildren()
    expect(killed).toBe(1)

    await untilExit(child)
    expect(isAlive(pid)).toBe(false)
  })

  it("forgets a child once it exits, so it isn't signalled twice", async () => {
    const child = trackChild(spawnSleeper())
    expect(trackedChildCount()).toBe(1)

    child.kill("SIGKILL")
    await untilExit(child)

    // The `exit` listener should have dropped it from the set.
    expect(trackedChildCount()).toBe(0)
    expect(killTrackedChildren()).toBe(0)
  })

  it("does not track a child that never acquired a pid", () => {
    // A bogus binary: `spawn` returns a handle with no pid and emits `error`.
    const child = spawn("this-binary-does-not-exist-starbase", [])
    // Swallow the async ENOENT so it doesn't surface as an unhandled error.
    child.on("error", () => {})
    trackChild(child)
    expect(trackedChildCount()).toBe(0)
  })

  it("counts only children signalled, skipping ones already dead", async () => {
    const a = trackChild(spawnSleeper())
    const b = trackChild(spawnSleeper())
    expect(trackedChildCount()).toBe(2)

    a.kill("SIGKILL")
    await untilExit(a)

    // `a` is gone and self-removed; only `b` remains to signal.
    expect(killTrackedChildren()).toBe(1)
    await untilExit(b)
  })
})
