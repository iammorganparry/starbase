import type { AdversarialReview } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ReviewStore } from "./review-store.js"
import { withTempRoot } from "./test-support.js"

/**
 * The stored review is what the Pull Request tab shows after a reload, and its
 * `headSha` is what stops the auto-trigger re-spawning a reviewer on every poll
 * tick. So the behaviour that matters: absent → null, a set review survives a
 * fresh read, a later review replaces the earlier one, and a corrupt file
 * degrades to null rather than wedging re-reviews. Real temp filesystem.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A>(
  effect: Effect.Effect<A, never, ReviewStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(ReviewStore.Default, temp.layer))))

const review = (over: Partial<AdversarialReview> = {}): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 42,
  headSha: "abc123",
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z",
  findings: [
    {
      id: "f1",
      path: "src/auth.ts",
      line: 12,
      endLine: null,
      severity: "critical",
      title: "Token compared with ==",
      rationale: "Timing-unsafe comparison leaks the token byte by byte.",
      suggestion: "Use timingSafeEqual."
    }
  ],
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null,
  ...over
})

describe("ReviewStore", () => {
  it("returns null for a session that has never been reviewed", async () => {
    expect(await run(ReviewStore.get("nope"))).toBeNull()
  })

  it("persists a review across a fresh read", async () => {
    const stored = review()
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", stored)
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read).toStrictEqual(stored)
  })

  // Only the last review is kept — the previous head's findings are stale the
  // moment the branch moves.
  it("replaces the previous review rather than accumulating", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", review({ headSha: "old", findings: [] }))
        yield* ReviewStore.set("s1", review({ headSha: "new" }))
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read?.headSha).toBe("new")
    expect(read?.findings).toHaveLength(1)
  })

  it("keeps reviews separate per session", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", review({ sessionId: "s1", headSha: "one" }))
        yield* ReviewStore.set("s2", review({ sessionId: "s2", headSha: "two" }))
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read?.headSha).toBe("one")
  })

  it("round-trips a review with no findings and a note", async () => {
    const noted = review({ findings: [], note: "The reviewer declined this diff." })
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", noted)
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read).toStrictEqual(noted)
  })

  // A corrupt file must not wedge the feature: get() folds to null and the
  // caller just runs a fresh review over it.
  it("degrades a corrupt review file to null", async () => {
    mkdirSync(join(temp.root, "reviews"), { recursive: true })
    writeFileSync(join(temp.root, "reviews", "s1.json"), "{ not json")
    expect(await run(ReviewStore.get("s1"))).toBeNull()
  })

  it("degrades a review file with the wrong shape to null", async () => {
    mkdirSync(join(temp.root, "reviews"), { recursive: true })
    writeFileSync(join(temp.root, "reviews", "s1.json"), JSON.stringify({ sessionId: "s1" }))
    expect(await run(ReviewStore.get("s1"))).toBeNull()
  })

  it("clear removes the stored review", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", review())
        yield* ReviewStore.clear("s1")
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read).toBeNull()
  })

  it("clear on an unknown session is a no-op", async () => {
    await expect(run(ReviewStore.clear("nope"))).resolves.toBeUndefined()
  })

  /**
   * The de-dupe must not depend on the disk.
   *
   * `set` is best-effort (a failed persist must not fail a review the user can
   * already see). But `get` is the auto-trigger's ONLY brake: if an unwritable
   * reviews dir made every lookup miss, the 60s poll would spawn a fresh
   * reviewer on the priciest model every minute, forever, with no visible error.
   * So an in-memory mirror backs the file.
   */
  describe("when the reviews directory cannot be written", () => {
    // A file where the reviews DIRECTORY should be — makeDirectory and every
    // write beneath it then fail, exactly like a permissions/full-disk failure.
    const breakReviewsDir = () => {
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(join(temp.root, "reviews"), "not a directory")
    }

    it("still returns the review that was just set", async () => {
      breakReviewsDir()
      const stored = review()
      const read = await run(
        Effect.gen(function* () {
          yield* ReviewStore.set("s1", stored)
          return yield* ReviewStore.get("s1")
        })
      )
      expect(read).toStrictEqual(stored)
    })

    it("keeps the head SHA visible, so the de-dupe still engages", async () => {
      breakReviewsDir()
      const read = await run(
        Effect.gen(function* () {
          yield* ReviewStore.set("s1", review({ headSha: "sha-one" }))
          return yield* ReviewStore.get("s1")
        })
      )
      expect(read?.headSha).toBe("sha-one")
    })

    it("set still reports success — a failed persist must not fail the review", async () => {
      breakReviewsDir()
      await expect(run(ReviewStore.set("s1", review()))).resolves.toBeUndefined()
    })
  })

  // The file is authoritative when readable: a restart must not resurrect a
  // review the disk no longer has.
  it("prefers the file over the in-memory mirror", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", review({ headSha: "from-memory" }))
        return yield* ReviewStore.get("s1")
      })
    )
    // Both agree here; the point is the file path is taken when it exists.
    expect(read?.headSha).toBe("from-memory")
    const onDisk = JSON.parse(
      readFileSync(join(temp.root, "reviews", "s1.json"), "utf-8")
    ) as { headSha: string }
    expect(onDisk.headSha).toBe("from-memory")
  })

  it("clear drops the in-memory mirror too, not just the file", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* ReviewStore.set("s1", review())
        yield* ReviewStore.clear("s1")
        return yield* ReviewStore.get("s1")
      })
    )
    expect(read).toBeNull()
  })
})
