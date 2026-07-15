import type { IssueSummary } from "@starbase/core"
import { CircleDot } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Spinner } from "../components/loading.js"
import { relativeTime } from "../lib/relative-time.js"

/**
 * The scrollable open-issue results list for the "new session from an issue"
 * picker + the attach-issue dialog. Pure presentational — props in, `onSelect`
 * out. Each row mirrors the design: a green circle-dot · title · #number, with
 * label chips + assignee beneath.
 */
export function IssuePickerList({
  issues,
  selected,
  onSelect,
  loading = false
}: {
  issues: ReadonlyArray<IssueSummary>
  /** The selected issue number, or null. */
  selected: number | null
  onSelect: (issue: IssueSummary) => void
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2.5 text-muted-foreground">
        <Spinner size={18} />
        <span className="text-[12px]">Loading issues…</span>
      </div>
    )
  }

  if (issues.length === 0) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2.5 px-6 text-center text-muted-foreground">
        <CircleDot size={22} className="text-line-strong" />
        <span className="text-pretty text-[12px] leading-[1.5]">
          No open issues match. Try clearing the search or the “Just mine” filter.
        </span>
      </div>
    )
  }

  return (
    <div className="flex max-h-[248px] flex-col gap-[5px] overflow-auto pr-1">
      {issues.map((issue) => {
        const on = issue.number === selected
        const assignee = issue.assignees[0]
        return (
          <button
            key={issue.number}
            type="button"
            onClick={() => onSelect(issue)}
            aria-pressed={on}
            className={cn(
              "flex w-full flex-col gap-1.5 rounded-[7px] border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-blue/55 bg-blue/10" : "border-line bg-sunken hover:border-line-strong"
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <CircleDot size={14} className="flex-none text-green" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium",
                  on ? "text-text-bright" : "text-text"
                )}
              >
                {issue.title}
              </span>
              <span className="font-mono text-[11px] text-dim">#{issue.number}</span>
            </div>
            {(issue.labels.length > 0 || assignee) && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-6 font-mono text-[10.5px] text-muted-foreground">
                {issue.labels.slice(0, 4).map((l) => (
                  <IssueLabelChip key={l.name} name={l.name} color={l.color} />
                ))}
                <span className="flex-1" />
                {assignee && (
                  <span className="flex items-center gap-1.5 text-dim">
                    <Avatar
                      initial={(assignee.login[0] ?? "?").toUpperCase()}
                      src={githubAvatarUrl(assignee.login, 32)}
                      size={15}
                    />
                    {assignee.login}
                  </span>
                )}
                {issue.updatedAt && <span className="text-line">·</span>}
                {issue.updatedAt && <span className="text-dim">{relativeTime(issue.updatedAt)}</span>}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A GitHub label chip tinted from the label's own hex colour. Reused by the
 * picker rows and the linked-issue banner.
 */
export function IssueLabelChip({ name, color }: { name: string; color: string | null }) {
  // GitHub label colors are 6-hex with no leading '#'. Fall back to a neutral
  // Badge when absent so the chip never renders with a broken colour.
  if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) {
    return (
      <Badge tone="neutral" size="xs">
        {name}
      </Badge>
    )
  }
  const r = parseInt(color.slice(0, 2), 16)
  const g = parseInt(color.slice(2, 4), 16)
  const b = parseInt(color.slice(4, 6), 16)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-px text-[10.5px] font-medium"
      style={{
        color: `rgb(${r} ${g} ${b})`,
        backgroundColor: `rgb(${r} ${g} ${b} / 0.12)`,
        borderColor: `rgb(${r} ${g} ${b} / 0.3)`
      }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: `rgb(${r} ${g} ${b})` }}
      />
      {name}
    </span>
  )
}
