import type { IssueAutomations } from "@starbase/core"
import { CheckCircle2, CircleDot, ExternalLink, MessageSquare } from "lucide-react"
import { IssueLabelChip } from "./issue-picker-list.js"

export interface LinkedIssue {
  number: number
  title: string
  /** Issue web URL — opened via `onOpen`. */
  url?: string
  labels?: ReadonlyArray<{ name: string; color: string | null }>
  automations?: IssueAutomations
}

/**
 * The linked-issue banner shown at the top of a session's conversation (design
 * I4): the issue title/# with label chips, an "Open" affordance, and the active
 * automation status (progress comments / closes on merge) with an unlink action.
 * Purely presentational — reuses `IssueLabelChip`; actions are lifted to props.
 */
export function LinkedIssueBanner({
  issue,
  onOpen,
  onUnlink
}: {
  issue: LinkedIssue
  /** Open the issue in the system browser. */
  onOpen?: () => void
  /** Detach the issue from this session. */
  onUnlink?: () => void
}) {
  const auto = issue.automations
  const anyAutomation = auto?.progressComments || auto?.closeOnMerge
  return (
    <div className="overflow-hidden rounded-[7px] border border-green/30 bg-green/[0.05]">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <CircleDot size={16} className="flex-none text-green" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-text-bright">
              {issue.title}
            </span>
            <span className="flex-none font-mono text-[11px] text-muted-foreground">
              #{issue.number}
            </span>
          </div>
          {issue.labels && issue.labels.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {issue.labels.slice(0, 5).map((l) => (
                <IssueLabelChip key={l.name} name={l.name} color={l.color} />
              ))}
            </div>
          )}
        </div>
        {issue.url && onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="flex flex-none items-center gap-1.5 rounded border border-line px-2.5 py-1 font-mono text-[10px] text-blue outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open
            <ExternalLink size={11} />
          </button>
        )}
      </div>
      {(anyAutomation || onUnlink) && (
        <div className="flex items-center gap-2.5 border-t border-green/15 px-3.5 py-2 text-[11.5px] text-muted-foreground">
          {auto?.progressComments && (
            <span className="flex items-center gap-1.5">
              <MessageSquare size={12} className="text-blue" />
              Progress synced
            </span>
          )}
          {auto?.progressComments && auto?.closeOnMerge && <span className="text-line">·</span>}
          {auto?.closeOnMerge && (
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-green" />
              Closes on merge
            </span>
          )}
          <span className="flex-1" />
          {onUnlink && (
            <button
              type="button"
              onClick={onUnlink}
              className="font-mono text-[10px] text-muted-foreground outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
            >
              unlink
            </button>
          )}
        </div>
      )}
    </div>
  )
}
