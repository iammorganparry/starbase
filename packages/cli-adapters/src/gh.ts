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
  SessionPrStatus,
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
import { runGh, runGhInput, runString, which } from "./command.js"

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

/**
 * The whole run reduced to one word, worst-first.
 *
 * Order matters and is not alphabetical: one failing check makes the run
 * failing, however many passed alongside it, and a run with anything still
 * moving is not yet a pass. Reporting "pass" while a job is queued would show a
 * green glyph on a PR that is about to go red.
 *
 * Returns null for an EMPTY list, which is a different fact from "pending":
 * null means the repo has no CI on this PR at all, and a glyph that showed
 * amber for it would leave those sessions looking permanently mid-build.
 */
export const rollupChecks = (
  checks: ReadonlyArray<{ readonly status: PrCheckStatus }>
): PrCheckStatus | null => {
  if (checks.length === 0) return null
  if (checks.some((c) => c.status === "fail")) return "fail"
  if (checks.some((c) => c.status === "running")) return "running"
  if (checks.some((c) => c.status === "pending")) return "pending"
  return "pass"
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

/**
 * The REST `pulls/{n}/files` read, paginated — the source for BOTH the Code
 * Review file list and (when `gh pr diff` refuses) the diff itself.
 *
 * `gh pr view --json files` silently caps at 100 files: it is GitHub's GraphQL
 * `files(first: 100)`, which gh does not paginate. On a large PR that truncated
 * the file list *and* its +/− totals with no indication — e.g. a 176-file PR
 * rendered as exactly 100 files summing +5516/−11226 instead of +10871/−24491.
 * REST + `--paginate` returns every file (to GitHub's own 3000-file ceiling) and
 * carries a per-file `patch`. `{owner}/{repo}` resolve from the worktree's remote.
 */
const prFilesApiArgs = (number: number): ReadonlyArray<string> => [
  "api",
  "--paginate",
  `repos/{owner}/{repo}/pulls/${number}/files`
]

/** Map the REST `pulls/{n}/files` payload into the Code Review file list. */
export const mapApiFiles = (raw: unknown): ReadonlyArray<PrFileChange> =>
  arr(raw)
    .map((f) => ({
      path: str(f.filename) ?? "",
      additions: num(f.additions) ?? 0,
      deletions: num(f.deletions) ?? 0,
      commentCount: 0,
      viewed: false
    }))
    .filter((f) => f.path.length > 0)

/**
 * Rebuild a unified diff from the REST `pulls/{n}/files` payload — the fallback
 * for when `gh pr diff` refuses outright (`HTTP 406: the diff exceeded the
 * maximum number of lines (20000)`), which previously surfaced as a silently
 * EMPTY diff: every file listed, not one line of change rendered.
 *
 * Each REST `patch` starts bare at `@@`, so we re-add the `diff --git` +
 * `---`/`+++` headers the renderer slices files on. Pure — the unit-test target.
 */
export const unifiedDiffFromApiFiles = (raw: unknown): string => {
  const out: string[] = []
  for (const f of arr(raw)) {
    const path = str(f.filename)
    if (path === null || path.length === 0) continue
    const status = str(f.status)
    // Renames carry the old path; everything else diffs against itself.
    const old = str(f.previous_filename) ?? path
    out.push(`diff --git a/${old} b/${path}`)
    out.push(status === "added" ? "--- /dev/null" : `--- a/${old}`)
    out.push(status === "removed" ? "+++ /dev/null" : `+++ b/${path}`)
    // GitHub omits `patch` for oversized/binary files (e.g. a lockfile). Emit the
    // header anyway so the file still appears, with no hunks to render, rather
    // than vanishing from the diff entirely.
    const patch = str(f.patch)
    if (patch !== null && patch.length > 0) out.push(patch)
  }
  return out.length > 0 ? `${out.join("\n")}\n` : ""
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

/**
 * A hunk header — `@@ -12,7 +14,9 @@`. Group 1 is the new-side START line; group
 * 2 is the new-side LENGTH (the `,9`), which is optional and defaults to 1 when
 * absent (`@@ -12 +14 @@` is a single-line hunk). The old-side `-12,7` is not
 * captured — only the new side can be commented on.
 */
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * The NEW-side (`side: "RIGHT"`) line numbers GitHub will accept a review
 * comment on, per repo-relative path.
 *
 * **Why this exists at all.** `POST /pulls/{n}/reviews` is all-or-nothing: name
 * one line outside the diff and GitHub 422s the ENTIRE review, so a single
 * mis-anchored nit silently takes every other nit down with it. The reviewer is
 * a language model reporting line numbers it read off a diff — it gets one wrong
 * often enough that "just trust it" is not a strategy. Callers check against
 * this map first and fold whatever fails into the review body, where a line
 * number is a nice-to-have rather than a precondition.
 *
 * Only `+` (added) and ` ` (context) lines count. A `-` line exists solely on
 * the LEFT side; commenting on it with `side: "RIGHT"` is exactly the 422 above.
 */
export const postableLines = (diff: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const out = new Map<string, Set<number>>()
  let path: string | null = null
  let newLine = 0
  // New-side lines still expected in the current hunk, from the header's `+c,d`
  // length. Decremented on each context/added line; at 0 the hunk's new side is
  // spent. This is the diff's OWN declared bound, and it is what keeps counting
  // honest — see the trailing-line note below.
  let remaining = 0
  // Whether we're inside a hunk body. Load-bearing for diffs-of-diffs (a PR that
  // touches a .patch fixture, or this very repo's tests): inside a hunk, a line
  // reading `+++ b/x` is an ADDED LINE whose content is `++ b/x`, not a file
  // header. Only a line at column 0 outside a hunk can be a header — and a real
  // `diff --git` can never appear inside one, because every hunk line is
  // prefixed with ` `, `+`, or `-`.
  let inHunk = false

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = null
      inHunk = false
      continue
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim()
      // A deletion's new side is /dev/null — nothing to comment on.
      path = target === "/dev/null" ? null : target.replace(/^b\//, "")
      continue
    }
    if (!inHunk && raw.startsWith("--- ")) continue
    const hunk = HUNK_RE.exec(raw)
    if (hunk !== null) {
      inHunk = true
      newLine = Number(hunk[1])
      // The `,d` length, or 1 when omitted.
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    if (!inHunk || path === null) continue

    if (raw.startsWith("-")) {
      // Left side only — advances nothing on the right, and consumes none of the
      // new-side budget.
      continue
    }

    if (raw.startsWith("+") || raw.startsWith(" ") || raw.length === 0) {
      // Bounded by the header's declared new-side length. Past it, a line that
      // still LOOKS like hunk body is not one — most commonly the empty final
      // element `diff.split("\n")` yields for `gh pr diff`'s trailing newline.
      // Counting it would admit a phantom line number one past the file's end —
      // the classic end-of-file off-by-one — and a finding mis-anchored there
      // would 422 the whole review, the exact failure this function prevents.
      if (remaining <= 0) {
        inHunk = false
        continue
      }
      // A bare empty line is a context line whose single space was stripped —
      // `gh pr diff` and the REST `patch` field both emit these. Counting it is
      // what keeps every subsequent line number in the hunk aligned.
      let lines = out.get(path)
      if (lines === undefined) {
        lines = new Set()
        out.set(path, lines)
      }
      lines.add(newLine)
      newLine += 1
      remaining -= 1
    } else {
      // "\ No newline at end of file", or we've fallen out of the hunk body.
      if (!raw.startsWith("\\")) inHunk = false
    }
  }
  return out
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
       * PR `number` reduced to what a sidebar row shows: its lifecycle state and
       * a CI rollup. Never fails.
       *
       * Three JSON fields, not the twenty `PR_VIEW_FIELDS` asks for. This is
       * polled for every session with a PR, on a timer, for as long as the app
       * is open — so it stays the cheapest call that can answer the question.
       *
       * `isDraft` is fetched because `state` reports a draft as OPEN; a draft is
       * a genuinely different thing to look at, and the glyph says so.
       */
      prState: (
        cwd: string,
        number: number
      ): Effect.Effect<SessionPrStatus | null, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, ["pr", "view", String(number), "--json", "state,isDraft,statusCheckRollup"]).pipe(
          Effect.map((raw) => {
            const j = rec(raw)
            const s = str(j.state)?.toUpperCase()
            const state: PrState | null =
              s === "MERGED"
                ? "merged"
                : s === "CLOSED"
                  ? "closed"
                  : s === "OPEN"
                    ? j.isDraft === true
                      ? "draft"
                      : "open"
                    : null
            if (state === null) return null
            // A merged or closed PR's checks are history. Reporting them would
            // paint a long-merged session red because one flaky job failed on
            // the way in, which says nothing about anything you can still act on.
            if (state === "merged" || state === "closed") return { state, checks: null }
            const checks = arr(j.statusCheckRollup).map((c) => ({ status: checkStatusOf(c) }))
            return { state, checks: rollupChecks(checks) }
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

      /**
       * The changed files of `number` for the Code Review file list — EVERY file,
       * via the paginated REST read (see `prFilesApiArgs`). The old
       * `gh pr view --json files` capped this at 100 with no signal.
       */
      prFiles: (
        cwd: string,
        number: number
      ): Effect.Effect<ReadonlyArray<PrFileChange>, never, CommandExecutor.CommandExecutor> =>
        ghJson(cwd, prFilesApiArgs(number)).pipe(Effect.map(mapApiFiles)),

      /**
       * The unified diff of `number` vs its base, or "" on any failure.
       *
       * `gh pr diff` is the primary read — one cheap call, and the authoritative
       * diff. But GitHub refuses it outright past 20k lines (HTTP 406), which
       * `readStdout` folds to null exactly like any other failure — so a large PR
       * rendered its whole file list with an empty diff and no error. On failure
       * we rebuild the diff from the per-file `patch`es of the paginated REST
       * read, which has no such ceiling.
       */
      prDiff: (
        cwd: string,
        number: number
      ): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
        readStdout(cwd, ["pr", "diff", String(number)]).pipe(
          // null = gh failed (406 too_large, auth, no binary). "" = a genuinely
          // empty diff, which must NOT trigger the fallback.
          Effect.flatMap((out) =>
            out !== null
              ? Effect.succeed(out)
              : ghJson(cwd, prFilesApiArgs(number)).pipe(Effect.map(unifiedDiffFromApiFiles))
          )
        ),

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

      /**
       * Submit a COMMENT review on `number` carrying inline, line-anchored
       * comments — the shape `gh pr review` cannot express (it takes a body and
       * nothing else).
       *
       * Every comment's `line` MUST be a NEW-side line present in the diff at
       * `commitSha` (see `postableLines`) — GitHub rejects the whole review
       * otherwise, not just the offending comment.
       *
       * `comments` may be empty: that degrades to a plain body-only review,
       * which is the right outcome when nothing anchored.
       */
      prReviewComments: (
        cwd: string,
        number: number,
        input: {
          /** The head commit the comments are anchored against. */
          readonly commitSha: string
          readonly body: string
          readonly comments: ReadonlyArray<{
            readonly path: string
            readonly line: number
            /** Start of a multi-line range, or null for a single line. */
            readonly startLine: number | null
            readonly body: string
          }>
        }
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGhInput(
          cwd,
          ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--input", "-"],
          JSON.stringify({
            commit_id: input.commitSha,
            body: input.body,
            // COMMENT, never REQUEST_CHANGES: these are nits and minors by
            // construction (the critical/major half went to the agent), and a
            // bot blocking a PR over a nit is how a reviewer gets muted.
            event: "COMMENT",
            comments: input.comments.map((c) => ({
              path: c.path,
              line: c.line,
              // Omitted rather than null when absent: GitHub 422s an explicit
              // `start_line: null`, and rejects a start_line equal to line.
              ...(c.startLine === null || c.startLine >= c.line
                ? {}
                : { start_line: c.startLine, start_side: "RIGHT" }),
              side: "RIGHT",
              body: c.body
            }))
          })
        ).pipe(Effect.asVoid),

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
       * Merge the base branch into PR `number`'s head — GitHub's "Update branch".
       *
       * This is the fix for `mergeStateStatus: "BEHIND"`, which is the one merge
       * blocker the operator can clear from here without touching the code. It
       * updates the REMOTE head, not this worktree: the session's local branch is
       * left alone deliberately, since the agent may be mid-turn with uncommitted
       * work and pulling underneath it would be hostile.
       *
       * `--update-branch` needs a reasonably current `gh`; an older one fails
       * with a usage error, which surfaces as `GhError` like any other rejection.
       */
      prUpdateBranch: (
        cwd: string,
        number: number
      ): Effect.Effect<void, GhError, CommandExecutor.CommandExecutor> =>
        runGh(cwd, ["pr", "update-branch", String(number)]).pipe(Effect.asVoid),

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
