import type { AdversarialReview, ReviewFinding } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { resolveSentIds } from "./review-routing.js"

/**
 * `resolveSentIds` is the pure seam behind the "Sent to agent" state. It turns
 * the routed store's head-SHA-namespaced keys into plain finding ids for the
 * current review.
 *
 * The namespacing is the whole point: finding ids are POSITIONAL (`f1`, `f2`, …),
 * so they repeat across reviews. Resolve against a bare id and the next review's
 * `f1` renders as already-sent the moment it arrives.
 */

const finding = (id: string): ReviewFinding => ({
  id,
  path: "src/a.ts",
  line: 1,
  endLine: null,
  severity: "major",
  title: `finding ${id}`,
  rationale: "because",
  suggestion: null
})

const review = (headSha: string, ids: string[]): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 1,
  headSha,
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z",
  findings: ids.map(finding),
  note: null
})

describe("resolveSentIds", () => {
  it("is empty when there is no review", () => {
    expect(resolveSentIds(null, new Set(["review:abc:f1"])).size).toBe(0)
  })

  it("is empty when nothing has been routed", () => {
    expect(resolveSentIds(review("abc", ["f1", "f2"]), new Set()).size).toBe(0)
  })

  it("resolves a routed key to the plain finding id the UI compares against", () => {
    const ids = resolveSentIds(review("abc", ["f1", "f2"]), new Set(["review:abc:f1"]))
    // The UI does `sentFindingIds.has(finding.id)` — plain "f1", not the key.
    expect(ids.has("f1")).toBe(true)
    expect(ids.has("f2")).toBe(false)
  })

  // The bug this file exists for: both sets are ReadonlySet<string>, so handing
  // the raw keys to the UI type-checks cleanly and silently never matches.
  it("never returns the namespaced keys themselves", () => {
    const ids = resolveSentIds(review("abc", ["f1"]), new Set(["review:abc:f1"]))
    expect(ids.has("review:abc:f1")).toBe(false)
    expect([...ids]).toStrictEqual(["f1"])
  })

  it("does not carry a previous review's Sent state onto the same positional id", () => {
    // f1 was routed on head "abc"; the branch has since moved to "def".
    const ids = resolveSentIds(review("def", ["f1", "f2"]), new Set(["review:abc:f1"]))
    expect(ids.size).toBe(0)
  })

  it("ignores routed keys for findings not in this review", () => {
    const ids = resolveSentIds(review("abc", ["f1"]), new Set(["review:abc:f9"]))
    expect(ids.size).toBe(0)
  })

  it("resolves several routed findings at once", () => {
    const ids = resolveSentIds(
      review("abc", ["f1", "f2", "f3"]),
      new Set(["review:abc:f1", "review:abc:f3"])
    )
    expect([...ids].sort()).toStrictEqual(["f1", "f3"])
  })
})
