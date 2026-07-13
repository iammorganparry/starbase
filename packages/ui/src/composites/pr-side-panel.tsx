import type { PrReviewer, PrReviewKind, PullRequest } from "@starbase/core"
import type { BadgeProps } from "../components/badge.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Spinner } from "../components/loading.js"
import { PrCheckRow } from "./pr-check-row.js"

/** Reviewer state → Badge tone + label. */
const reviewerBadge: Record<PrReviewKind, { tone: BadgeProps["tone"]; label: string }> = {
  approved: { tone: "green", label: "approved" },
  changes_requested: { tone: "red", label: "changes requested" },
  commented: { tone: "blue", label: "commented" },
  pending: { tone: "count", label: "pending" }
}

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
export function PrSidePanel({
  pr,
  connected,
  onMerge,
  merging = false,
  mergeError
}: {
  pr: PullRequest
  connected: boolean
  onMerge?: () => void
  merging?: boolean
  mergeError?: string | null
}) {
  const failing = pr.checks.filter((c) => c.status === "fail").length
  const blocked = pr.mergeBlockers.length > 0
  const merged = pr.state === "merged"
  const closed = pr.state === "closed"

  return (
    <div className="flex w-[352px] flex-none flex-col overflow-auto border-l border-hairline bg-panel">
      {/* Reviewers */}
      <div className="flex flex-col gap-[11px] border-b border-hairline p-4">
        <Eyebrow>Reviewers</Eyebrow>
        {pr.reviewers.length === 0 ? (
          <span className="text-[12px] text-dim">No reviewers yet</span>
        ) : (
          pr.reviewers.map((r) => <ReviewerRow key={r.login} reviewer={r} />)
        )}
      </div>

      {/* Checks */}
      <div className="flex flex-col gap-3 border-b border-hairline p-4">
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

      {/* Merge box */}
      <div className="p-4">
        {merged ? (
          <Callout tone="purple">This pull request has been merged.</Callout>
        ) : closed ? (
          <Callout tone="red">This pull request is closed.</Callout>
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
            <div className="px-[13px] pb-[13px]">
              <Button variant="secondary" className="w-full justify-center" disabled>
                Merge pull request
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Callout tone="green">This branch has no conflicts and can be merged.</Callout>
            <Button
              className="w-full justify-center gap-2"
              disabled={!connected || merging || !onMerge}
              onClick={onMerge}
            >
              {merging && <Spinner size={13} />}
              {merging ? "Merging…" : "Merge pull request"}
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
