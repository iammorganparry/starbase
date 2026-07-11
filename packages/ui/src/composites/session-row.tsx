import type { Session } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { statusLabel, statusTextClass } from "../tokens.js"

/** A session row for the sidebar list. Active state gets the blue ring. */
export function SessionRow({
  session,
  active = false,
  onSelect,
  className
}: {
  session: Session
  active?: boolean
  onSelect?: (id: string) => void
  className?: string
}) {
  const idle = session.status === "idle"
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
        <StatusDot status={session.status} />
        <span
          className={cn(
            "flex-1 truncate text-[13px]",
            active ? "font-semibold text-text-bright" : "font-medium text-text"
          )}
        >
          {session.title}
        </span>
      </div>
      <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
        <span className={cn(active ? "text-blue" : "text-muted-foreground")}>{session.branch}</span>
        <div className="flex-1" />
        <span className={statusTextClass[session.status]}>{statusLabel[session.status]}</span>
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
