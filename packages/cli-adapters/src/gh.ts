import type {
  GhStatus,
  PrCheck,
  PrCheckStatus,
  PrFileChange,
  PrLabel,
  PrMergeMethod,
  PrReviewer,
  PrReviewKind,
  PrState,
  PrSummary,
  PrTimelineItem,
  PullRequest,
  ReviewSubmitKind
} from "@starbase/core"
import { GhError } from "@starbase/core"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Stream } from "effect"
import { runGh, runString, which } from "./command.js"

const UNAVAILABLE: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

// ── gh JSON reads ────────────────────────────────────────────────────────────

/** Run `gh` in `cwd` and return trimmed stdout, or null on any non-zero exit. */
const readStdout = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make("gh", ...args).pipe(
        Command.workingDirectory(cwd),
        Command.start
      )
      const decode = (stream: Stream.Stream<Uint8Array, unknown>) =>
        stream.pipe(Stream.decodeText(), Stream.runFold("", (acc, chunk) => acc + chunk))
      const [out, code] = yield* Effect.all([decode(proc.stdout), proc.exitCode], {
        concurrency: 2
      })
      return (code as number) === 0 ? out.trim() : null
    })
  ).pipe(Effect.orElseSucceed(() => null))

/** Read `gh … --json …` as parsed JSON, folding any failure / bad JSON to null. */
const ghJson = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<unknown, never, CommandExecutor.CommandExecutor> =>
  readStdout(cwd, args).pipe(
    Effect.map((out) => {
      if (out === null || out.length === 0) return null
      try {
        return JSON.parse(out) as unknown
      } catch {
        return null
      }
    })
  )

// ── raw gh JSON accessors (defensive — gh field shapes vary by version) ───────

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {})
const arr = (v: unknown): ReadonlyArray<Json> => (Array.isArray(v) ? (v as ReadonlyArray<Json>) : [])
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

/**
 * Declaratively build a `gh` argv: a fixed `base` followed by optional pieces.
 * Each optional is `[flag, value]` (emitted as `flag value` only when `value`
 * is a non-empty string) or a bare `[flag]` (emitted only when `flag` is set).
 * A falsy entry is dropped, so callers read as a list of "include this when …".
 */
const ghArgs = (
  base: ReadonlyArray<string>,
  optional: ReadonlyArray<readonly [string, (string | false | null | undefined)?] | false>
): ReadonlyArray<string> => [
  ...base,
  ...optional.flatMap((entry) => {
    if (!entry) return []
    const [flag, value] = entry
    if (value === undefined) return [flag] // bare flag (e.g. "--draft")
    return value ? [flag, value] : [] // flag + value, when present
  })
]

/** Narrow review state → the three timeline kinds (never "pending"). */
const timelineKindOf = (state: string | null): "commented" | "approved" | "changes_requested" => {
  const s = state?.toUpperCase()
  return s === "APPROVED" ? "approved" : s === "CHANGES_REQUESTED" ? "changes_requested" : "commented"
}

const reviewKindOf = (state: string | null): PrReviewKind => timelineKindOf(state)

const checkStatusOf = (c: Json): PrCheckStatus => {
  const status = str(c.status)?.toUpperCase()
  const conclusion = str(c.conclusion)?.toUpperCase()
  const state = str(c.state)?.toUpperCase() // legacy StatusContext
  if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING") {
    return status === "IN_PROGRESS" ? "running" : "pending"
  }
  const verdict = conclusion ?? state
  if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") return "pass"
  if (
    verdict === "FAILURE" ||
    verdict === "ERROR" ||
    verdict === "TIMED_OUT" ||
    verdict === "CANCELLED" ||
    verdict === "STARTUP_FAILURE" ||
    verdict === "ACTION_REQUIRED"
  ) {
    return "fail"
  }
  if (state === "PENDING") return "running"
  return "pending"
}

const durationOf = (c: Json): number | null => {
  const started = str(c.startedAt)
  const completed = str(c.completedAt)
  if (!started || !completed) return null
  const ms = new Date(completed).getTime() - new Date(started).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/**
 * Map a raw `gh pr view --json …` object into the normalized `PullRequest` view
 * model. Pure + defensive (every field may be absent across gh versions) — the
 * primary unit-test target. "draft" state, `mergeBlockers`, and `checks` are
 * synthesized here (GitHub reports none of them as a single field).
 */
export const mapPrView = (raw: unknown): PullRequest => {
  const j = rec(raw)
  const rawState = str(j.state)?.toUpperCase()
  const isDraft = j.isDraft === true
  const state: PrState =
    rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : isDraft
          ? "draft"
          : "open"

  const labels: ReadonlyArray<PrLabel> = arr(j.labels).map((l) => ({
    name: str(l.name) ?? "",
    color: str(l.color)
  }))

  // Reviewers: latest review state per login, plus outstanding review requests.
  const byLogin = new Map<string, PrReviewKind>()
  for (const rv of arr(j.reviews)) {
    const login = str(rec(rv.author).login)
    const s = str(rv.state)?.toUpperCase()
    if (!login || s === "PENDING" || s === "DISMISSED") continue
    byLogin.set(login, reviewKindOf(str(rv.state)))
  }
  for (const req of arr(j.reviewRequests)) {
    const login = str(req.login) ?? str(req.name) // user | team
    if (login && !byLogin.has(login)) byLogin.set(login, "pending")
  }
  const reviewers: ReadonlyArray<PrReviewer> = [...byLogin.entries()].map(([login, s]) => ({
    login,
    state: s
  }))

  // Timeline: substantive reviews + issue comments, chronological.
  const reviewItems: ReadonlyArray<PrTimelineItem> = arr(j.reviews)
    .filter((rv) => {
      const s = str(rv.state)?.toUpperCase()
      return s === "APPROVED" || s === "CHANGES_REQUESTED" || (str(rv.body) ?? "").length > 0
    })
    .map((rv, i) => ({
      id: str(rv.id) ?? `review-${i}`,
      author: str(rec(rv.author).login) ?? "unknown",
      kind: timelineKindOf(str(rv.state)),
      body: str(rv.body) ?? "",
      createdAt: str(rv.submittedAt) ?? str(rv.createdAt) ?? "",
      path: null,
      line: null
    }))
  const commentItems: ReadonlyArray<PrTimelineItem> = arr(j.comments).map((c, i) => ({
    id: str(c.id) ?? `comment-${i}`,
    author: str(rec(c.author).login) ?? "unknown",
    kind: "commented" as const,
    body: str(c.body) ?? "",
    createdAt: str(c.createdAt) ?? "",
    path: null,
    line: null
  }))
  const timeline = [...reviewItems, ...commentItems].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  )

  const checks: ReadonlyArray<PrCheck> = arr(j.statusCheckRollup).map((c) => ({
    name: str(c.name) ?? str(c.context) ?? "check",
    status: checkStatusOf(c),
    detailsUrl: str(c.detailsUrl) ?? str(c.targetUrl),
    durationMs: durationOf(c)
  }))

  const files = arr(j.files)
  const mergeable = str(j.mergeable)
  const mergeStateStatus = str(j.mergeStateStatus)

  const mergeBlockers: Array<string> = []
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") mergeBlockers.push("Merge conflicts")
  if (mergeStateStatus === "BLOCKED") mergeBlockers.push("Blocked by branch protection")
  if (mergeStateStatus === "BEHIND") mergeBlockers.push("Branch is out of date with the base")
  const failing = checks.filter((c) => c.status === "fail").length
  if (failing > 0) mergeBlockers.push(`${failing} failing check${failing > 1 ? "s" : ""}`)
  const changesReq = reviewers.filter((r) => r.state === "changes_requested").length
  if (changesReq > 0) mergeBlockers.push(`${changesReq} change request${changesReq > 1 ? "s" : ""}`)

  return {
    number: num(j.number) ?? 0,
    state,
    title: str(j.title) ?? "",
    body: str(j.body),
    url: str(j.url) ?? "",
    headRefName: str(j.headRefName) ?? "",
    baseRefName: str(j.baseRefName) ?? "",
    isDraft,
    author: { login: str(rec(j.author).login) ?? "unknown", avatarUrl: null },
    createdAt: str(j.createdAt) ?? "",
    commits: arr(j.commits).length,
    changedFiles: files.length,
    additions: num(j.additions) ?? 0,
    deletions: num(j.deletions) ?? 0,
    labels,
    reviewers,
    timeline,
    checks,
    mergeable,
    mergeStateStatus,
    mergeBlockers: [...new Set(mergeBlockers)]
  }
}

/**
 * Map GitHub's REST inline review comments (`GET /pulls/{n}/comments`) into
 * timeline items. `gh pr view` only exposes each review's top-level body — never
 * the inline thread comments — so an inline-only review (e.g. Greptile, which
 * submits an empty-body `COMMENTED` review with all content inline) would
 * otherwise never surface. Anchors to the comment's current line, falling back
 * to the original line when the hunk has since moved (`line` is null on outdated
 * comments).
 */
export const mapReviewComments = (raw: unknown): ReadonlyArray<PrTimelineItem> =>
  arr(raw).map((c, i) => ({
    id: `rc-${num(c.id) ?? i}`,
    author: str(rec(c.user).login) ?? "unknown",
    kind: "commented" as const,
    body: str(c.body) ?? "",
    createdAt: str(c.created_at) ?? "",
    path: str(c.path),
    line: num(c.line) ?? num(c.original_line)
  }))

/** The `--json` field set requested from `gh pr view` (drives `mapPrView`). */
const PR_VIEW_FIELDS = [
  "state",
  "number",
  "title",
  "body",
  "headRefName",
  "baseRefName",
  "isDraft",
  "commits",
  "files",
  "additions",
  "deletions",
  "author",
  "createdAt",
  "labels",
  "reviews",
  "comments",
  "reviewRequests",
  "statusCheckRollup",
  "mergeable",
  "mergeStateStatus",
  "url"
].join(",")

/**
 * Map a raw `gh pr list --json …` item into the lightweight `PrSummary` used by
 * the "new session from a PR" picker. Pure + defensive — the unit-test target.
 * "draft" state is synthesized from `isDraft` (as in `mapPrView`).
 */
export const mapPrSummary = (raw: unknown): PrSummary => {
  const j = rec(raw)
  const rawState = str(j.state)?.toUpperCase()
  const isDraft = j.isDraft === true
  const state: PrState =
    rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : isDraft
          ? "draft"
          : "open"
  return {
    number: num(j.number) ?? 0,
    title: str(j.title) ?? "",
    headRefName: str(j.headRefName) ?? "",
    baseRefName: str(j.baseRefName) ?? "",
    author: { login: str(rec(j.author).login) ?? "unknown", avatarUrl: null },
    state,
    isDraft,
    additions: num(j.additions) ?? 0,
    deletions: num(j.deletions) ?? 0,
    updatedAt: str(j.updatedAt) ?? ""
  }
}

/** The `--json` field set requested from `gh pr list` (drives `mapPrSummary`). */
const PR_LIST_FIELDS = [
  "number",
  "title",
  "headRefName",
  "baseRefName",
  "author",
  "state",
  "isDraft",
  "additions",
  "deletions",
  "updatedAt"
].join(",")

/** Map `gh pr review` submit kind → the corresponding gh flag. */
const REVIEW_FLAG: Record<ReviewSubmitKind, string> = {
  comment: "--comment",
  approve: "--approve",
  "request-changes": "--request-changes"
}

/** Run a command capturing exit code + combined stdout/stderr; never fails. */
const capture = (
  bin: string,
  args: ReadonlyArray<string>
): Effect.Effect<{ code: number; out: string }, never, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make(bin, ...args).pipe(Command.start)
      const decode = (stream: Stream.Stream<Uint8Array, unknown>) =>
        stream.pipe(Stream.decodeText(), Stream.runFold("", (acc, chunk) => acc + chunk))
      const [stdout, stderr, code] = yield* Effect.all(
        [decode(proc.stdout), decode(proc.stderr), proc.exitCode],
        { concurrency: 3 }
      )
      return { code: code as number, out: `${stdout}\n${stderr}`.trim() }
    })
  ).pipe(Effect.orElseSucceed(() => ({ code: -1, out: "" })))

/**
 * Detects the GitHub CLI (`gh`) and its auth state. Never fails — a missing or
 * unauthenticated `gh` is reported, not raised (GitHub features are optional
 * until the next milestone). `gh auth status` writes to stderr and exits 0 only
 * when a token is present, so we key authentication off the exit code.
 */
export class GhService extends Effect.Service<GhService>()(
  "@starbase/GhService",
  {
    accessors: true,
    sync: () => ({
      status: (): Effect.Effect<GhStatus, never, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const bin = yield* which("gh")
          if (bin === null) return UNAVAILABLE

          const versionRaw = yield* runString(bin, "--version")
          const firstLine = versionRaw?.split("\n")[0] ?? null
          const version = firstLine
            ? (firstLine.match(/gh version (\S+)/)?.[1] ?? firstLine)
            : null

          const auth = yield* capture(bin, ["auth", "status"])
          const authenticated = auth.code === 0
          if (!authenticated) {
            return { available: true, authenticated: false, login: null, host: null, version }
          }
          const login = auth.out.match(/(?:account|as)\s+([A-Za-z0-9-]+)/)?.[1] ?? null
          const host =
            auth.out.match(/Logged in to (\S+)/)?.[1] ??
            auth.out.match(/^\s*(\S+\.\S+)\s*$/m)?.[1] ??
            "github.com"
          return { available: true, authenticated: true, login, host, version }
        }),

      // ── Pull-request reads (never fail; fold to null / empty) ──────────────

      /** The number of a PR open on `branch`, or null when there is none. */
      prForBranch: (
        cwd: string,
        branch: string
      ): Effect.Effect<number | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "list", "--head", branch, "--json", "number", "--limit", "1"]).pipe(
          Effect.map((raw) => num(arr(raw)[0]?.number ?? null))
        ),

      /**
       * The number of the PR open on the worktree's *current* branch, or null.
       * Lets `gh` resolve the live branch (the session's stored branch can drift
       * once the agent checks out or creates a different branch in the worktree).
       */
      prForWorktree: (
        cwd: string
      ): Effect.Effect<number | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "view", "--json", "number"]).pipe(
          Effect.map((raw) => num(rec(raw).number))
        ),

      /**
       * List open PRs for the repo at `cwd`, for the "new session from a PR"
       * picker. `mine` filters to the authenticated user (`--author @me`);
       * `search` passes a free-text query through `--search`. Never fails —
       * folds to an empty list.
       */
      listPrs: (
        cwd: string,
        opts: { mine: boolean; search: string }
      ): Effect.Effect<ReadonlyArray<PrSummary>, never, CommandExecutor.CommandExecutor> =>
        ghJson(
          cwd,
          ghArgs(
            ["pr", "list", "--state", "open", "--json", PR_LIST_FIELDS, "--limit", "50"],
            [
              ["--author", opts.mine && "@me"],
              ["--search", opts.search.trim()]
            ]
          )
        ).pipe(Effect.map((raw) => arr(raw).map(mapPrSummary))),

      /**
       * The lifecycle state of PR `number` — cheap check (`gh pr view --json
       * state`) used by the archive sweep to spot merged/closed PRs. Never fails.
       */
      prState: (
        cwd: string,
        number: number
      ): Effect.Effect<PrState | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "view", String(number), "--json", "state"]).pipe(
          Effect.map((raw) => {
            const s = str(rec(raw).state)?.toUpperCase()
            return s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : s === "OPEN" ? "open" : null
          })
        ),

      /** The full `PullRequest` view model for `number`, or null on any failure. */
      prView: (
        cwd: string,
        number: number
      ): Effect.Effect<PullRequest | null, never, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const raw = yield* ghJson(cwd, ["pr", "view", String(number), "--json", PR_VIEW_FIELDS])
          if (raw === null) return null
          const pr = mapPrView(raw)
          // `gh pr view` omits inline review-thread comments — fetch them via the
          // REST API and merge so inline-only reviews (Greptile, etc.) appear.
          const commentsRaw = yield* ghJson(cwd, [
            "api",
            `repos/{owner}/{repo}/pulls/${number}/comments`,
            "--paginate"
          ])
          const inline = mapReviewComments(commentsRaw)
          if (inline.length === 0) return pr
          const timeline = [...pr.timeline, ...inline].sort((a, b) =>
            a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
          )
          return { ...pr, timeline }
        }),

      /** The changed files of `number` for the Code Review file list. */
      prFiles: (
        cwd: string,
        number: number
      ): Effect.Effect<ReadonlyArray<PrFileChange>, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "view", String(number), "--json", "files"]).pipe(
          Effect.map((raw) =>
            arr(rec(raw).files).map((f) => ({
              path: str(f.path) ?? "",
              additions: num(f.additions) ?? 0,
              deletions: num(f.deletions) ?? 0,
              commentCount: 0,
              viewed: false
            }))
          )
        ),

      /** The unified diff of `number` vs its base, or "" on any failure. */
      prDiff: (
        cwd: string,
        number: number
      ): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
        readStdout(cwd, ["pr", "diff", String(number)]).pipe(Effect.map((out) => out ?? "")),

      // ── Pull-request writes (surface GhError) ──────────────────────────────

      /**
       * Check out PR `number` into the worktree at `cwd` (`gh pr checkout`).
       * Fetches the head branch and switches this worktree's HEAD onto it,
       * configuring the fork remote for cross-repo PRs. Surfaces `GhError`.
       */
      checkoutPr: (
        cwd: string,
        number: number
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["pr", "checkout", String(number)]).pipe(Effect.asVoid),

      /** Open a PR from the worktree's branch; returns the new PR number. */
      prCreate: (
        cwd: string,
        input: { title: string; body: string; base: string; draft: boolean }
      ): Effect.Effect<number, GhError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const args = [
            "pr",
            "create",
            "--title",
            input.title,
            "--body",
            input.body,
            "--base",
            input.base,
            ...(input.draft ? ["--draft"] : [])
          ]
          const out = yield* runGh(cwd, args)
          const fromUrl = out.match(/\/pull\/(\d+)/)?.[1]
          if (fromUrl) return Number(fromUrl)
          // Fall back to resolving the just-created PR for the current branch.
          const resolved = yield* ghJson(cwd, ["pr", "view", "--json", "number"]).pipe(
            Effect.map((raw) => num(rec(raw).number))
          )
          return resolved ?? (yield* Effect.fail(new GhError({ message: "PR created but its number could not be determined" })))
        }),

      /** Post a top-level comment on `number`. */
      prComment: (
        cwd: string,
        number: number,
        body: string
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["pr", "comment", String(number), "--body", body]).pipe(Effect.asVoid),

      /** Submit a review (comment / approve / request-changes) on `number`. */
      prReview: (
        cwd: string,
        number: number,
        kind: ReviewSubmitKind,
        body: string
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, [
          "pr",
          "review",
          String(number),
          REVIEW_FLAG[kind],
          ...(body.length > 0 ? ["--body", body] : [])
        ]).pipe(Effect.asVoid),

      /**
       * Merge PR `number` using `method` (defaults to a merge commit). `gh`
       * requires an explicit strategy flag, so we always pass one; surfaces
       * `GhError` when the merge is rejected (branch protection, conflicts, a
       * strategy the repo disallows, …).
       */
      prMerge: (
        cwd: string,
        number: number,
        method: PrMergeMethod = "merge"
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["pr", "merge", String(number), `--${method}`]).pipe(Effect.asVoid),

      /**
       * Flip draft PR `number` to "ready for review" (`gh pr ready`). Surfaces
       * `GhError` when GitHub rejects it (e.g. the PR is not a draft).
       */
      prReady: (
        cwd: string,
        number: number
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["pr", "ready", String(number)]).pipe(Effect.asVoid)
    })
  }
) {}
