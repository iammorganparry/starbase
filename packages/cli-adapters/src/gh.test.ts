import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  GhService,
  mapIssueSummary,
  mapPrSummary,
  mapPrView,
  mapReviewThreads,
  unifiedDiffFromApiFiles
} from "./gh.js"
import { failureOf, fakeCommandExecutor, runExit } from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * GhService parses `gh`'s output into a status the UI chip renders. `gh` may be
 * absent or unauthenticated in CI, so we drive it with canned command output and
 * assert the parsed outcome (available / authenticated / login / host / version).
 */
const GH = "/usr/local/bin/gh"

const AUTHED_OUTPUT = [
  "github.com",
  "  ✓ Logged in to github.com account octocat (keyring)",
  "  - Active account: true",
  "  - Git operations protocol: https"
].join("\n")

const run = (handler: FakeCommandHandler) =>
  runExit(GhService.status().pipe(Effect.provide(GhService.Default)), fakeCommandExecutor(handler))

describe("GhService.status", () => {
  it("reports unavailable when gh is not on PATH", async () => {
    const exit = await run((command) => (command === "which" ? { stdout: "" } : undefined))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.available).toBe(false)
      expect(exit.value.authenticated).toBe(false)
    }
  })

  it("reports authenticated with parsed login/host/version when gh auth exits 0", async () => {
    const exit = await run((command, args) => {
      if (command === "which") return { stdout: GH }
      if (args.includes("--version")) return { stdout: "gh version 2.68.1 (2024-11-27)" }
      if (args[0] === "auth") return { exitCode: 0, stdout: AUTHED_OUTPUT }
      return undefined
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toMatchObject({
      available: true,
      authenticated: true,
      login: "octocat",
      host: "github.com",
      version: "2.68.1"
    })
  })

  it("reports available-but-unauthenticated when gh auth exits non-zero", async () => {
    const exit = await run((command, args) => {
      if (command === "which") return { stdout: GH }
      if (args.includes("--version")) return { stdout: "gh version 2.68.1 (2024-11-27)" }
      if (args[0] === "auth") return { exitCode: 1, stderr: "You are not logged into any GitHub hosts." }
      return undefined
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toMatchObject({
      available: true,
      authenticated: false,
      login: null,
      version: "2.68.1"
    })
  })
})

// A realistic `gh pr view --json …` payload (fields as gh emits them).
const RAW_PR = {
  state: "OPEN",
  number: 482,
  title: "Add token store + refresh handling",
  body: "Adds a token store.",
  headRefName: "feat/oauth",
  baseRefName: "main",
  isDraft: false,
  commits: [{}, {}, {}, {}, {}, {}],
  files: [
    { path: "src/a.ts", additions: 8, deletions: 3 },
    { path: "src/b.ts", additions: 120, deletions: 29 }
  ],
  additions: 128,
  deletions: 32,
  author: { login: "claude-agent" },
  createdAt: "2026-07-11T10:00:00Z",
  labels: [{ name: "auth", color: "c678dd" }],
  reviews: [
    { id: "r1", author: { login: "dan" }, state: "CHANGES_REQUESTED", body: "Add a 401 retry.", submittedAt: "2026-07-11T11:00:00Z" }
  ],
  comments: [{ id: "c1", author: { login: "eve" }, body: "Looks close.", createdAt: "2026-07-11T12:00:00Z" }],
  reviewRequests: [{ login: "you" }],
  statusCheckRollup: [
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-07-11T10:00:00Z", completedAt: "2026-07-11T10:01:12Z" },
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/lint" },
    { name: "e2e", status: "IN_PROGRESS" }
  ],
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  url: "https://github.com/acme/x/pull/482"
}

describe("mapPrView", () => {
  it("maps a raw gh payload, synthesizing counts, checks and merge blockers", () => {
    const pr = mapPrView(RAW_PR)
    expect(pr.number).toBe(482)
    expect(pr.state).toBe("open")
    expect(pr.commits).toBe(6)
    expect(pr.changedFiles).toBe(2)
    expect(pr.author.login).toBe("claude-agent")
    // Reviewers: dan reviewed (changes requested), you is still requested (pending).
    expect(pr.reviewers).toEqual(
      expect.arrayContaining([
        { login: "dan", state: "changes_requested" },
        { login: "you", state: "pending" }
      ])
    )
    // Timeline: substantive review + issue comment, chronological.
    expect(pr.timeline.map((t) => [t.author, t.kind])).toStrictEqual([
      ["dan", "changes_requested"],
      ["eve", "commented"]
    ])
    // CI buckets → normalized status; duration derived from timestamps.
    expect(pr.checks.map((c) => [c.name, c.status])).toStrictEqual([
      ["build", "pass"],
      ["lint", "fail"],
      ["e2e", "running"]
    ])
    expect(pr.checks[0]?.durationMs).toBe(72_000)
    expect(pr.mergeBlockers).toEqual(
      expect.arrayContaining(["Blocked by branch protection", "1 failing check", "1 change request"])
    )
  })

  it("synthesizes the draft state and tolerates a sparse payload", () => {
    const pr = mapPrView({ state: "OPEN", number: 7, isDraft: true, url: "u" })
    expect(pr.state).toBe("draft")
    expect(pr.commits).toBe(0)
    expect(pr.reviewers).toStrictEqual([])
    expect(pr.checks).toStrictEqual([])
    expect(pr.mergeBlockers).toStrictEqual([])
  })

  it("maps MERGED and CLOSED states", () => {
    expect(mapPrView({ state: "MERGED", number: 1, url: "u" }).state).toBe("merged")
    expect(mapPrView({ state: "CLOSED", number: 1, url: "u" }).state).toBe("closed")
  })
})

/**
 * Trimmed from the real `reviewThreads` payload for starbase#36 — the PR whose
 * Greptile review the thread UI was built against. The first thread is outdated
 * (so GitHub nulls `line`/`startLine`), bot-authored, and answered by the repo
 * owner with a reaction; that combination covers every branch of the mapper.
 */
const RAW_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_kwDOTVMKJc6RFyZM",
              isResolved: true,
              isOutdated: true,
              path: "apps/desktop/src/renderer/conversation-pane.tsx",
              line: null,
              startLine: null,
              originalLine: 38,
              originalStartLine: 31,
              resolvedBy: { login: "greptile-apps[bot]" },
              comments: {
                nodes: [
                  {
                    id: "PRRC_kwDOTVMKJc7Vz61q",
                    databaseId: 3587157354,
                    body: "Prefilled draft lost when user navigates to the Issue tab",
                    createdAt: "2026-07-15T20:15:10Z",
                    diffHunk: "@@ -27,9 +28,19 @@\n   const convo = useConversation(session)",
                    authorAssociation: "NONE",
                    author: {
                      login: "greptile-apps",
                      avatarUrl: "https://avatars.githubusercontent.com/in/867647?v=4",
                      __typename: "Bot"
                    },
                    pullRequestReview: { id: "PRR_kwDOTVMKJc8AAAABGGEaWw" },
                    reactionGroups: [
                      { content: "THUMBS_UP", reactors: { totalCount: 0 } },
                      { content: "HEART", reactors: { totalCount: 0 } }
                    ]
                  },
                  {
                    id: "PRRC_kwDOTVMKJc7WKg6W",
                    databaseId: 3593080470,
                    body: "Addressed in 1f8653e",
                    createdAt: "2026-07-16T08:02:41Z",
                    diffHunk: "@@ -27,9 +28,19 @@\n   const convo = useConversation(session)",
                    authorAssociation: "OWNER",
                    author: {
                      login: "iammorganparry",
                      avatarUrl: "https://avatars.githubusercontent.com/u/2838620?v=4",
                      __typename: "User"
                    },
                    pullRequestReview: { id: "PRR_kwDOTVMKJc8AAAABGGEaWw" },
                    reactionGroups: [{ content: "THUMBS_UP", reactors: { totalCount: 1 } }]
                  }
                ]
              }
            }
          ]
        }
      }
    }
  }
}

describe("mapReviewThreads", () => {
  it("maps a thread, its anchor, resolution state and owning review", () => {
    const [thread] = mapReviewThreads(RAW_THREADS)
    expect(thread).toMatchObject({
      id: "PRRT_kwDOTVMKJc6RFyZM",
      reviewId: "PRR_kwDOTVMKJc8AAAABGGEaWw",
      path: "apps/desktop/src/renderer/conversation-pane.tsx",
      isResolved: true,
      isOutdated: true,
      resolvedBy: "greptile-apps[bot]",
      diffHunk: "@@ -27,9 +28,19 @@\n   const convo = useConversation(session)"
    })
    // GitHub nulls the live anchor once a thread is outdated; the original
    // anchor is what the "Comment on lines +31 to +38" caption falls back to.
    expect(thread).toMatchObject({
      line: null,
      startLine: null,
      originalLine: 38,
      originalStartLine: 31
    })
  })

  it("flags bots by __typename, not authorAssociation (bots report NONE)", () => {
    const [thread] = mapReviewThreads(RAW_THREADS)
    expect(thread?.comments[0]).toMatchObject({
      author: "greptile-apps",
      isBot: true,
      association: "NONE",
      databaseId: 3587157354,
      authorAvatarUrl: "https://avatars.githubusercontent.com/in/867647?v=4"
    })
    expect(thread?.comments[1]).toMatchObject({ author: "iammorganparry", isBot: false, association: "OWNER" })
  })

  it("folds an unknown or absent authorAssociation to null rather than throwing", () => {
    const withAssoc = (authorAssociation: unknown) => {
      const base = structuredClone(RAW_THREADS)
      Object.assign(base.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!, {
        authorAssociation
      })
      return mapReviewThreads(base)[0]?.comments[0]?.association
    }
    // A value from a future API revision must degrade, not blow up the tab.
    expect(withAssoc("SOMETHING_NEW")).toBeNull()
    expect(withAssoc(undefined)).toBeNull()
    expect(withAssoc(null)).toBeNull()
    expect(withAssoc(42)).toBeNull()
    // …and a real one still decodes, case-insensitively.
    expect(withAssoc("owner")).toBe("OWNER")
  })

  it("keeps only reactions anyone actually used", () => {
    const [thread] = mapReviewThreads(RAW_THREADS)
    expect(thread?.comments[0]?.reactions).toStrictEqual([])
    expect(thread?.comments[1]?.reactions).toStrictEqual([{ content: "THUMBS_UP", count: 1 }])
  })

  it("drops comment-less threads and tolerates a null / sparse payload", () => {
    expect(mapReviewThreads(null)).toStrictEqual([])
    expect(mapReviewThreads({})).toStrictEqual([])
    const empty = {
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [{ id: "t1", path: "a.ts", comments: { nodes: [] } }] } }
        }
      }
    }
    expect(mapReviewThreads(empty)).toStrictEqual([])
  })
})

const providePr = <A, E>(
  effect: Effect.Effect<A, E, GhService | CommandExecutor.CommandExecutor>,
  handler: FakeCommandHandler
) => runExit(effect.pipe(Effect.provide(GhService.Default)), fakeCommandExecutor(handler))

describe("GhService pull-request reads", () => {
  it("prForBranch parses the PR number, or null when there is none", async () => {
    const hit = await providePr(GhService.prForBranch("/wt", "feat/oauth"), (cmd, args) =>
      cmd === "gh" && args[0] === "pr" && args[1] === "list" ? { stdout: '[{"number":482}]' } : undefined
    )
    expect(hit._tag === "Success" && hit.value).toBe(482)

    const miss = await providePr(GhService.prForBranch("/wt", "feat/oauth"), () => ({ stdout: "[]" }))
    expect(miss._tag === "Success" && miss.value).toBe(null)

    const bad = await providePr(GhService.prForBranch("/wt", "feat/oauth"), () => ({ stdout: "not json" }))
    expect(bad._tag === "Success" && bad.value).toBe(null)
  })

  it("prForWorktree resolves the current branch's PR via `gh pr view`", async () => {
    const hit = await providePr(GhService.prForWorktree("/wt"), (cmd, args) =>
      cmd === "gh" && args[1] === "view" ? { stdout: '{"number":482}' } : undefined
    )
    expect(hit._tag === "Success" && hit.value).toBe(482)

    const miss = await providePr(GhService.prForWorktree("/wt"), () => ({ exitCode: 1, stderr: "no pr" }))
    expect(miss._tag === "Success" && miss.value).toBe(null)
  })

  it("prState maps MERGED / CLOSED / OPEN and folds anything else to null", async () => {
    const view = (json: Record<string, unknown>): FakeCommandHandler => (cmd, args) =>
      cmd === "gh" && args[1] === "view" ? { stdout: JSON.stringify(json) } : undefined
    const at = async (json: Record<string, unknown>) => {
      const r = await providePr(GhService.prState("/wt", 1), view(json))
      return r._tag === "Success" ? r.value : undefined
    }

    expect(await at({ state: "MERGED" })).toStrictEqual({ state: "merged", checks: null })
    expect(await at({ state: "CLOSED" })).toStrictEqual({ state: "closed", checks: null })
    expect(await at({ state: "OPEN" })).toStrictEqual({ state: "open", checks: null })

    // `state` reports a draft as OPEN, so `isDraft` is the only thing that can
    // tell them apart — and the sidebar glyph draws them differently.
    expect(await at({ state: "OPEN", isDraft: true })).toStrictEqual({ state: "draft", checks: null })

    const bad = await providePr(GhService.prState("/wt", 1), () => ({ stdout: "not json" }))
    expect(bad._tag === "Success" && bad.value).toBe(null)
  })

  it("prState rolls the check run up worst-first", async () => {
    const view = (rollup: ReadonlyArray<Record<string, unknown>>): FakeCommandHandler => (cmd, args) =>
      cmd === "gh" && args[1] === "view"
        ? { stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: rollup }) }
        : undefined
    const checksOf = async (rollup: ReadonlyArray<Record<string, unknown>>) => {
      const r = await providePr(GhService.prState("/wt", 1), view(rollup))
      return r._tag === "Success" && r.value ? r.value.checks : undefined
    }

    const pass = { status: "COMPLETED", conclusion: "SUCCESS" }
    const fail = { status: "COMPLETED", conclusion: "FAILURE" }
    const running = { status: "IN_PROGRESS" }

    expect(await checksOf([pass, pass])).toBe("pass")
    // One failure outranks any number of passes — a green glyph beside a broken
    // build is the one reading that would actively mislead.
    expect(await checksOf([pass, fail, pass])).toBe("fail")
    // Still moving is not yet a pass.
    expect(await checksOf([pass, running])).toBe("running")
    // No CI on this PR at all is a different fact from "queued", and stays null
    // so the glyph doesn't sit amber forever on a repo with no workflows.
    expect(await checksOf([])).toBe(null)
  })

  it("prState reports no checks for a resolved PR", async () => {
    // A merged PR's checks are history: painting a long-merged session red
    // because one flaky job failed on the way in says nothing actionable.
    const handler: FakeCommandHandler = (cmd, args) =>
      cmd === "gh" && args[1] === "view"
        ? {
            stdout: JSON.stringify({
              state: "MERGED",
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }]
            })
          }
        : undefined
    const r = await providePr(GhService.prState("/wt", 1), handler)
    expect(r._tag === "Success" && r.value).toStrictEqual({ state: "merged", checks: null })
  })

  // The head SHA is the adversarial review's de-dupe key: a wrong-but-stable
  // value would silently pin reviews to one commit forever, and a throw would
  // break the PR tab — so it must read the real oid and fold failure to null.
  it("prHeadSha reads headRefOid, folding a failure to null", async () => {
    const ok = await providePr(GhService.prHeadSha("/wt", 482), (cmd, args) =>
      cmd === "gh" && args[1] === "view"
        ? { stdout: JSON.stringify({ headRefOid: "deadbeef123" }) }
        : undefined
    )
    expect(ok._tag === "Success" && ok.value).toBe("deadbeef123")

    const fail = await providePr(GhService.prHeadSha("/wt", 482), () => ({
      exitCode: 1,
      stderr: "no PR"
    }))
    expect(fail._tag === "Success" && fail.value).toBe(null)

    const garbage = await providePr(GhService.prHeadSha("/wt", 482), () => ({ stdout: "not json" }))
    expect(garbage._tag === "Success" && garbage.value).toBe(null)
  })

  it("prView decodes and maps the PR, folding a non-zero exit to null", async () => {
    const ok = await providePr(GhService.prView("/wt", 482), (cmd, args) =>
      cmd === "gh" && args[1] === "view" ? { stdout: JSON.stringify(RAW_PR) } : undefined
    )
    expect(ok._tag).toBe("Success")
    if (ok._tag === "Success") expect(ok.value?.number).toBe(482)

    const fail = await providePr(GhService.prView("/wt", 482), () => ({ exitCode: 1, stderr: "no PR" }))
    expect(fail._tag === "Success" && fail.value).toBe(null)
  })

  it("prView merges inline review threads from the GraphQL call", async () => {
    const res = await providePr(GhService.prView("/wt", 482), (cmd, args) => {
      if (cmd !== "gh") return undefined
      if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify(RAW_THREADS) }
      if (args[1] === "view") return { stdout: JSON.stringify(RAW_PR) }
      return undefined
    })
    expect(res._tag).toBe("Success")
    if (res._tag !== "Success") return
    expect(res.value?.reviewThreads).toHaveLength(1)
    expect(res.value?.reviewThreads[0]?.path).toBe("apps/desktop/src/renderer/conversation-pane.tsx")
    // The threads must NOT also be flattened into the timeline, or every inline
    // comment renders twice.
    expect(res.value?.timeline.some((t) => t.body.includes("Prefilled draft lost"))).toBe(false)
  })

  it("prView degrades to an empty thread list when the GraphQL call fails", async () => {
    const res = await providePr(GhService.prView("/wt", 482), (cmd, args) => {
      if (cmd !== "gh") return undefined
      if (args[0] === "api" && args[1] === "graphql") return { exitCode: 1, stderr: "gone" }
      if (args[1] === "view") return { stdout: JSON.stringify(RAW_PR) }
      return undefined
    })
    expect(res._tag === "Success" && res.value?.number).toBe(482)
    expect(res._tag === "Success" && res.value?.reviewThreads).toStrictEqual([])
  })
})

const RAW_PR_LIST = [
  {
    number: 482,
    title: "Fix auth refresh",
    headRefName: "chore/bump",
    baseRefName: "main",
    author: { login: "octocat" },
    state: "OPEN",
    isDraft: false,
    additions: 31,
    deletions: 4,
    updatedAt: "2026-07-10T12:00:00Z"
  },
  {
    number: 471,
    title: "WIP usage window",
    headRefName: "feat/usage",
    baseRefName: "main",
    author: { login: "hubot" },
    state: "OPEN",
    isDraft: true,
    additions: 12,
    deletions: 0,
    updatedAt: "2026-07-09T09:00:00Z"
  }
]

describe("unifiedDiffFromApiFiles", () => {
  /**
   * The REST `patch` starts bare at `@@` — the renderer slices files on
   * `diff --git` and matches ` b/<path>`, so those headers must be rebuilt.
   */
  it("rebuilds the git headers the renderer slices on", () => {
    const diff = unifiedDiffFromApiFiles([
      { filename: "src/a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n ctx\n+added" }
    ])
    expect(diff).toBe("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx\n+added\n")
  })

  it("marks added / removed against /dev/null, and follows a rename's old path", () => {
    const added = unifiedDiffFromApiFiles([{ filename: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hi" }])
    expect(added).toContain("--- /dev/null")
    expect(added).toContain("+++ b/new.ts")

    const removed = unifiedDiffFromApiFiles([{ filename: "old.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-bye" }])
    expect(removed).toContain("--- a/old.ts")
    expect(removed).toContain("+++ /dev/null")

    const renamed = unifiedDiffFromApiFiles([
      { filename: "to.ts", previous_filename: "from.ts", status: "renamed", patch: "@@ -1 +1 @@\n-a\n+b" }
    ])
    expect(renamed).toContain("diff --git a/from.ts b/to.ts")
    expect(renamed).toContain("--- a/from.ts")
    expect(renamed).toContain("+++ b/to.ts")
  })

  it("keeps a patch-less file (GitHub omits `patch` for oversized/binary) as a header-only entry", () => {
    // Without this the file would vanish from the diff entirely, even though it
    // is in the file list — so the two views would disagree.
    const diff = unifiedDiffFromApiFiles([
      { filename: "yarn.lock", status: "modified" },
      { filename: "src/b.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }
    ])
    expect(diff).toContain("diff --git a/yarn.lock b/yarn.lock")
    expect(diff.match(/^diff --git /gm)).toHaveLength(2)
  })

  it("is empty for no files, and skips entries with no filename", () => {
    expect(unifiedDiffFromApiFiles([])).toBe("")
    expect(unifiedDiffFromApiFiles("not an array")).toBe("")
    expect(unifiedDiffFromApiFiles([{ status: "modified", patch: "@@ -1 +1 @@" }])).toBe("")
  })
})

describe("GhService.prFiles / prDiff on a LARGE pull request", () => {
  // `gh pr view --json files` caps at 100 (GraphQL `files(first: 100)`, unpaginated),
  // which truncated the list AND its totals. prFiles now reads paginated REST.
  const apiFiles = [
    { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" },
    { filename: "src/b.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+x\n+y" }
  ]

  it("prFiles reads the paginated REST endpoint, not the 100-capped `pr view`", async () => {
    let requested: ReadonlyArray<string> = []
    const files = await providePr(GhService.prFiles("/wt", 1609), (cmd, args) => {
      if (cmd !== "gh" || args[0] !== "api") return undefined
      requested = args
      return { stdout: JSON.stringify(apiFiles) }
    })
    expect(files._tag === "Success" && files.value.map((f) => f.path)).toStrictEqual(["src/a.ts", "src/b.ts"])
    expect(requested).toContain("--paginate")
    expect(requested.join(" ")).toContain("repos/{owner}/{repo}/pulls/1609/files")
  })

  it("prDiff falls back to the REST patches when `gh pr diff` refuses (HTTP 406 too_large)", async () => {
    // GitHub refuses a diff past 20k lines. `readStdout` folds that to null just
    // like any other failure, which used to surface as a silently EMPTY diff.
    const diff = await providePr(GhService.prDiff("/wt", 1609), (cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "diff") {
        return { exitCode: 1, stderr: "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" }
      }
      if (cmd === "gh" && args[0] === "api") return { stdout: JSON.stringify(apiFiles) }
      return undefined
    })
    expect(diff._tag).toBe("Success")
    if (diff._tag === "Success") {
      expect(diff.value).toContain("diff --git a/src/a.ts b/src/a.ts")
      expect(diff.value).toContain("diff --git a/src/b.ts b/src/b.ts")
      expect(diff.value).toContain("+++ b/src/b.ts")
    }
  })

  it("prDiff prefers `gh pr diff` when it succeeds, and never falls back on an EMPTY diff", async () => {
    const real = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"
    const ok = await providePr(GhService.prDiff("/wt", 1609), (cmd, args) =>
      cmd === "gh" && args[0] === "pr" && args[1] === "diff" ? { stdout: real } : { stdout: "SHOULD NOT BE CALLED" }
    )
    expect(ok._tag === "Success" && ok.value).toBe(real.trim())

    // "" is a genuinely empty diff (success), NOT a failure — it must not trigger
    // the fallback, or an empty PR would round-trip through a pointless API read.
    let apiCalled = false
    const empty = await providePr(GhService.prDiff("/wt", 1609), (cmd, args) => {
      if (cmd === "gh" && args[0] === "api") apiCalled = true
      return cmd === "gh" && args[0] === "pr" && args[1] === "diff" ? { stdout: "" } : { stdout: "[]" }
    })
    expect(empty._tag === "Success" && empty.value).toBe("")
    expect(apiCalled).toBe(false)
  })
})

describe("mapPrSummary", () => {
  it("maps a raw gh pr list item, synthesizing the draft state", () => {
    const [open, draft] = RAW_PR_LIST.map(mapPrSummary)
    expect(open).toMatchObject({
      number: 482,
      title: "Fix auth refresh",
      headRefName: "chore/bump",
      baseRefName: "main",
      author: { login: "octocat", avatarUrl: null },
      state: "open",
      additions: 31,
      deletions: 4
    })
    // isDraft on an OPEN PR synthesizes state "draft".
    expect(draft?.state).toBe("draft")
  })

  it("tolerates a sparse payload", () => {
    const s = mapPrSummary({ number: 3 })
    expect(s.number).toBe(3)
    expect(s.title).toBe("")
    expect(s.author.login).toBe("unknown")
    expect(s.state).toBe("open")
  })
})

describe("mapIssueSummary", () => {
  it("maps a raw gh issue list item incl. labels + assignees", () => {
    const s = mapIssueSummary({
      number: 128,
      title: "Refund route 500s on a stale token",
      url: "https://github.com/acme/api/issues/128",
      body: "Fix the refund route.",
      labels: [
        { name: "bug", color: "e06c75" },
        { name: "auth", color: "c678dd" }
      ],
      author: { login: "mira" },
      assignees: [{ login: "dan" }],
      updatedAt: "2026-07-15T09:00:00Z"
    })
    expect(s).toMatchObject({
      number: 128,
      title: "Refund route 500s on a stale token",
      url: "https://github.com/acme/api/issues/128",
      body: "Fix the refund route.",
      author: { login: "mira", avatarUrl: null },
      assignees: [{ login: "dan", avatarUrl: null }]
    })
    expect(s.labels).toEqual([
      { name: "bug", color: "e06c75" },
      { name: "auth", color: "c678dd" }
    ])
  })

  it("tolerates a sparse payload", () => {
    const s = mapIssueSummary({ number: 7 })
    expect(s.number).toBe(7)
    expect(s.title).toBe("")
    expect(s.author.login).toBe("unknown")
    expect(s.labels).toEqual([])
    expect(s.assignees).toEqual([])
  })
})

describe("GhService.listPrs", () => {
  it("appends --author @me / --search only when requested, and maps results", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const capturing =
      (stdout: string): FakeCommandHandler =>
      (cmd, args) => {
        if (cmd === "gh") calls.push(args)
        return { stdout }
      }

    const both = await providePr(
      GhService.listPrs("/wt", { mine: true, search: "auth" }),
      capturing(JSON.stringify(RAW_PR_LIST))
    )
    expect(both._tag).toBe("Success")
    if (both._tag === "Success") {
      expect(both.value.map((p) => p.number)).toEqual([482, 471])
    }
    const args = calls[0]!
    expect(args).toContain("--author")
    expect(args).toContain("@me")
    expect(args).toContain("--search")
    expect(args).toContain("auth")
    expect(args).toContain("--state")
    expect(args).toContain("open")

    calls.length = 0
    await providePr(GhService.listPrs("/wt", { mine: false, search: "  " }), capturing("[]"))
    const plain = calls[0]!
    expect(plain).not.toContain("--author")
    expect(plain).not.toContain("--search")
  })

  it("folds malformed JSON to an empty list", async () => {
    const bad = await providePr(GhService.listPrs("/wt", { mine: false, search: "" }), () => ({
      stdout: "not json"
    }))
    expect(bad._tag === "Success" && bad.value).toEqual([])
  })
})

describe("GhService pull-request writes", () => {
  it("checkoutPr fails with GhError on a non-zero exit", async () => {
    const exit = await providePr(GhService.checkoutPr("/wt", 482), (cmd, args) =>
      cmd === "gh" && args[1] === "checkout" ? { exitCode: 1, stderr: "gh: no such PR" } : undefined
    )
    expect(failureOf(exit)?._tag).toBe("GhError")
  })

  it("prCreate parses the number from the created PR url", async () => {
    const exit = await providePr(
      GhService.prCreate("/wt", { title: "T", body: "B", base: "main", draft: false }),
      (cmd, args) =>
        cmd === "gh" && args[1] === "create"
          ? { stdout: "https://github.com/acme/x/pull/512" }
          : undefined
    )
    expect(exit._tag === "Success" && exit.value).toBe(512)
  })

  it("prComment / prReview fail with GhError on a non-zero exit", async () => {
    const comment = await providePr(GhService.prComment("/wt", 482, "hi"), () => ({
      exitCode: 1,
      stderr: "gh: not authenticated"
    }))
    expect(failureOf(comment)?._tag).toBe("GhError")

    const review = await providePr(GhService.prReview("/wt", 482, "approve", ""), () => ({
      exitCode: 1,
      stderr: "gh: forbidden"
    }))
    expect(failureOf(review)?._tag).toBe("GhError")
  })

  it("prMerge passes an explicit strategy flag (merge commit by default)", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const capture: FakeCommandHandler = (cmd, args) => {
      if (cmd === "gh") calls.push(args)
      return { stdout: "" }
    }

    await providePr(GhService.prMerge("/wt", 482), capture)
    expect(calls[0]).toEqual(["pr", "merge", "482", "--merge"])

    calls.length = 0
    await providePr(GhService.prMerge("/wt", 482, "squash"), capture)
    expect(calls[0]).toEqual(["pr", "merge", "482", "--squash"])
  })

  it("prMerge fails with GhError on a non-zero exit", async () => {
    const merge = await providePr(GhService.prMerge("/wt", 482), () => ({
      exitCode: 1,
      stderr: "gh: not mergeable"
    }))
    expect(failureOf(merge)?._tag).toBe("GhError")
  })

  it("resolveThread picks the resolve vs unresolve mutation", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const capture: FakeCommandHandler = (cmd, args) => {
      if (cmd === "gh") calls.push(args)
      return { stdout: "{}" }
    }

    await providePr(GhService.resolveThread("/wt", "PRRT_abc", true), capture)
    expect(calls[0]?.slice(0, 4)).toEqual(["api", "graphql", "-F", "id=PRRT_abc"])
    expect(calls[0]?.at(-1)).toContain("resolveReviewThread")

    calls.length = 0
    await providePr(GhService.resolveThread("/wt", "PRRT_abc", false), capture)
    expect(calls[0]?.at(-1)).toContain("unresolveReviewThread")
  })

  it("replyToThread POSTs to the REST replies endpoint keyed by the comment's databaseId", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    await providePr(GhService.replyToThread("/wt", 482, 3587157354, "ack"), (cmd, args) => {
      if (cmd === "gh") calls.push(args)
      return { stdout: "{}" }
    })
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls/482/comments/3587157354/replies",
      "-f",
      "body=ack"
    ])
  })

  it("resolveThread / replyToThread fail with GhError on a non-zero exit", async () => {
    const resolve = await providePr(GhService.resolveThread("/wt", "PRRT_abc", true), () => ({
      exitCode: 1,
      stderr: "gh: forbidden"
    }))
    expect(failureOf(resolve)?._tag).toBe("GhError")

    const reply = await providePr(GhService.replyToThread("/wt", 482, 1, "hi"), () => ({
      exitCode: 1,
      stderr: "gh: gone"
    }))
    expect(failureOf(reply)?._tag).toBe("GhError")
  })

  it("prReady passes the ready subcommand", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const capture: FakeCommandHandler = (cmd, args) => {
      if (cmd === "gh") calls.push(args)
      return { stdout: "" }
    }

    await providePr(GhService.prReady("/wt", 482), capture)
    expect(calls[0]).toEqual(["pr", "ready", "482"])
  })

  it("prReady fails with GhError on a non-zero exit", async () => {
    const ready = await providePr(GhService.prReady("/wt", 482), () => ({
      exitCode: 1,
      stderr: "gh: not a draft"
    }))
    expect(failureOf(ready)?._tag).toBe("GhError")
  })
})
