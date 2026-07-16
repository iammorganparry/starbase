import type { PrState, PrSummary } from "@starbase/core"
import { GitPullRequest } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"

/** State → the dot colour used on each PR row (mirrors the Pull Request tab). */
const stateDot: Record<PrState, string> = {
  open: "bg-green",
  merged: "bg-purple",
  closed: "bg-red",
  draft: "bg-line-strong"
}

/**
 * The scrollable PR results list for the "new session from a PR" picker. Pure
 * presentational — props in, `onSelect` out. Each row mirrors the Pull Request
 * tab's language (state dot · #number · title · head → base · +/− · author).
 */
export function PrPickerList({
  prs,
  selected,
  onSelect,
  loading = false
}: {
  prs: ReadonlyArray<PrSummary>
  /** The selected PR number, or null. */
  selected: number | null
  onSelect: (pr: PrSummary) => void
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2.5 text-muted-foreground">
        <Spinner size={18} />
        <span className="text-[12px]">Loading pull requests…</span>
      </div>
    )
  }

  if (prs.length === 0) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2.5 px-6 text-center text-muted-foreground">
        <GitPullRequest size={22} className="text-line-strong" />
        <span className="text-pretty text-[12px] leading-[1.5]">
          No open pull requests match. Try clearing the search or the “Just mine” filter.
        </span>
      </div>
    )
  }

  return (
    <div className="flex max-h-[248px] flex-col gap-[5px] overflow-auto pr-1">
      {prs.map((pr) => {
        const on = pr.number === selected
        return (
          <button
            key={pr.number}
            type="button"
            onClick={() => onSelect(pr)}
            aria-pressed={on}
            className={cn(
              "flex w-full flex-col gap-1.5 rounded-[7px] border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              on
                ? "border-blue/55 bg-blue/10"
                : "border-line bg-sunken hover:border-line-strong"
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot tone={stateDot[pr.state]} size={7} glow={false} />
              <span className="font-mono text-[11px] text-dim">#{pr.number}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium",
                  on ? "text-text-bright" : "text-text"
                )}
              >
                {pr.title}
              </span>
              {pr.isDraft && (
                <Badge tone="neutral" size="xs">
                  Draft
                </Badge>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
              <Badge tone="neutral" size="xs">
                {pr.headRefName} → {pr.baseRefName}
              </Badge>
              <DiffStat added={pr.additions} removed={pr.deletions} />
              <span className="flex-1" />
              <span className="flex items-center gap-1.5 text-dim">
                <Avatar
                  initial={(pr.author.login[0] ?? "?").toUpperCase()}
                  src={githubAvatarUrl(pr.author.login, 32)}
                  size={15}
                />
                {pr.author.login}
              </span>
              {pr.updatedAt && <span className="text-line">·</span>}
              {pr.updatedAt && <span className="text-dim">{relativeTime(pr.updatedAt)}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
