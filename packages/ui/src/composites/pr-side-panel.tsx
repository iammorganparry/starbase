import { useState } from "react"
import type { PrMergeMethod, PrReviewer, PrReviewKind, PullRequest } from "@starbase/core"
import type { BadgeProps } from "../components/badge.js"
import { cn } from "../lib/cn.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Spinner } from "../components/loading.js"
import { PrCheckRow } from "./pr-check-row.js"
import { ReviewFindings, type ReviewFindingsProps } from "./review-findings.js"

/** Reviewer state → Badge tone + label. */
const reviewerBadge: Record<PrReviewKind, { tone: BadgeProps["tone"]; label: string }> = {
  approved: { tone: "green", label: "approved" },
  changes_requested: { tone: "red", label: "changes requested" },
  commented: { tone: "blue", label: "commented" },
  pending: { tone: "count", label: "pending" }
}

/**
 * The three merge strategies, with the button label each one arms.
 *
 * The label changes with the choice rather than staying "Merge pull request":
 * these are not interchangeable — squash rewrites the branch into one commit and
 * rebase discards the merge commit — so the button has to say which is about to
 * happen. GitHub does the same, for the same reason.
 */
const MERGE_METHODS: ReadonlyArray<{
  method: PrMergeMethod
  label: string
  action: string
  hint: string
}> = [
  {
    method: "merge",
    label: "Merge",
    action: "Merge pull request",
    hint: "Keep all commits and add a merge commit"
  },
  {
    method: "squash",
    label: "Squash",
    action: "Squash and merge",
    hint: "Combine every commit into one on the base branch"
  },
  {
    method: "rebase",
    label: "Rebase",
    action: "Rebase and merge",
    hint: "Replay each commit onto the base, with no merge commit"
  }
]

function ReviewerRow({ reviewer }: { reviewer: PrReviewer }) {
  const meta = reviewerBadge[reviewer.state]
  return (
    <div className="flex items-center gap-[9px]">
      <Avatar
        initial={reviewer.login.charAt(0).toUpperCase()}
        src={githubAvatarUrl(reviewer.login)}
        tone="dim"
        size={22}
      />
      <span className="flex-1 text-[13px] text-text-bright">{reviewer.login}</span>
      <Badge tone={meta.tone} size="sm">
        {meta.label}
      </Badge>
    </div>
  )
}

/**
 * The Pull Request right rail — reviewers, CI checks, and the merge box. Read-only
 * except for the merge action (enabled only when connected and unblocked).
 */
export interface PrSidePanelProps {
  pr: PullRequest
  connected: boolean
  /** Merge with the chosen strategy — the picker below decides which. */
  onMerge?: (method: PrMergeMethod) => void
  merging?: boolean
  mergeError?: string | null
  onMarkReady?: () => void
  markingReady?: boolean
  markReadyError?: string | null
  /** Merge the base into the head — offered only while the branch is behind. */
  onUpdateBranch?: () => void
  updatingBranch?: boolean
  updateBranchError?: string | null
  /**
   * The adversarial review panel's state + actions. Omitted in contexts that
   * don't offer a review (e.g. a story showing the bare PR rail). `canRun` is
   * derived here from the PR's own state, so callers can't offer a review of a
   * merged/closed PR by accident.
   */
  review?: Omit<ReviewFindingsProps, "canRun">
  /**
   * The rail's width in px. Was a hard `w-[352px]` — which, in a 500px pane,
   * left the PR body about 88px of reading column after its own 60px gutters.
   */
  width?: number
  /** Extra classes — how the caller turns the rail into a floating sheet. */
  className?: string
}

export function PrSidePanel({
  pr,
  connected,
  onMerge,
  merging = false,
  mergeError,
  onMarkReady,
  markingReady = false,
  markReadyError,
  onUpdateBranch,
  updatingBranch = false,
  updateBranchError,
  review,
  width = 352,
  className
}: PrSidePanelProps) {
  // Merge-commit default, matching `gh pr merge` and the previous hardcoded
  // behaviour — a picker that silently changed what the button did would be a
  // worse regression than not having one.
  const [method, setMethod] = useState<PrMergeMethod>("merge")
  const failing = pr.checks.filter((c) => c.status === "fail").length
  const blocked = pr.mergeBlockers.length > 0
  const behind = pr.mergeStateStatus === "BEHIND"
  const merged = pr.state === "merged"
  const closed = pr.state === "closed"
  const draft = pr.state === "draft"

  return (
    // The panel itself no longer scrolls. Only the sections ABOVE the merge box
    // do, so the merge action stays pinned to the bottom and reachable at any
    // scroll position — a long adversarial review used to push it off-screen,
    // which is exactly when you most want to merge.
    <div
      style={{ width }}
      className={cn(
        "flex flex-none flex-col overflow-hidden border-l border-hairline bg-panel",
        className
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/* Reviewers */}
      <div className="flex flex-none flex-col gap-[11px] border-b border-hairline p-4">
        <Eyebrow>Reviewers</Eyebrow>
        {pr.reviewers.length === 0 ? (
          <span className="text-[12px] text-dim">No reviewers yet</span>
        ) : (
          pr.reviewers.map((r) => <ReviewerRow key={r.login} reviewer={r} />)
        )}
      </div>

      {/* Checks */}
      <div className="flex flex-none flex-col gap-3 border-b border-hairline p-4">
        <div className="flex items-center gap-2">
          <Eyebrow className="flex-1">Checks</Eyebrow>
          {failing > 0 && (
            <span className="font-mono text-[10.5px] text-red">{failing} failing</span>
          )}
        </div>
        {pr.checks.length === 0 ? (
          <span className="text-[12px] text-dim">No checks reported</span>
        ) : (
          pr.checks.map((c) => <PrCheckRow key={c.name} check={c} />)
        )}
      </div>

      {/* Adversarial review */}
      {review && (
        <div className="flex flex-none flex-col gap-3 border-b border-hairline p-4">
          <div className="flex items-center gap-2">
            <Eyebrow className="flex-1">Adversarial review</Eyebrow>
            {review.review && review.review.findings.length > 0 && (
              <span className="font-mono text-[10.5px] text-dim">
                {review.review.findings.length}{" "}
                {review.review.findings.length === 1 ? "finding" : "findings"}
              </span>
            )}
          </div>
          {/* A review needs a live PR to argue against — merged/closed PRs are
              history, and re-reviewing them just burns tokens. */}
          <ReviewFindings {...review} canRun={connected && !merged && !closed} />
        </div>
      )}

      </div>

      {/* Merge box — outside the scroll container, so it's always in reach. */}
      <div className="flex-none border-t border-hairline bg-panel p-4">
        {merged ? (
          <Callout tone="purple">This pull request has been merged.</Callout>
        ) : closed ? (
          <Callout tone="red">This pull request is closed.</Callout>
        ) : draft ? (
          <div className="flex flex-col gap-3">
            <Callout tone="blue">This pull request is a draft. Mark it ready to request review.</Callout>
            <Button
              className="w-full justify-center gap-2"
              disabled={!connected || markingReady || !onMarkReady}
              onClick={onMarkReady}
            >
              {markingReady && <Spinner size={13} />}
              {markingReady ? "Marking ready…" : "Ready for review"}
            </Button>
            {markReadyError && (
              <Callout tone="red" className="items-start">
                {markReadyError}
              </Callout>
            )}
          </div>
        ) : blocked ? (
          <div className="overflow-hidden rounded-lg border border-red/30">
            <div className="flex items-center gap-[9px] border-b border-hairline bg-red/[0.06] px-[13px] py-[10px]">
              <span className="flex size-5 flex-none items-center justify-center rounded-full bg-red/20 text-[12px] text-red">
                !
              </span>
              <span className="text-[13px] font-semibold text-text-bright">Merging blocked</span>
            </div>
            <div className="flex flex-col gap-1.5 px-[13px] py-[11px]">
              {pr.mergeBlockers.map((blocker) => (
                <span key={blocker} className="flex items-center gap-2 text-[12px] text-text">
                  <span className="text-red">✗</span>
                  {blocker}
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-2 px-[13px] pb-[13px]">
              {/*
                "Out of date" is the ONE blocker the operator can clear from here
                — conflicts need the code, branch protection needs a reviewer,
                failing checks need a fix. `mergeStateStatus` was fetched all
                along and only ever collapsed into a blocker STRING, so the box
                stated the problem and offered nothing. This updates the remote
                head only; the worktree is left alone, since the agent may be
                mid-turn with uncommitted work.
              */}
              {behind && onUpdateBranch && (
                <Button
                  variant="secondary"
                  className="w-full justify-center gap-2"
                  disabled={!connected || updatingBranch}
                  onClick={onUpdateBranch}
                >
                  {updatingBranch && <Spinner size={13} />}
                  {updatingBranch ? "Updating…" : "Update branch"}
                </Button>
              )}
              {updateBranchError && (
                <Callout tone="red" className="items-start">
                  {updateBranchError}
                </Callout>
              )}
              <Button variant="secondary" className="w-full justify-center" disabled>
                Merge pull request
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Callout tone="green">This branch has no conflicts and can be merged.</Callout>
            {/*
              The strategy picker. `PrMergeMethod` and `gh pr merge --<method>`
              supported all three from the start; only the UI didn't, so every
              merge from here was a merge commit. Squash is most teams' default,
              which made this the likeliest reason to give up and open the
              browser. Segmented rather than a dropdown: three options, and which
              one is armed must be readable without opening anything.
            */}
            <div
              role="radiogroup"
              aria-label="Merge method"
              className="flex overflow-hidden rounded-md border border-line"
            >
              {MERGE_METHODS.map((m) => (
                <button
                  key={m.method}
                  type="button"
                  role="radio"
                  aria-checked={method === m.method}
                  title={m.hint}
                  disabled={merging}
                  onClick={() => setMethod(m.method)}
                  className={cn(
                    "flex-1 px-2 py-[5px] text-[11.5px] transition-colors disabled:pointer-events-none",
                    method === m.method
                      ? "bg-surface text-text-bright"
                      : "text-dim hover:bg-surface/50 hover:text-text"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Button
              className="w-full justify-center gap-2"
              disabled={!connected || merging || !onMerge}
              onClick={() => onMerge?.(method)}
            >
              {merging && <Spinner size={13} />}
              {merging ? "Merging…" : MERGE_METHODS.find((m) => m.method === method)!.action}
            </Button>
            {mergeError && (
              <Callout tone="red" className="items-start">
                {mergeError}
              </Callout>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
