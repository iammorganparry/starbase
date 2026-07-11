import type { Message } from "@starbase/core"
import { assistantMessage, userMessage } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { TranscriptStore } from "./transcripts.js"
import { withTempRoot } from "./test-support.js"

/**
 * The transcript is what reopening a session shows, so the behaviour that
 * matters is: it starts empty, appended turns survive a fresh read, and
 * `patchLast` replaces the streaming turn in place. Real temp filesystem, real
 * round-trips.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A>(
  effect: Effect.Effect<A, never, TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(TranscriptStore.Default, temp.layer))))

describe("TranscriptStore", () => {
  it("returns an empty transcript for an unknown session", async () => {
    const messages = await run(TranscriptStore.list("nope"))
    expect(messages).toStrictEqual([])
  })

  it("persists appended turns across a fresh read", async () => {
    const user = userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("s1", user)
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toStrictEqual([user])
  })

  it("patchLast replaces the last (streaming) turn in place", async () => {
    const user = userMessage("u1", "hi", "2026-07-11T10:00:00.000Z")
    const assistant = assistantMessage("a1", "2026-07-11T10:00:01.000Z")
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("s1", user)
        yield* TranscriptStore.append("s1", assistant)
        yield* TranscriptStore.patchLast("s1", (m): Message => ({
          ...m,
          streaming: false,
          parts: [{ _tag: "Text", text: "done" }]
        }))
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toStrictEqual(user)
    expect(messages[1]!.streaming).toBe(false)
    expect(messages[1]!.parts).toStrictEqual([{ _tag: "Text", text: "done" }])
  })

  it("patchLast on an empty transcript is a no-op", async () => {
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.patchLast("s1", (m) => m)
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toStrictEqual([])
  })
})
