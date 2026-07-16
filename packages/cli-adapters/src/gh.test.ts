import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { GhService, mapIssueSummary, mapPrSummary, mapPrView, mapReviewComments } from "./gh.js"
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

describe("mapReviewComments", () => {
  it("maps inline review comments, falling back to original_line when line is null", () => {
    const items = mapReviewComments([
      {
        id: 3590457963,
        user: { login: "greptile-apps[bot]" },
        body: "RAF not cancelled on unmount",
        created_at: "2026-07-15T20:15:10Z",
        path: "packages/ui/src/composites/code-review-view.tsx",
        line: null,
        original_line: 89
      },
      {
        id: 3590470617,
        user: { login: "iammorganparry" },
        body: "Addressed",
        created_at: "2026-07-15T20:17:16Z",
        path: "packages/ui/src/composites/code-review-view.tsx",
        line: 91
      }
    ])
    expect(items).toStrictEqual([
      {
        id: "rc-3590457963",
        author: "greptile-apps[bot]",
        kind: "commented",
        body: "RAF not cancelled on unmount",
        createdAt: "2026-07-15T20:15:10Z",
        path: "packages/ui/src/composites/code-review-view.tsx",
        line: 89
      },
      {
        id: "rc-3590470617",
        author: "iammorganparry",
        kind: "commented",
        body: "Addressed",
        createdAt: "2026-07-15T20:17:16Z",
        path: "packages/ui/src/composites/code-review-view.tsx",
        line: 91
      }
    ])
  })

  it("tolerates a null / empty payload", () => {
    expect(mapReviewComments(null)).toStrictEqual([])
    expect(mapReviewComments([])).toStrictEqual([])
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
    const view = (state: string): FakeCommandHandler => (cmd, args) =>
      cmd === "gh" && args[1] === "view" ? { stdout: JSON.stringify({ state }) } : undefined
    const merged = await providePr(GhService.prState("/wt", 1), view("MERGED"))
    expect(merged._tag === "Success" && merged.value).toBe("merged")
    const closed = await providePr(GhService.prState("/wt", 1), view("CLOSED"))
    expect(closed._tag === "Success" && closed.value).toBe("closed")
    const open = await providePr(GhService.prState("/wt", 1), view("OPEN"))
    expect(open._tag === "Success" && open.value).toBe("open")
    const bad = await providePr(GhService.prState("/wt", 1), () => ({ stdout: "not json" }))
    expect(bad._tag === "Success" && bad.value).toBe(null)
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
