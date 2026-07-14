import type { TerminalChunk, TerminalError } from "@starbase/core"
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { RingBuffer, TerminalService } from "./terminal.js"

/**
 * Two things must hold or this feature leaks/drowns: (1) the replay ring is a
 * hard memory ceiling regardless of how much a process spews, and (2) the live
 * `attach` path *coalesces* — a flood of raw PTY chunks reaches the renderer as
 * a handful of frames, not thousands. We prove both against a real PTY, plus the
 * lifecycle contract (list scoping, kill/killAll drop the handle, exited terminals
 * still replay their last screen + a single exit frame).
 */

describe("RingBuffer", () => {
  it("preserves order and joins on read while under cap", () => {
    const ring = new RingBuffer(1024)
    ring.push("a")
    ring.push("bc")
    ring.push("def")
    expect(ring.read()).toBe("abcdef")
    expect(ring.size).toBe(6)
  })

  it("ignores empty pushes", () => {
    const ring = new RingBuffer(1024)
    ring.push("")
    expect(ring.size).toBe(0)
    expect(ring.read()).toBe("")
  })

  it("trims whole chunks from the front once over cap", () => {
    const ring = new RingBuffer(5)
    ring.push("aaa")
    ring.push("bbb") // total 6 > 5 → drop "aaa"
    expect(ring.size).toBeLessThanOrEqual(5)
    expect(ring.read()).toBe("bbb")
  })

  it("tail-slices a single oversized chunk down to cap", () => {
    const ring = new RingBuffer(4)
    ring.push("0123456789") // one chunk far bigger than cap
    expect(ring.size).toBe(4)
    expect(ring.read()).toBe("6789") // keeps the most-recent bytes
  })

  it("never exceeds cap across many pushes", () => {
    const ring = new RingBuffer(100)
    for (let i = 0; i < 1000; i++) ring.push(`chunk-${i}-payload`)
    expect(ring.size).toBeLessThanOrEqual(100)
  })
})

/** Run an effect against a fresh TerminalService, always reclaiming PTYs after. */
const withService = <A>(
  body: (t: TerminalService) => Effect.Effect<A, TerminalError, never>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const terminals = yield* TerminalService
      return yield* body(terminals).pipe(Effect.ensuring(terminals.killAll))
    }).pipe(Effect.provide(TerminalService.Default))
  )

/** Poll a synchronous predicate until true or the budget elapses (real timers,
 * so these PTY tests stay robust under a saturated full-suite run). */
const waitFor = (check: () => boolean, timeoutMs = 10_000, stepMs = 25) =>
  Effect.gen(function* () {
    let waited = 0
    while (!check() && waited < timeoutMs) {
      yield* Effect.sleep(`${stepMs} millis`)
      waited += stepMs
    }
  })

/** Attach in a background fiber, collecting frames until interrupted or exit. */
const collect = (t: TerminalService, id: string) => {
  const frames: TerminalChunk[] = []
  const fiber = Effect.runFork(
    Effect.scoped(
      t.attach(id).pipe(Stream.runForEach((c) => Effect.sync(() => void frames.push(c))))
    )
  )
  const data = () => frames.filter((f) => f._tag === "data").map((f) => (f as { data: string }).data)
  return { frames, dataFrames: data, text: () => data().join(""), fiber }
}

describe("TerminalService", () => {
  it("spawns a running terminal and lists it only for its own session", () =>
    withService((t) =>
      Effect.gen(function* () {
        const info = yield* t.create({ sessionId: "s1", cwd: process.cwd(), cols: 80, rows: 24 })
        expect(info.status).toBe("running")
        expect(info.exitCode).toBeNull()
        expect(info.cwd).toBe(process.cwd())
        expect(info.sessionId).toBe("s1")

        const mine = yield* t.list("s1")
        expect(mine.map((i) => i.id)).toContain(info.id)
        const other = yield* t.list("s2")
        expect(other).toHaveLength(0)
      })
    ))

  it("echoes written input back on the attach stream", () =>
    withService((t) =>
      Effect.gen(function* () {
        const info = yield* t.create({ sessionId: "s1", cols: 80, rows: 24 })
        const sink = collect(t, info.id)
        yield* Effect.sleep("150 millis") // let the shell + attach settle
        yield* t.write(info.id, "echo HELLO_STARBASE\r")
        yield* waitFor(() => sink.text().includes("HELLO_STARBASE"))
        yield* Fiber.interrupt(sink.fiber)
        expect(sink.text()).toContain("HELLO_STARBASE")
      })
    ))

  it("coalesces a flood into a bounded number of frames", () =>
    withService((t) =>
      Effect.gen(function* () {
        const info = yield* t.create({ sessionId: "s1", cols: 200, rows: 50 })
        const sink = collect(t, info.id)
        yield* Effect.sleep("150 millis")
        // ~5000 lines of output as fast as the shell can print — a genuine flood.
        yield* t.write(info.id, "for i in $(seq 1 5000); do echo flood-line-$i-xxxxxxxxxxxxxxxxxxxx; done\r")
        // Wait until the flood has actually landed (robust under load), then let
        // any trailing frames settle before sampling the coalesced frame count.
        yield* waitFor(() => sink.text().length > 50_000)
        yield* Effect.sleep("300 millis")
        yield* Fiber.interrupt(sink.fiber)

        const bytes = sink.text().length
        const frameCount = sink.dataFrames().length
        // The flood really happened...
        expect(bytes).toBeGreaterThan(50_000)
        // ...yet coalescing kept frames far below one-per-raw-chunk. Bounded by
        // (bytes / 32KB size-flush) + (~elapsed / 16ms tick-flush) + replay, so a
        // few hundred is a comfortable, non-flaky ceiling well under the 1000s of
        // raw onData chunks a 5000-line flood produces.
        expect(frameCount).toBeLessThan(400)
      })
    ))

  it("drops the handle from the map on kill", () =>
    withService((t) =>
      Effect.gen(function* () {
        const info = yield* t.create({ sessionId: "s1", cols: 80, rows: 24 })
        expect((yield* t.list("s1")).length).toBe(1)
        yield* t.kill(info.id)
        expect(yield* t.list("s1")).toHaveLength(0)
      })
    ))

  it("killAll reclaims every terminal across sessions", () =>
    withService((t) =>
      Effect.gen(function* () {
        yield* t.create({ sessionId: "s1", cols: 80, rows: 24 })
        yield* t.create({ sessionId: "s2", cols: 80, rows: 24 })
        yield* t.killAll
        expect(yield* t.list("s1")).toHaveLength(0)
        expect(yield* t.list("s2")).toHaveLength(0)
      })
    ))

  it("write/resize on an unknown terminal are safe no-ops", () =>
    withService((t) =>
      Effect.gen(function* () {
        yield* t.write("nope", "data")
        yield* t.resize("nope", 100, 40)
        // Reaching here without throwing is the assertion.
        expect(true).toBe(true)
      })
    ))

  it("replays the last screen and a final exit frame for an exited terminal", () =>
    withService((t) =>
      Effect.gen(function* () {
        const info = yield* t.create({ sessionId: "s1", cols: 80, rows: 24 })
        yield* t.write(info.id, "echo BEFORE_EXIT\r")
        yield* Effect.sleep("200 millis")
        yield* t.write(info.id, "exit\r")

        // Poll until the shell process has actually exited (robust under load).
        const exited = () => (Effect.runSync(t.list("s1")).find((i) => i.id === info.id))?.status === "exited"
        yield* waitFor(exited)

        // Exited terminals stay in the map (renderer can still re-attach to read
        // the final screen) until an explicit kill.
        const status = (yield* t.list("s1")).find((i) => i.id === info.id)
        expect(status?.status).toBe("exited")

        const frames: TerminalChunk[] = []
        yield* Effect.scoped(
          t.attach(info.id).pipe(Stream.runForEach((c) => Effect.sync(() => void frames.push(c))))
        )
        // Stream completed on its own (no interrupt needed).
        expect(frames.some((f) => f._tag === "data")).toBe(true)
        expect(frames.at(-1)?._tag).toBe("exit")
      })
    ))
})
