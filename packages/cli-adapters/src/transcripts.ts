import type { Message } from "@starbase/core"
import { Message as MessageSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

const MessageArray = Schema.Array(MessageSchema)

type TranscriptEnv = FileSystem.FileSystem | Path.Path | AppPaths

/**
 * Per-session conversation transcript, persisted to
 * `~/starbase/transcripts/<sessionId>.json`. Reads are best-effort (a missing or
 * malformed file yields an empty transcript so the session still opens), matching
 * `SessionStore`. `AgentRunner` writes here as it folds stream events, so
 * reopening a session shows its full history — the same `Message[]` the renderer
 * rendered live.
 */
export class TranscriptStore extends Effect.Service<TranscriptStore>()(
  "@starbase/TranscriptStore",
  {
    accessors: true,
    sync: () => {
      const fileFor = (
        sessionId: string
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.transcriptsDir, `${sessionId}.json`)
        })

      const readAll = (
        sessionId: string
      ): Effect.Effect<ReadonlyArray<Message>, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(sessionId)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return []
          return yield* Schema.decodeUnknown(Schema.parseJson(MessageArray))(raw).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
        })

      const writeAll = (
        sessionId: string,
        messages: ReadonlyArray<Message>
      ): Effect.Effect<void, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = yield* fileFor(sessionId)
          yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
          const encoded = yield* Schema.encode(MessageArray)(messages).pipe(
            Effect.orElseSucceed(() => messages)
          )
          yield* fs
            .writeFileString(file, JSON.stringify(encoded, null, 2))
            .pipe(Effect.ignore)
        })

      const list = (sessionId: string) => readAll(sessionId)

      /** Append a message to the end of the transcript. */
      const append = (sessionId: string, message: Message) =>
        Effect.gen(function* () {
          const existing = yield* readAll(sessionId)
          yield* writeAll(sessionId, [...existing, message])
        })

      /** Replace the last message via `fn` (a no-op when the transcript is empty). */
      const patchLast = (sessionId: string, fn: (last: Message) => Message) =>
        Effect.gen(function* () {
          const existing = yield* readAll(sessionId)
          if (existing.length === 0) return
          const next = [...existing.slice(0, -1), fn(existing[existing.length - 1]!)]
          yield* writeAll(sessionId, next)
        })

      return { list, append, patchLast }
    }
  }
) {}
