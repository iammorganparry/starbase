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

  it("leaves no scratch file behind, so a killed write cannot truncate history", async () => {
    const user = userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")
    const { entries, raw } = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const paths = yield* AppPaths
        yield* TranscriptStore.append("s1", user)
        yield* TranscriptStore.append("s1", assistantMessage("a1", "2026-07-11T10:00:01.000Z"))
        return {
          entries: yield* fs.readDirectory(paths.transcriptsDir),
          raw: yield* fs.readFileString(path.join(paths.transcriptsDir, "s1.json"))
        }
      }).pipe(Effect.orDie)
    )
    // A leftover `.tmp` means the rename never happened — and a direct overwrite
    // is what leaves a 0-byte transcript when the dev app restarts mid-write.
    expect(entries.filter((e) => e.endsWith(".tmp"))).toStrictEqual([])
    expect(entries).toStrictEqual(["s1.json"])
    expect(raw.length).toBeGreaterThan(0)
  })

  it("never writes over the live transcript — only to a scratch file it renames", async () => {
    // THE regression, asserted on the write MECHANISM rather than by racing a
    // process kill. `writeFileString` truncates its target before writing, and
    // `AgentRunner` rewrites the whole file on nearly every stream event, so
    // killing the main process mid-write (an electron-vite dev restart does
    // exactly that) left a 0-byte transcript and lost the session's history.
    //
    // Racing an interrupt against the write does NOT reproduce it: the interrupt
    // lands either side of the write, never inside the kernel call, so such a
    // test passes against the truncating implementation too — it looks like
    // coverage while asserting nothing. What actually rules the bug out is that
    // the live file is never opened for writing at all; it only ever appears via
    // an atomic rename. That is what this asserts.
    const calls: string[] = []
    const recording = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        writeFileString: (p: string, data: string, opts?: FileSystem.WriteFileStringOptions) => {
          calls.push(`write ${p.split("/").pop()}`)
          return fs.writeFileString(p, data, opts)
        },
        rename: (from: string, to: string) => {
          calls.push(`rename ${from.split("/").pop()} -> ${to.split("/").pop()}`)
          return fs.rename(from, to)
        }
      }))
    ).pipe(Layer.provide(temp.layer))

    await Effect.runPromise(
      TranscriptStore.append("s1", userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")).pipe(
        Effect.provide(
          Layer.mergeAll(TranscriptStore.Default, temp.layer, recording) as Layer.Layer<
            TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths
          >
        )
      )
    )

    expect(calls).toStrictEqual(["write s1.json.tmp", "rename s1.json.tmp -> s1.json"])
    // Stated as its own assertion because it is the whole invariant: the live
    // transcript is never the target of a truncating write.
    expect(calls).not.toContain("write s1.json")
  })

  it("reads a 0-byte transcript as empty instead of failing the session open", async () => {
    // The other half of the historical failure: once a transcript HAD been
    // zeroed, opening the session had to still work. Best-effort reads are why
    // the bug presented as a silently blank pane rather than an error — worth
    // pinning, since it's the behaviour that made the data loss invisible.
    const messages = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const paths = yield* AppPaths
        yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
        yield* fs.writeFileString(path.join(paths.transcriptsDir, "zeroed.json"), "").pipe(Effect.ignore)
        return yield* TranscriptStore.list("zeroed")
      })
    )

    expect(messages).toStrictEqual([])
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
