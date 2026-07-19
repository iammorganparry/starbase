import type { AdversarialReview, ReviewFinding } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { agentBatchPrompt, resolveSentIds, reviewQueryKey } from "./review-routing.js"

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
  suggestion: null,
  resolvedBy: null
})

const review = (
  headSha: string,
  ids: string[],
  over: Partial<AdversarialReview> = {}
): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 1,
  headSha,
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z",
  findings: ids.map(finding),
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null,
  ...over
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

/**
 * The batch prompt is what an agent acts on with nobody watching, so the
 * behaviour that matters is: every finding survives into it, and the instruction
 * to push back survives with them. The reviewer is prompted to argue against the
 * diff and report even what it doubts — without the push-back clause an agent
 * would "fix" correct code on a false positive, unsupervised.
 */
describe("agentBatchPrompt", () => {
  const at = (over: Partial<ReviewFinding>): ReviewFinding => ({ ...finding("f1"), ...over })

  it("carries every finding's title, rationale and location", () => {
    const prompt = agentBatchPrompt([
      at({ id: "f1", title: "Token compared with ==", rationale: "Timing-unsafe.", path: "src/a.ts", line: 12 }),
      at({ id: "f2", title: "Unhandled rejection", rationale: "Crashes the run.", path: "src/b.ts", line: 3 })
    ])
    expect(prompt).toContain("Token compared with ==")
    expect(prompt).toContain("Timing-unsafe.")
    expect(prompt).toContain("src/a.ts:12")
    expect(prompt).toContain("Unhandled rejection")
    expect(prompt).toContain("src/b.ts:3")
  })

  it("tells the agent to push back rather than change correct code", () => {
    const prompt = agentBatchPrompt([at({})])
    expect(prompt).toContain("say why rather than changing the code")
  })

  it("counts the findings, in the plural or not", () => {
    expect(agentBatchPrompt([at({})])).toContain("raised 1 issue it rated")
    expect(agentBatchPrompt([at({ id: "f1" }), at({ id: "f2" })])).toContain("raised 2 issues it rated")
  })

  it("includes a suggestion when the reviewer gave one, and omits it otherwise", () => {
    expect(agentBatchPrompt([at({ suggestion: "Use timingSafeEqual." })])).toContain(
      "Suggested fix: Use timingSafeEqual."
    )
    expect(agentBatchPrompt([at({ suggestion: null })])).not.toContain("Suggested fix:")
  })

  it("renders a finding with no file anchor without inventing one", () => {
    const prompt = agentBatchPrompt([at({ path: null, line: null, title: "No tests" })])
    expect(prompt).toContain("No tests")
    expect(prompt).not.toContain("null")
  })

  it("renders a multi-line range as a range", () => {
    expect(agentBatchPrompt([at({ path: "src/a.ts", line: 10, endLine: 14 })])).toContain(
      "src/a.ts:10–14"
    )
  })

  it("numbers the findings so the agent can refer to them", () => {
    const prompt = agentBatchPrompt([at({ id: "f1", title: "First" }), at({ id: "f2", title: "Second" })])
    expect(prompt).toContain("1. [major] `src/a.ts:1` — First")
    expect(prompt).toContain("2. [major] `src/a.ts:1` — Second")
  })
})

/**
 * Three call sites must agree on this key: the useQuery that READS a review, and
 * two setQueryData calls that WRITE one (the auto-review poll's result, and the
 * routed stamp). A mismatch is silent — react-query treats a write to an unread
 * key as a no-op — and surfaces only as a card stuck on "Sending…" while routing
 * re-fires every poll tick. One definition, pinned here.
 */
describe("reviewQueryKey", () => {
  it("is namespaced per session", () => {
    expect(reviewQueryKey("s1")).toStrictEqual(["review", "s1"])
    expect(reviewQueryKey("s2")).not.toStrictEqual(reviewQueryKey("s1"))
  })
})
