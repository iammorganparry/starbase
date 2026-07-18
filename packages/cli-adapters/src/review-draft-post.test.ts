import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { planDraftPost } from "./review-post.js"
import { GhService } from "./gh.js"
import { fakeCommandExecutor, runExit } from "./test-support.js"

/**
 * The reviewer's own drafts becoming REAL inline comments on the PR.
 *
 * The thing worth protecting is the all-or-nothing failure mode: GitHub rejects
 * the ENTIRE review when one comment names a line that isn't on the diff's NEW
 * side, so a draft written on a line the agent has since pushed over must fold
 * into the body rather than be sent. Losing one comment's anchor is a nuisance;
 * losing the whole review is the bug.
 */

// Two files. `a.ts` has new-side lines 1-3; `b.ts` has new-side lines 1-2.
const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,3 @@",
  " const one = 1",
  "+const two = 2",
  " const three = 3",
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,2 @@",
  " const x = 1",
  "+const y = 2"
].join("\n")

const draft = (over: Partial<{ path: string; line: number; startLine: number | null; body: string }> = {}) => ({
  path: "a.ts",
  line: 2,
  startLine: null,
  body: "tighten this",
  ...over
})

describe("planDraftPost", () => {
  it("returns null when there are no drafts", () => {
    expect(planDraftPost([], DIFF)).toBeNull()
  })

  it("anchors a single-line draft, leaving startLine off", () => {
    const plan = planDraftPost([draft({ line: 2 })], DIFF)
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 2, startLine: null, body: "tighten this" }
    ])
    expect(plan?.unanchoredCount).toBe(0)
  })

  it("keeps a multi-line range when BOTH ends are on the diff", () => {
    const plan = planDraftPost([draft({ startLine: 1, line: 3 })], DIFF)
    // GitHub anchors at the range END, with start_line above it.
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 3, startLine: 1, body: "tighten this" }
    ])
  })

  it("degrades a half-valid range to a single-line comment rather than 422-ing", () => {
    // startLine 1 is on the diff, line 99 is not — the range end is what GitHub
    // validates most strictly, so fall back to the end we know is good.
    const plan = planDraftPost([draft({ startLine: 1, line: 99 })], DIFF)
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 1, startLine: null, body: "tighten this" }
    ])
    expect(plan?.unanchoredCount).toBe(0)
  })

  it("folds a draft on a line that's no longer in the diff into the body", () => {
    const plan = planDraftPost([draft({ line: 42 })], DIFF)
    expect(plan?.comments).toStrictEqual([])
    expect(plan?.unanchoredCount).toBe(1)
    // The words survive, with the anchor spelled out.
    expect(plan?.body).toContain("a.ts:42")
    expect(plan?.body).toContain("tighten this")
  })

  it("folds a draft on a file outside the diff", () => {
    const plan = planDraftPost([draft({ path: "gone.ts", line: 1 })], DIFF)
    expect(plan?.unanchoredCount).toBe(1)
    expect(plan?.body).toContain("gone.ts:1")
  })

  it("renders an unanchored range as start-end", () => {
    const plan = planDraftPost([draft({ startLine: 40, line: 42 })], DIFF)
    expect(plan?.body).toContain("a.ts:40-42")
  })

  it("posts the anchorable half and folds the rest, in one review", () => {
    const plan = planDraftPost(
      [
        draft({ path: "a.ts", line: 2, body: "keeps its line" }),
        draft({ path: "a.ts", line: 99, body: "moved off the diff" }),
        draft({ path: "b.ts", line: 2, body: "other file" })
      ],
      DIFF
    )
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 2, startLine: null, body: "keeps its line" },
      { path: "b.ts", line: 2, startLine: null, body: "other file" }
    ])
    expect(plan?.unanchoredCount).toBe(1)
    expect(plan?.body).toContain("moved off the diff")
    // The ones that DID anchor must not be duplicated into the body — they'd
    // then read twice on the PR, once inline and once in the summary.
    expect(plan?.body).not.toContain("keeps its line")
  })
})

describe("GhService.prReviewComments payload", () => {
  /** Capture the JSON body fed to `gh api --input -`. */
  const postAndCapture = async (
    comments: ReadonlyArray<{ path: string; line: number; startLine: number | null; body: string }>
  ) => {
    let body: unknown = null
    const exit = await runExit(
      GhService.prReviewComments("/w", 7, { commitSha: "sha1", body: "summary", comments }).pipe(
        Effect.provide(GhService.Default)
      ),
      fakeCommandExecutor((_cmd, args, stdin) => {
        if (args[0] === "api") {
          body = JSON.parse(stdin)
          return { exitCode: 0, stdout: "{}" }
        }
        return undefined
      })
    )
    expect(exit._tag).toBe("Success")
    return body as { commit_id: string; event: string; body: string; comments: ReadonlyArray<Record<string, unknown>> }
  }

  it("posts a COMMENT review anchored to the head sha", async () => {
    const payload = await postAndCapture([{ path: "a.ts", line: 2, startLine: null, body: "c" }])
    expect(payload.commit_id).toBe("sha1")
    // Never REQUEST_CHANGES — a review blocking a PR over a nit gets the
    // reviewer muted.
    expect(payload.event).toBe("COMMENT")
    expect(payload.body).toBe("summary")
  })

  it("OMITS start_line for a single-line comment rather than sending null", async () => {
    const payload = await postAndCapture([{ path: "a.ts", line: 2, startLine: null, body: "c" }])
    // GitHub 422s an explicit `start_line: null`.
    expect(payload.comments[0]).toStrictEqual({ path: "a.ts", line: 2, side: "RIGHT", body: "c" })
    expect(payload.comments[0]).not.toHaveProperty("start_line")
  })

  it("sends start_line + start_side for a real range", async () => {
    const payload = await postAndCapture([{ path: "a.ts", line: 5, startLine: 2, body: "c" }])
    expect(payload.comments[0]).toStrictEqual({
      path: "a.ts",
      line: 5,
      start_line: 2,
      start_side: "RIGHT",
      side: "RIGHT",
      body: "c"
    })
  })

  it("omits start_line when it is not strictly above line", async () => {
    // GitHub rejects a start_line equal to line.
    const payload = await postAndCapture([{ path: "a.ts", line: 3, startLine: 3, body: "c" }])
    expect(payload.comments[0]).not.toHaveProperty("start_line")
  })

  it("degrades to a body-only review when nothing anchored", async () => {
    const payload = await postAndCapture([])
    expect(payload.comments).toStrictEqual([])
    expect(payload.body).toBe("summary")
  })

  it("surfaces a GhError when GitHub rejects the review", async () => {
    const exit = await runExit(
      GhService.prReviewComments("/w", 7, {
        commitSha: "sha1",
        body: "b",
        comments: [{ path: "a.ts", line: 2, startLine: null, body: "c" }]
      }).pipe(Effect.provide(GhService.Default)),
      fakeCommandExecutor((_cmd, args) =>
        args[0] === "api" ? { exitCode: 1, stderr: "HTTP 422: line must be part of the diff" } : undefined
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})
