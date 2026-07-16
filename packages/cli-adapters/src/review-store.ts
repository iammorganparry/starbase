import type { AdversarialReview, StreamEvent } from "@starbase/core"
import { AdversarialReview as AdversarialReviewSchema, StreamEvent as StreamEventSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type ReviewEnv = FileSystem.FileSystem | Path.Path | AppPaths

const Transcript = Schema.Array(StreamEventSchema)

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

    const transcriptFileFor = (
      sessionId: string
    ): Effect.Effect<string, never, Path.Path | AppPaths> =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const paths = yield* AppPaths
        return path.join(paths.reviewsDir, `${sessionId}.transcript.json`)
      })

    /**
     * The reviewer's own event stream for the last COMPLETED review, so its tab
     * survives a restart instead of vanishing while its findings remain.
     *
     * Kept in a separate file from the review itself, deliberately: the review is
     * the verdict and is read constantly (the auto-review poll hits `get` for
     * every session on a timer), while this is a bulky write-once artefact that
     * only the tab reads. Folding it into `AdversarialReview` would put a
     * transcript on the wire every poll.
     *
     * No memory mirror, unlike `get`: nothing depends on this being readable —
     * a failed write costs you a tab after restart, not a re-review loop.
     */
    const getTranscript = (
      sessionId: string
    ): Effect.Effect<ReadonlyArray<StreamEvent>, never, ReviewEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* transcriptFileFor(sessionId)
        const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return []
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
        if (raw.trim().length === 0) return []
        return yield* Schema.decodeUnknown(Schema.parseJson(Transcript))(raw).pipe(
          Effect.map((events): ReadonlyArray<StreamEvent> => events),
          // A malformed transcript is a cosmetic loss — fall back to no tab
          // rather than failing the watch that every session opens.
          Effect.orElseSucceed(() => [] as ReadonlyArray<StreamEvent>)
        )
      })

    /** Persist a finished reviewer's events. Best-effort, like `set`. */
    const setTranscript = (
      sessionId: string,
      events: ReadonlyArray<StreamEvent>
    ): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* AppPaths
        const file = yield* transcriptFileFor(sessionId)
        yield* fs.makeDirectory(paths.reviewsDir, { recursive: true }).pipe(Effect.ignore)
        const encoded = yield* Schema.encode(Transcript)(events).pipe(Effect.orElseSucceed(() => null))
        if (encoded === null) return
        yield* fs.writeFileString(file, JSON.stringify(encoded)).pipe(Effect.ignore)
      })

    /** Drop the stored transcript (a new run supersedes it). */
    const clearTranscript = (sessionId: string): Effect.Effect<void, never, ReviewEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* transcriptFileFor(sessionId)
        yield* fs.remove(file).pipe(Effect.ignore)
      })

    /** Drop the stored review AND its transcript (e.g. when a session is deleted). */
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
        yield* clearTranscript(sessionId)
      })

    return { get, set, clear, getTranscript, setTranscript, clearTranscript }
  })
}) {}
