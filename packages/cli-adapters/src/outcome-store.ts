import type { Outcome } from "@starbase/core"
import { Outcome as OutcomeSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type OutcomeEnv = FileSystem.FileSystem | Path.Path | AppPaths

/**
 * Scored outcomes, appended per repository at
 * `~/starbase/outcomes/<repoKey>.jsonl`.
 *
 * **Append-only JSONL, never a rewritten array.** A learning corpus only grows,
 * and read-modify-write over a growing file means a crash mid-write can lose
 * every outcome recorded so far — the whole history, to save one record. One
 * line per outcome means a torn write costs at most the line being appended, and
 * a corrupt line is skipped on read rather than poisoning the file.
 *
 * **An in-memory mirror backs the file, and is authoritative when the file is
 * unreadable.** This is `ReviewStore`'s scar tissue: reads that always miss turn
 * a polling caller into a runaway. The learning daemon polls, and its
 * already-harvested set is derived from what's here — so an unwritable
 * `~/starbase` would otherwise make it re-harvest and re-append the same session
 * every tick, forever, growing the file it cannot read.
 *
 * Writes are best-effort. Nothing here may ever fail a run: the operator asked
 * for a coding agent, not a telemetry pipeline.
 */
export class OutcomeStore extends Effect.Service<OutcomeStore>()("@starbase/OutcomeStore", {
  accessors: true,
  effect: Effect.gen(function* () {
    /** repoKey → outcomes. Survives an unreadable disk; see the class doc. */
    const memory = yield* Ref.make(new Map<string, ReadonlyArray<Outcome>>())

    const fileFor = (repoKey: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const paths = yield* AppPaths
        return path.join(paths.outcomesDir, `${repoKey}.jsonl`)
      })

    /**
     * Parse a JSONL body, skipping lines that no longer decode.
     *
     * A record written by an older build must not make the whole corpus
     * unreadable — losing one outcome is a rounding error, losing the file is
     * losing the repo's entire history.
     */
    const parse = (raw: string): ReadonlyArray<Outcome> =>
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .flatMap((line) => {
          const decoded = Schema.decodeUnknownEither(Schema.parseJson(OutcomeSchema))(line)
          return decoded._tag === "Right" ? [decoded.right] : []
        })

    const list = (repoKey: string): Effect.Effect<ReadonlyArray<Outcome>, never, OutcomeEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileFor(repoKey)
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
        if (raw === null) return (yield* Ref.get(memory)).get(repoKey) ?? []
        const parsed = parse(raw)
        // Keep the mirror aligned with disk, so a later unreadable read has
        // something current to fall back to rather than a stale snapshot.
        yield* Ref.update(memory, (m) => new Map(m).set(repoKey, parsed))
        return parsed
      })

    const append = (outcome: Outcome): Effect.Effect<void, never, OutcomeEnv> =>
      Effect.gen(function* () {
        // Memory FIRST and unconditionally: the de-dupe the daemon relies on must
        // not depend on a write that can fail.
        yield* Ref.update(memory, (m) => {
          const existing = m.get(outcome.repoKey) ?? []
          return new Map(m).set(outcome.repoKey, [...existing, outcome])
        })
        const fs = yield* FileSystem.FileSystem
        const paths = yield* AppPaths
        const file = yield* fileFor(outcome.repoKey)
        const encoded = yield* Schema.encode(OutcomeSchema)(outcome).pipe(
          Effect.orElseSucceed(() => null)
        )
        if (encoded === null) return
        yield* fs.makeDirectory(paths.outcomesDir, { recursive: true }).pipe(Effect.ignore)
        yield* fs
          .writeFileString(file, `${JSON.stringify(encoded)}\n`, { flag: "a" })
          .pipe(Effect.ignore)
      })

    /**
     * The session ids already recorded for a repo — the daemon's de-dupe.
     *
     * Derived from outcome ids rather than a separate ledger, so there is
     * exactly one source of truth about what has been harvested. A second
     * ledger would be one more thing to fall out of sync, and its failure mode
     * is the re-harvest loop above.
     */
    const harvested = (repoKey: string): Effect.Effect<ReadonlySet<string>, never, OutcomeEnv> =>
      Effect.map(list(repoKey), (outcomes) => new Set(outcomes.map((o) => o.id)))

    /** Remove every outcome for a repo — the purge the settings pane offers. */
    const clear = (repoKey: string): Effect.Effect<void, never, OutcomeEnv> =>
      Effect.gen(function* () {
        yield* Ref.update(memory, (m) => {
          const next = new Map(m)
          next.delete(repoKey)
          return next
        })
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileFor(repoKey)
        yield* fs.remove(file).pipe(Effect.ignore)
      })

    /** Every repo with recorded outcomes, for the "what I've learned" table. */
    const repos = (): Effect.Effect<ReadonlyArray<string>, never, OutcomeEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* AppPaths
        const entries = yield* fs
          .readDirectory(paths.outcomesDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
        const onDisk = entries.filter((e) => e.endsWith(".jsonl")).map((e) => e.slice(0, -6))
        const inMemory = [...(yield* Ref.get(memory)).keys()]
        return [...new Set([...onDisk, ...inMemory])].sort()
      })

    return { list, append, harvested, clear, repos, fileFor }
  })
}) {}
