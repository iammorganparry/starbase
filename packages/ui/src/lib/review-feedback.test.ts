import type { PrFileChange, PrReviewThread, ReviewFinding } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { feedbackCounts } from "./review-feedback.js"

/**
 * The count behind the file list's comment icon, and the predicate behind its
 * filter. What matters: all three sources are counted, a settled thread isn't,
 * and nothing is attributed to a file that has no row to show it on.
 */

const file = (path: string): PrFileChange => ({
  path,
  additions: 1,
  deletions: 0,
  commentCount: 0,
  viewed: false
})

const finding = (path: string | null): ReviewFinding => ({
  id: "f1",
  path,
  line: 1,
  endLine: null,
  severity: "nit",
  title: "t",
  rationale: "r",
  suggestion: null
})

const thread = (path: string, isResolved = false): PrReviewThread => ({
  id: "t1",
  reviewId: null,
  path,
  line: 1,
  startLine: null,
  originalLine: null,
  originalStartLine: null,
  diffHunk: "",
  isResolved,
  isOutdated: false,
  resolvedBy: null,
  comments: []
})

const files = [file("src/a.ts"), file("src/b.ts")]
const empty = { files, findings: [], drafts: [], threads: [] }

describe("feedbackCounts", () => {
  it("reports no feedback for a clean diff", () => {
    const { byPath, any } = feedbackCounts(empty)
    expect(byPath.size).toBe(0)
    expect(any).toBe(false)
  })

  it("counts findings, drafts and threads together on one file", () => {
    const { byPath, any } = feedbackCounts({
      files,
      findings: [finding("src/a.ts")],
      drafts: [{ path: "src/a.ts" }],
      threads: [thread("src/a.ts")]
    })
    expect(byPath.get("src/a.ts")).toBe(3)
    expect(any).toBe(true)
  })

  it("keeps each file's count separate", () => {
    const { byPath } = feedbackCounts({
      files,
      findings: [finding("src/a.ts")],
      drafts: [],
      threads: [thread("src/b.ts"), thread("src/b.ts")]
    })
    expect(byPath.get("src/a.ts")).toBe(1)
    expect(byPath.get("src/b.ts")).toBe(2)
  })

  /**
   * A resolved thread is settled. Counting it would keep the file flagged for
   * attention it no longer needs — and the filter would never empty out, which
   * is the state where it stops being useful.
   */
  it("ignores a resolved thread", () => {
    const { byPath, any } = feedbackCounts({
      ...empty,
      threads: [thread("src/a.ts", true)]
    })
    expect(byPath.size).toBe(0)
    expect(any).toBe(false)
  })

  /**
   * The reviewer is told to go and LOOK at surrounding code before claiming
   * duplication, so it names files outside the diff. Those have no row here —
   * they surface in the view's "general" group. Counting them would inflate a
   * total no row explains.
   */
  it("ignores a finding on a file that is not in the diff", () => {
    const { byPath } = feedbackCounts({ ...empty, findings: [finding("src/elsewhere.ts")] })
    expect(byPath.size).toBe(0)
  })

  it("ignores an unanchored finding", () => {
    const { byPath } = feedbackCounts({ ...empty, findings: [finding(null)] })
    expect(byPath.size).toBe(0)
  })

  it("ignores a thread on a file that is not in the diff", () => {
    const { byPath } = feedbackCounts({ ...empty, threads: [thread("src/elsewhere.ts")] })
    expect(byPath.size).toBe(0)
  })

  it("counts a file with only a draft", () => {
    const { byPath, any } = feedbackCounts({ ...empty, drafts: [{ path: "src/b.ts" }] })
    expect(byPath.get("src/b.ts")).toBe(1)
    expect(any).toBe(true)
  })
})
