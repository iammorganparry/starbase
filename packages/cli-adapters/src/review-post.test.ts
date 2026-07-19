import type { AdversarialReview, ReviewFinding, ReviewSeverity } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { planReviewPost } from "./review-post.js"

/**
 * The contract: the minor/nit half reaches the PR, the critical/major half never
 * does (it goes to the agent), and a finding whose line the model got wrong is
 * folded into the body rather than being sent — which would 422 the whole review
 * and lose every other comment with it.
 */

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,5 @@",
  " one", // 1
  "+two", // 2
  "+three", // 3
  " four", // 4
  "+five" // 5
].join("\n")

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "f1",
  path: "src/a.ts",
  line: 2,
  endLine: null,
  severity: "nit" as ReviewSeverity,
  title: "Prefer const",
  rationale: "It never reassigns.",
  suggestion: null,
  resolvedBy: null,
  ...over
})

const review = (findings: ReviewFinding[]): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 7,
  headSha: "abc1234",
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z",
  findings,
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null
})

describe("planReviewPost", () => {
  it("returns null when there is no low-severity finding to post", () => {
    const plan = planReviewPost(
      review([finding({ severity: "critical" }), finding({ id: "f2", severity: "major" })]),
      DIFF
    )
    expect(plan).toBeNull()
  })

  it("never posts the critical/major half — those went to the agent", () => {
    const plan = planReviewPost(
      review([
        finding({ id: "f1", severity: "critical", title: "Data loss" }),
        finding({ id: "f2", severity: "nit", title: "Prefer const" })
      ]),
      DIFF
    )
    expect(plan?.comments).toHaveLength(1)
    expect(plan?.comments[0]?.body).toContain("Prefer const")
    expect(JSON.stringify(plan)).not.toContain("Data loss")
  })

  it("anchors a finding on a line that is in the diff", () => {
    const plan = planReviewPost(review([finding({ line: 3 })]), DIFF)
    expect(plan?.comments).toStrictEqual([
      {
        path: "src/a.ts",
        line: 3,
        startLine: null,
        body: expect.stringContaining("Prefer const")
      }
    ])
    expect(plan?.unanchoredCount).toBe(0)
  })

  /**
   * The whole reason `postableLines` exists. The model reports a line it read off
   * the diff and sometimes gets it wrong; sending it anyway 422s the ENTIRE
   * review, so the other nits vanish too.
   */
  it("folds a finding whose line is not in the diff into the body", () => {
    const plan = planReviewPost(review([finding({ line: 99, title: "Off in space" })]), DIFF)
    expect(plan?.comments).toHaveLength(0)
    expect(plan?.unanchoredCount).toBe(1)
    expect(plan?.body).toContain("Off in space")
    expect(plan?.body).toContain("src/a.ts:99")
  })

  it("folds a finding on a removed line into the body", () => {
    // The diff's only removed content is on the LEFT side; a RIGHT-side comment
    // there is rejected. Line 6 is past the end of the new side entirely.
    const plan = planReviewPost(review([finding({ line: 6 })]), DIFF)
    expect(plan?.comments).toHaveLength(0)
    expect(plan?.unanchoredCount).toBe(1)
  })

  it("folds an unanchored (whole-change) finding into the body", () => {
    const plan = planReviewPost(
      review([finding({ path: null, line: null, title: "No tests anywhere" })]),
      DIFF
    )
    expect(plan?.comments).toHaveLength(0)
    expect(plan?.body).toContain("No tests anywhere")
  })

  it("folds a finding pointing at a file outside the diff into the body", () => {
    const plan = planReviewPost(review([finding({ path: "src/elsewhere.ts", line: 2 })]), DIFF)
    expect(plan?.comments).toHaveLength(0)
    expect(plan?.unanchoredCount).toBe(1)
  })

  /**
   * GitHub anchors a range at its END line with `start_line` above — the inverse
   * of the domain's line/endLine naming. Getting this backwards is a 422.
   */
  it("sends a multi-line range anchored at its end line", () => {
    const plan = planReviewPost(review([finding({ line: 2, endLine: 4 })]), DIFF)
    expect(plan?.comments[0]).toMatchObject({ line: 4, startLine: 2 })
  })

  it("degrades a range whose end is outside the diff to a single-line comment", () => {
    const plan = planReviewPost(review([finding({ line: 2, endLine: 99 })]), DIFF)
    expect(plan?.comments[0]).toMatchObject({ line: 2, startLine: null })
  })

  it("still posts a body-only review when nothing anchored", () => {
    // The words are the valuable part; a line number is a convenience. Returning
    // null here would silently drop findings the user paid for.
    const plan = planReviewPost(review([finding({ path: null, line: null })]), DIFF)
    expect(plan).not.toBeNull()
    expect(plan?.comments).toHaveLength(0)
    expect(plan?.body.length).toBeGreaterThan(0)
  })

  it("carries the suggestion into the comment body", () => {
    const plan = planReviewPost(review([finding({ suggestion: "Use `const`." })]), DIFF)
    expect(plan?.comments[0]?.body).toContain("Use `const`.")
  })

  it("names the reviewer model in the summary", () => {
    const plan = planReviewPost(review([finding()]), DIFF)
    expect(plan?.body).toContain("claude-fable-5")
  })
})
