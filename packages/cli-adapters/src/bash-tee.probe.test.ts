import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startTeeStream, teeLogPath } from "./bash-tee.js"

/**
 * LIVE PROBE — the real tee machinery against a real shell process.
 *
 * The unit tests pin the pure string rewrite; this drives the ACTUAL producer:
 * `startTeeStream` returns the rewritten command, we run it in a real `bash`, and
 * assert its output arrives as growing snapshots WHILE the process is still alive
 * (not one lump at the end), that the temp file is cleaned up, and — the part a
 * bare `| tee` gets wrong — that the command's real exit code survives the pipe.
 *
 * Gated behind STARBASE_PROBE=1 so a machine without bash never fails CI. Run it:
 *   STARBASE_PROBE=1 pnpm vitest run packages/cli-adapters/src/bash-tee.probe.test.ts
 */
const RUN = process.env.STARBASE_PROBE === "1"

/** Run a rewritten command in a real bash, resolving with its exit code. */
const runInBash = (command: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { stdio: "ignore" })
    child.on("close", (code) => resolve(code ?? -1))
  })

describe.runIf(RUN)("live probe: tee streaming against a real shell", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-tee-probe-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("streams a command's output as it runs, live, and preserves its exit code", async () => {
    // Five lines, ~200ms apart, then a non-zero exit — so a live tail must see
    // several partial snapshots before the process ends, and the exit code must
    // survive the `| tee`.
    const source = "for i in 1 2 3 4 5; do echo \"tick $i\"; sleep 0.2; done; exit 7"

    const snapshots: Array<{ atMs: number; text: string }> = []
    const t0 = Date.now()
    const stream = startTeeStream(
      "probe_call_1",
      source,
      (text) => snapshots.push({ atMs: Date.now() - t0, text }),
      { dir, pollMs: 50 }
    )

    // The rewrite tees to exactly the file we expect for this id.
    expect(stream.file).toBe(teeLogPath("probe_call_1", dir))

    const exitCode = await runInBash(stream.command)
    // Give the poller a beat to catch the final write, then stop.
    await new Promise((r) => setTimeout(r, 120))
    const finishedAt = Date.now() - t0
    stream.stop()

    // 1. The real command's exit code survived the pipe (a bare `| tee` would report 0).
    expect(exitCode).toBe(7)

    // 2. Output arrived as MULTIPLE growing snapshots — i.e. it streamed.
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.text.length).toBeGreaterThan(snapshots[i - 1]!.text.length)
    }

    // 3. At least one snapshot landed BEFORE the command finished — proof of
    //    liveness, not a single post-hoc read. (The last line arrives near the
    //    end; earlier ticks must predate it.)
    const firstTickAt = snapshots.find((s) => s.text.includes("tick 1"))?.atMs ?? Infinity
    expect(firstTickAt).toBeLessThan(finishedAt)
    expect(snapshots.some((s) => s.text.includes("tick 1") && !s.text.includes("tick 5"))).toBe(true)

    // 4. The final snapshot is the whole combined output, in order.
    const final = snapshots[snapshots.length - 1]!.text
    expect(final).toContain("tick 1")
    expect(final).toContain("tick 5")
    expect(final.indexOf("tick 1")).toBeLessThan(final.indexOf("tick 5"))

    // 5. stop() removes the temp file. Deletion is fire-and-forget best-effort
    //    (a leftover temp file must never block or fail a run), so give the async
    //    unlink a beat before checking.
    await new Promise((r) => setTimeout(r, 80))
    expect(existsSync(stream.file)).toBe(false)
  })

  it("captures stderr too, merged into the stream", async () => {
    const snapshots: string[] = []
    const stream = startTeeStream(
      "probe_call_2",
      "echo out; echo err 1>&2; sleep 0.1",
      (text) => snapshots.push(text),
      { dir, pollMs: 40 }
    )
    await runInBash(stream.command)
    await new Promise((r) => setTimeout(r, 100))
    stream.stop()

    const final = snapshots[snapshots.length - 1] ?? ""
    expect(final).toContain("out")
    expect(final).toContain("err") // 2>&1 on the group folds stderr in
  })
})
