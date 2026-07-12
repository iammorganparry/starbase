import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { GhService, mapPrView } from "./gh.js"
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

describe("GhService pull-request writes", () => {
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
})
