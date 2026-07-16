import type {
  GhStatus,
  Issue,
  IssueSummary,
  PrCheck,
  PrCheckStatus,
  PrFileChange,
  PrLabel,
  PrMergeMethod,
  PrReviewer,
  PrReviewKind,
  PrReviewThread,
  PrState,
  PrThreadComment,
  PrSummary,
  PrTimelineItem,
  PullRequest,
  ReviewSubmitKind
} from "@starbase/core"
import { GhError, PrAuthorAssociation } from "@starbase/core"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Option, Schema, Stream } from "effect"
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
    // `gh pr view` cannot see inline review threads; `prView` fills these in
    // from a separate GraphQL call.
    reviewThreads: [],
    checks,
    mergeable,
    mergeStateStatus,
    mergeBlockers: [...new Set(mergeBlockers)]
  }
}

/**
 * The GraphQL query behind `prReviewThreads`.
 *
 * `gh pr view` exposes only each review's top-level body — never the inline
 * thread comments — so an inline-only review (Greptile submits an empty-body
 * `COMMENTED` review with all content inline) would otherwise never surface.
 * REST `/pulls/{n}/comments` carries the comments but cannot report resolution
 * state at all; `reviewThreads` is the only source for `isResolved` /
 * `isOutdated`, and it returns the grouping, diff hunk and replies in one call.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id isResolved isOutdated path line startLine originalLine originalStartLine
          resolvedBy{ login }
          comments(first:50){
            nodes{
              id databaseId body createdAt diffHunk authorAssociation
              author{ login avatarUrl __typename }
              pullRequestReview{ id }
              reactionGroups{ content reactors{ totalCount } }
            }
          }
        }
      }
    }
  }
}`

/** Thread resolution is GraphQL-only — REST has no equivalent. */
const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`
const UNRESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  unresolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`

/**
 * Narrow GitHub's `authorAssociation` through the schema itself, so the accepted
 * values live in exactly one place (`packages/core`) and an unknown value from a
 * future API revision degrades to null rather than throwing.
 */
const decodeAssociation = Schema.decodeUnknownOption(PrAuthorAssociation)
const associationOf = (v: unknown): PrAuthorAssociation | null =>
  Option.getOrNull(decodeAssociation(str(v)?.toUpperCase()))

const mapThreadComment = (c: Json): PrThreadComment => {
  const author = rec(c.author)
  return {
    id: str(c.id) ?? "",
    databaseId: num(c.databaseId),
    author: str(author.login) ?? "unknown",
    authorAvatarUrl: str(author.avatarUrl),
    // Bots report an `authorAssociation` of NONE, so __typename is the only tell.
    isBot: str(author.__typename) === "Bot",
    association: associationOf(c.authorAssociation),
    body: str(c.body) ?? "",
    createdAt: str(c.createdAt) ?? "",
    reactions: arr(c.reactionGroups).flatMap((g) => {
      const count = num(rec(g.reactors).totalCount) ?? 0
      const content = str(g.content)
      // GitHub returns every reaction kind, including the ones nobody used.
      return count > 0 && content ? [{ content, count }] : []
    })
  }
}

/**
 * Map a raw `reviewThreads` GraphQL payload into `PrReviewThread`s. Pure +
 * defensive, like `mapPrView` — the primary unit-test target.
 *
 * The thread's diff hunk and owning review both come from its FIRST comment:
 * GitHub anchors the thread to the hunk the review was written against, and
 * replies repeat the same hunk. Threads with no comments are dropped — there is
 * nothing to anchor or render.
 */
export const mapReviewThreads = (raw: unknown): ReadonlyArray<PrReviewThread> => {
  const pr = rec(rec(rec(rec(raw).data).repository).pullRequest)
  return arr(rec(pr.reviewThreads).nodes).flatMap((t) => {
    const nodes = arr(rec(t.comments).nodes)
    const first = nodes[0]
    if (first === undefined) return []
    return [
      {
        id: str(t.id) ?? "",
        reviewId: str(rec(first.pullRequestReview).id),
        path: str(t.path) ?? "",
        line: num(t.line),
        startLine: num(t.startLine),
        originalLine: num(t.originalLine),
        originalStartLine: num(t.originalStartLine),
        diffHunk: str(first.diffHunk) ?? "",
        isResolved: t.isResolved === true,
        isOutdated: t.isOutdated === true,
        resolvedBy: str(rec(t.resolvedBy).login),
        comments: nodes.map(mapThreadComment)
      } satisfies PrReviewThread
    ]
  })
}

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

/**
 * Map a raw `gh issue list --json …` item into the lightweight `IssueSummary`
 * used by the "new session from an issue" picker + attach dialog. Pure +
 * defensive — the unit-test target.
 */
export const mapIssueSummary = (raw: unknown): IssueSummary => {
  const j = rec(raw)
  return {
    number: num(j.number) ?? 0,
    title: str(j.title) ?? "",
    url: str(j.url) ?? "",
    body: str(j.body) ?? "",
    labels: arr(j.labels).map((l) => ({ name: str(rec(l).name) ?? "", color: str(rec(l).color) })),
    author: { login: str(rec(j.author).login) ?? "unknown", avatarUrl: null },
    assignees: arr(j.assignees).map((a) => ({ login: str(rec(a).login) ?? "", avatarUrl: null })),
    updatedAt: str(j.updatedAt) ?? ""
  }
}

/**
 * Map a raw `gh issue view --json …` payload into the full `Issue` view model
 * for the Issue tab (title, body, labels, assignees, comments). Pure + defensive.
 */
export const mapIssue = (raw: unknown): Issue => {
  const j = rec(raw)
  return {
    number: num(j.number) ?? 0,
    title: str(j.title) ?? "",
    url: str(j.url) ?? "",
    state: str(j.state)?.toUpperCase() === "CLOSED" ? "closed" : "open",
    body: str(j.body) ?? "",
    author: { login: str(rec(j.author).login) ?? "unknown", avatarUrl: null },
    assignees: arr(j.assignees).map((a) => ({ login: str(rec(a).login) ?? "", avatarUrl: null })),
    labels: arr(j.labels).map((l) => ({ name: str(rec(l).name) ?? "", color: str(rec(l).color) })),
    createdAt: str(j.createdAt) ?? "",
    comments: arr(j.comments).map((c) => ({
      author: { login: str(rec(rec(c).author).login) ?? "unknown", avatarUrl: null },
      body: str(rec(c).body) ?? "",
      createdAt: str(rec(c).createdAt) ?? ""
    }))
  }
}

/** The `--json` field set requested from `gh issue view` (drives `mapIssue`). */
const ISSUE_VIEW_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "body",
  "author",
  "assignees",
  "labels",
  "createdAt",
  "comments"
].join(",")

/** The `--json` field set requested from `gh issue list` (drives `mapIssueSummary`). */
const ISSUE_LIST_FIELDS = [
  "number",
  "title",
  "labels",
  "author",
  "assignees",
  "updatedAt",
  "url",
  "body"
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
       * List open issues for the repo at `cwd`, for the "new session from an
       * issue" picker + attach dialog. `mine` filters to issues assigned to the
       * authenticated user (`--assignee @me`); `search` passes free text through
       * `--search`. Never fails — folds to an empty list.
       */
      listIssues: (
        cwd: string,
        opts: { mine: boolean; search: string }
      ): Effect.Effect<ReadonlyArray<IssueSummary>, never, CommandExecutor.CommandExecutor> =>
        ghJson(
          cwd,
          ghArgs(
            ["issue", "list", "--state", "open", "--json", ISSUE_LIST_FIELDS, "--limit", "50"],
            [
              ["--assignee", opts.mine && "@me"],
              ["--search", opts.search.trim()]
            ]
          )
        ).pipe(Effect.map((raw) => arr(raw).map(mapIssueSummary))),

      /** The full `Issue` view model for `number` (Issue tab), or null on failure. */
      issueView: (
        cwd: string,
        number: number
      ): Effect.Effect<Issue | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["issue", "view", String(number), "--json", ISSUE_VIEW_FIELDS]).pipe(
          Effect.map((raw) => (raw === null ? null : mapIssue(raw)))
        ),

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

      /**
       * The head commit SHA of PR `number` (`gh pr view --json headRefOid`), or
       * null on any failure. Cheap single-field read, deliberately kept out of
       * `PR_VIEW_FIELDS` — the adversarial-review de-dupe polls this on its own
       * cadence and has no use for the rest of the view model.
       */
      prHeadSha: (
        cwd: string,
        number: number
      ): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "view", String(number), "--json", "headRefOid"]).pipe(
          Effect.map((raw) => str(rec(raw).headRefOid) ?? null)
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
          // `gh pr view` omits inline review threads entirely — fetch them via
          // GraphQL so inline-only reviews (Greptile, etc.) appear at all, and
          // with their resolution state. Folding a failure to [] degrades to the
          // top-level timeline rather than blanking the tab.
          const threadsRaw = yield* ghJson(cwd, [
            "api",
            "graphql",
            "-F",
            "owner={owner}",
            "-F",
            "repo={repo}",
            "-F",
            `number=${number}`,
            "-f",
            `query=${REVIEW_THREADS_QUERY}`
          ])
          return { ...pr, reviewThreads: mapReviewThreads(threadsRaw) }
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
       * Resolve / unresolve inline review thread `threadId` (a GraphQL node id
       * from `prReviewThreads`). GitHub exposes thread resolution through
       * GraphQL only — there is no REST equivalent.
       */
      resolveThread: (
        cwd: string,
        threadId: string,
        resolved: boolean
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, [
          "api",
          "graphql",
          "-F",
          `id=${threadId}`,
          "-f",
          `query=${resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION}`
        ]).pipe(Effect.asVoid),

      /**
       * Reply to the inline review thread that `commentId` belongs to.
       * `commentId` is a REST numeric id (`PrThreadComment.databaseId`), NOT a
       * GraphQL node id: this purpose-built REST endpoint threads the reply
       * automatically, whereas GraphQL's `addPullRequestReviewThreadReply`
       * entangles the reply with pending-review state.
       */
      replyToThread: (
        cwd: string,
        number: number,
        commentId: number,
        body: string
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, [
          "api",
          "--method",
          "POST",
          `repos/{owner}/{repo}/pulls/${number}/comments/${commentId}/replies`,
          "-f",
          `body=${body}`
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
        runGh(cwd, ["pr", "ready", String(number)]).pipe(Effect.asVoid),

      // ── Issue writes (surface GhError) ─────────────────────────────────────

      /** Post a comment on issue `number` (progress-comment automation). */
      issueComment: (
        cwd: string,
        number: number,
        body: string
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["issue", "comment", String(number), "--body", body]).pipe(Effect.asVoid),

      /** Close issue `number` (close-on-merge automation). */
      closeIssue: (
        cwd: string,
        number: number
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["issue", "close", String(number)]).pipe(Effect.asVoid)
    })
  }
) {}
