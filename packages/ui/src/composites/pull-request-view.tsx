import type {
  PrLabel,
  PrReviewThread,
  PrState,
  PrTimelineItem,
  PullRequest,
  ReviewSubmitKind
} from "@starbase/core"
import { GitPullRequest } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { AsyncButton } from "../components/async-button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { DiffStat } from "../components/diff-stat.js"
import { StatusDot } from "../components/status-dot.js"
import { PrReviewComposer } from "./pr-review-composer.js"
import { PrReviewGroup } from "./pr-review-group.js"
import { PrSidePanel } from "./pr-side-panel.js"
import { PrTimelineEntry } from "./pr-timeline-entry.js"

/** Per-state colouring for the header status lozenge. */
const stateMeta: Record<PrState, { label: string; text: string; bg: string; border: string; dot: string }> = {
  open: { label: "Open", text: "text-green", bg: "bg-green/[0.13]", border: "border-green/30", dot: "bg-green" },
  merged: { label: "Merged", text: "text-purple", bg: "bg-purple/[0.13]", border: "border-purple/30", dot: "bg-purple" },
  closed: { label: "Closed", text: "text-red", bg: "bg-red/[0.08]", border: "border-red/30", dot: "bg-red" },
  draft: { label: "Draft", text: "text-dim", bg: "bg-white/5", border: "border-line", dot: "bg-line-strong" }
}

/** The bordered status lozenge (green Open / purple Merged / red Closed / neutral Draft). */
function StatePill({ state }: { state: PrState }) {
  const m = stateMeta[state]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-[11px] py-1 text-[12px] font-semibold",
        m.text,
        m.bg,
        m.border
      )}
    >
      <StatusDot tone={m.dot} size={7} glow={false} />
      {m.label}
    </span>
  )
}

/** A single PR label chip, tinted with the label's own colour when known. */
function LabelChip({ label }: { label: PrLabel }) {
  if (!label.color) {
    return (
      <Badge tone="neutral" size="sm">
        {label.name}
      </Badge>
    )
  }
  const hex = `#${label.color.replace(/^#/, "")}`
  return (
    <span
      className="rounded-md px-[9px] py-0.5 text-[10.5px]"
      style={{ color: hex, backgroundColor: `${hex}22` }}
    >
      {label.name}
    </span>
  )
}

/**
 * One entry in the merged timeline: either a top-level review / issue comment,
 * or a group of inline threads opened by a single review.
 */
type FeedEntry =
  | { kind: "item"; at: string; item: PrTimelineItem }
  | { kind: "threads"; at: string; id: string; threads: ReadonlyArray<PrReviewThread> }

/**
 * Merge top-level timeline items and inline review threads into one
 * chronological feed, so a review's threads appear at the moment the review was
 * submitted rather than in a separate block.
 *
 * Threads are grouped by the review that opened them; a thread whose `reviewId`
 * is null (GitHub occasionally reports none) stands alone under its own header,
 * keyed by thread id so it can't collide with a real review group.
 */
const buildFeed = (pr: PullRequest): ReadonlyArray<FeedEntry> => {
  const groups = new Map<string, Array<PrReviewThread>>()
  for (const thread of pr.reviewThreads) {
    const key = thread.reviewId ?? `thread:${thread.id}`
    const existing = groups.get(key)
    if (existing) existing.push(thread)
    else groups.set(key, [thread])
  }

  const entries: Array<FeedEntry> = [
    ...pr.timeline.map((item) => ({ kind: "item" as const, at: item.createdAt, item })),
    ...[...groups].flatMap(([id, threads]) => {
      // The group sits at its earliest comment — when the review landed.
      const at = threads
        .flatMap((t) => t.comments.map((c) => c.createdAt))
        .reduce<string | null>((min, c) => (min === null || c < min ? c : min), null)
      return at === null ? [] : [{ kind: "threads" as const, at, id, threads }]
    })
  ]

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

export interface PullRequestViewProps {
  pr: PullRequest | null
  connected: boolean
  busy?: boolean
  /** The authenticated GitHub login — to detect the viewer's own PR (no self-approve). */
  viewerLogin?: string | null
  /** A failed `gh pr create`, shown in the empty state (e.g. "already exists"). */
  createError?: string | null
  /** The owning session's title, for the "routed to <session>" copy. */
  sessionTitle?: string
  onCreatePr?: () => Promise<void> | void
  onConnectGithub?: () => void
  onSubmitReview?: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void> | void
  onSendEntryToAgent?: (entryId: string) => Promise<void> | void
  /** Timeline entry ids already routed to the agent — their action stays "Sent". */
  sentEntryIds?: ReadonlySet<string>
  /** Resolve / unresolve an inline review thread. */
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<void> | void
  /** Reply into an inline review thread (`commentId` = the REST databaseId). */
  onReplyToThread?: (commentId: number, body: string) => Promise<void> | void
  onOpenOnGithub?: () => void
  onMerge?: () => void
  /** A merge is in flight — disables the button and shows a spinner. */
  merging?: boolean
  /** A failed `gh pr merge`, shown beneath the merge button. */
  mergeError?: string | null
  /** Flip a draft PR to ready for review (shown only while the PR is a draft). */
  onMarkReady?: () => void
  /** A mark-ready is in flight — disables the button and shows a spinner. */
  markingReady?: boolean
  /** A failed `gh pr ready`, shown beneath the button. */
  markReadyError?: string | null
}

/**
 * The Pull Request tab — PR header, review timeline, and a sticky review composer
 * in the centre column, with reviewers / checks / merge state in the right rail.
 * Pure presentational: all data + actions come through props.
 */
export function PullRequestView({
  pr,
  connected,
  busy = false,
  viewerLogin,
  createError,
  onCreatePr,
  onConnectGithub,
  onSubmitReview,
  onSendEntryToAgent,
  sentEntryIds,
  onResolveThread,
  onReplyToThread,
  onOpenOnGithub,
  onMerge,
  merging = false,
  mergeError,
  onMarkReady,
  markingReady = false,
  markReadyError
}: PullRequestViewProps) {
  // Loading — avoid flashing the "Create PR" empty state before the PR resolves.
  if (pr === null && busy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner size={20} />
        <span className="text-[13px]">Loading pull request…</span>
      </div>
    )
  }
  if (pr === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-surface text-dim">
          <GitPullRequest size={26} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-balance text-[15px] font-semibold text-text-bright">
            No pull request yet for this branch
          </h2>
          <p className="max-w-xs text-[13px] text-muted-foreground">
            Open a pull request to run CI, collect reviews, and route feedback back to the agent.
          </p>
        </div>
        {connected ? (
          <div className="flex w-full max-w-sm flex-col items-center gap-3">
            <AsyncButton
              size="md"
              icon={<GitPullRequest size={14} />}
              pendingLabel="Opening…"
              successLabel="Opened"
              disabled={busy}
              onClick={() => onCreatePr?.()}
            >
              Create pull request
            </AsyncButton>
            {createError && <Callout tone="red">{createError}</Callout>}
          </div>
        ) : (
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Callout tone="blue">Connect GitHub to create and review pull requests.</Callout>
            <Button variant="secondary" className="self-center" onClick={onConnectGithub}>
              Connect GitHub
            </Button>
          </div>
        )}
      </div>
    )
  }

  // Not memoized: the early returns above rule out a hook here, and this is a
  // map + sort over a handful of entries.
  const feed = buildFeed(pr)

  return (
    <div className="flex min-h-0 flex-1">
      {/* Centre column: header + timeline + sticky composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-[18px] overflow-auto px-7 py-6">
          {/* PR header */}
          <div className="flex flex-col gap-[11px]">
            <div className="flex items-center gap-[9px]">
              <StatePill state={pr.state} />
              <span className="font-mono text-[12px] text-dim">#{pr.number}</span>
              <div className="flex-1" />
              {onOpenOnGithub && (
                <button
                  type="button"
                  onClick={onOpenOnGithub}
                  className="font-mono text-[11px] text-dim hover:text-text"
                >
                  Open on GitHub ↗
                </button>
              )}
            </div>
            <h2 className="text-pretty text-[20px] font-bold tracking-[-0.2px] text-text-bright">
              {pr.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-[10px] gap-y-1.5 font-mono text-[11.5px] text-muted-foreground">
              <Badge tone="neutral" size="sm">
                {pr.headRefName} → {pr.baseRefName}
              </Badge>
              <DiffStat added={pr.additions} removed={pr.deletions} />
              <span className="text-line">|</span>
              <span>{pr.commits} commits</span>
              <span className="text-line">·</span>
              <span>{pr.changedFiles} files</span>
              <span className="text-line">·</span>
              <span>
                opened {relativeTime(pr.createdAt)} by {pr.author.login}
              </span>
            </div>
            {pr.labels.length > 0 && (
              <div className="flex flex-wrap gap-[7px]">
                {pr.labels.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))}
              </div>
            )}
          </div>

          <div className="h-px bg-line" />

          {/* Timeline — top-level reviews/comments and inline thread groups, interleaved */}
          {feed.length === 0 ? (
            <p className="text-[13px] text-dim">No reviews or comments yet.</p>
          ) : (
            feed.map((entry) =>
              entry.kind === "item" ? (
                <PrTimelineEntry
                  key={entry.item.id}
                  item={entry.item}
                  sent={sentEntryIds?.has(entry.item.id)}
                  onSendToAgent={onSendEntryToAgent}
                />
              ) : (
                <PrReviewGroup
                  key={entry.id}
                  threads={entry.threads}
                  prAuthor={pr.author.login}
                  sentEntryIds={sentEntryIds}
                  onSendToAgent={onSendEntryToAgent}
                  onResolve={onResolveThread}
                  onReply={onReplyToThread}
                />
              )
            )
          )}

          {/* Sticky review composer */}
          <div className="sticky bottom-0 mt-auto pt-2">
            <PrReviewComposer
              connected={connected}
              selfAuthored={Boolean(viewerLogin) && viewerLogin === pr.author.login}
              onSubmit={(input) => onSubmitReview?.(input)}
            />
          </div>
        </div>
      </div>

      {/* Right rail */}
      <PrSidePanel
        pr={pr}
        connected={connected}
        onMerge={onMerge}
        merging={merging}
        mergeError={mergeError}
        onMarkReady={onMarkReady}
        markingReady={markingReady}
        markReadyError={markReadyError}
      />
    </div>
  )
}
