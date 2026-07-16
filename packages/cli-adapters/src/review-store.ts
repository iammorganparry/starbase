import type { AdversarialReview } from "@starbase/core"
import { AdversarialReview as AdversarialReviewSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type ReviewEnv = FileSystem.FileSystem | Path.Path | AppPaths

/**
 * The last adversarial review per session, persisted to
 * `~/starbase/reviews/<sessionId>.json`. Mirrors `TranscriptStore`: reads are
 * best-effort, so a missing or malformed file yields `null` rather than failing
 * the Pull Request tab.
 *
 * Only the LAST review is kept — a review is a snapshot of one PR head, and the
 * previous head's findings are stale by definition once the branch moves. The
 * stored `headSha` is what makes the auto-review de-dupe work (see the
 * `Review.run` handler): same head → return this, spawn nothing.
 *
 * **The de-dupe deliberately does not depend on the disk.** Writes are
 * best-effort (a failed persist must not fail a review the user can already
 * see), but if `get` could only read the file, an unwritable `~/starbase/reviews`
 * would make every lookup miss — and the auto-trigger, which polls on a timer,
 * would then spawn a fresh reviewer on the priciest model every 60 seconds,
 * forever, with no user-visible error. So an in-memory mirror backs the file and
 * is authoritative when the file is absent or unreadable.
 */
export class ReviewStore extends Effect.Service<ReviewStore>()("@starbase/ReviewStore", {
  accessors: true,
  effect: Effect.gen(function* () {
    // Survives a failed/unreadable write; lost on restart (when a re-review is
    // the correct behaviour anyway).
    const memory = yield* Ref.make(new Map<string, AdversarialReview>())

    const fileFor = (sessionId: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const paths = yield* AppPaths
        return path.join(paths.reviewsDir, `${sessionId}.json`)
      })

    /** The review on disk for `sessionId`, or null when absent/unreadable. */
    const readFile = (
      sessionId: string
    ): Effect.Effect<AdversarialReview | null, never, ReviewEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileFor(sessionId)
        const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return null
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
        if (raw.trim().length === 0) return null
        return yield* Schema.decodeUnknown(Schema.parseJson(AdversarialReviewSchema))(raw).pipe(
          Effect.map((r): AdversarialReview | null => r),
          // A malformed review must never block a re-review: fold to null and the
          // caller simply runs a fresh one.
          Effect.orElseSucceed(() => null)
        )
      })

    /**
     * The stored review for `sessionId`, or null when there is none.
     *
     * Falls back to the in-memory mirror when the file is missing or unreadable —
     * see the class doc: without this, an unwritable reviews dir turns the
     * auto-trigger into a reviewer-per-minute loop.
     */
    const get = (
      sessionId: string
    ): Effect.Effect<AdversarialReview | null, never, ReviewEnv> =>
      Effect.gen(function* () {
        const onDisk = yield* readFile(sessionId)
        if (onDisk !== null) return onDisk
        return (yield* Ref.get(memory)).get(sessionId) ?? null
      })

    /**
     * Replace the stored review for `sessionId`. The memory mirror is updated
     * first and unconditionally: it is the de-dupe's backstop, so it must hold
     * even when the disk write fails.
     */
    const set = (
      sessionId: string,
      review: AdversarialReview
    ): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        yield* Ref.update(memory, (m) => new Map(m).set(sessionId, review))
        const fs = yield* FileSystem.FileSystem
        const paths = yield* AppPaths
        const file = yield* fileFor(sessionId)
        yield* fs.makeDirectory(paths.reviewsDir, { recursive: true }).pipe(Effect.ignore)
        const encoded = yield* Schema.encode(AdversarialReviewSchema)(review).pipe(
          Effect.orElseSucceed(() => review)
        )
        yield* fs.writeFileString(file, JSON.stringify(encoded, null, 2)).pipe(Effect.ignore)
      })

    /** Drop the stored review (e.g. when a session is deleted). */
    const clear = (sessionId: string): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        yield* Ref.update(memory, (m) => {
          const next = new Map(m)
          next.delete(sessionId)
          return next
        })
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileFor(sessionId)
        yield* fs.remove(file).pipe(Effect.ignore)
      })

    return { get, set, clear }
  })
}) {}
