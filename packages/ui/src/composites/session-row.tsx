import { useState } from "react"
import type { Session, SessionStatus } from "@starbase/core"
import { GitMerge } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { statusLabel, statusTextClass } from "../tokens.js"

/** A session row for the sidebar list. Active state gets the blue ring. */
export function SessionRow({
  session,
  status: statusOverride,
  active = false,
  onSelect,
  onRename,
  className
}: {
  session: Session
  /** Live status while the agent runs; falls back to the persisted status. */
  status?: SessionStatus
  active?: boolean
  onSelect?: (id: string) => void
  /** Manual rename (double-click the title) — pins the auto-generated name. */
  onRename?: (id: string, title: string) => void
  className?: string
}) {
  const status = statusOverride ?? session.status
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const next = draft.trim()
    if (next.length > 0 && next !== session.title) onRename?.(session.id, next)
    setDraft(null)
  }

  // Archived variant (A2 in the design): purple git-merge mark, muted title, a
  // Merged/Closed pill, and how long ago it was archived. Read-only — no status.
  if (session.archived) {
    const closed = session.archiveReason === "closed"
    return (
      <div
        onClick={() => onSelect?.(session.id)}
        className={cn(
          "flex cursor-pointer flex-col gap-[6px] rounded-lg border px-2.5 py-2 transition-colors",
          active ? "border-blue/[0.32] bg-surface" : "border-transparent hover:bg-surface/40",
          className
        )}
      >
        <div className="flex items-center gap-2">
          <GitMerge size={13} className={cn("flex-none", closed ? "text-red" : "text-purple")} />
          <span
            className={cn(
              "flex-1 truncate text-[13px]",
              active ? "font-medium text-text" : "text-muted-foreground"
            )}
          >
            {session.title}
          </span>
        </div>
        <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
          <Badge tone={closed ? "red" : "purple"} size="sm">
            {closed ? "Closed" : "Merged"}
            {session.prNumber !== null ? ` #${session.prNumber}` : ""}
          </Badge>
          <div className="flex-1" />
          {session.archivedAt && <span>{relativeTime(session.archivedAt)}</span>}
        </div>
      </div>
    )
  }

  const idle = status === "idle"
  const hasMeta = session.prNumber !== null || session.diff.added > 0 || session.diff.removed > 0
  return (
    <div
      onClick={() => onSelect?.(session.id)}
      className={cn(
        "flex cursor-pointer flex-col gap-[7px] rounded-lg border px-2.5 py-2 transition-colors",
        active
          ? "border-blue/[0.32] bg-surface"
          : "border-transparent hover:bg-surface/40",
        idle && !active && "opacity-55",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        {draft !== null ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              else if (e.key === "Escape") setDraft(null)
            }}
            onBlur={commit}
            className="flex-1 rounded border border-blue/50 bg-editor px-1 py-px text-[13px] text-text-bright outline-none"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (onRename) setDraft(session.title)
            }}
            title={onRename ? "Double-click to rename" : undefined}
            className={cn(
              "flex-1 truncate text-[13px]",
              active ? "font-semibold text-text-bright" : "font-medium text-text"
            )}
          >
            {session.title}
          </span>
        )}
        {/* The harness in use, so it's visible at a glance in the list. */}
        <ProviderIcon cli={session.cli} size={13} />
      </div>
      <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
        <span className={cn(active ? "text-blue" : "text-muted-foreground")}>{session.branch}</span>
        <div className="flex-1" />
        <span className={statusTextClass[status]}>{statusLabel[status]}</span>
      </div>
      {hasMeta && (
        <div className="flex items-center gap-1.5">
          {session.prNumber !== null && (
            <Badge tone="neutral" size="sm">
              ⑂ #{session.prNumber}
            </Badge>
          )}
          <DiffStat added={session.diff.added} removed={session.diff.removed} />
        </div>
      )}
    </div>
  )
}
