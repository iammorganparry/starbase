import { useState } from "react"
import type { ReactNode } from "react"
import type { Session, SessionActivity } from "@starbase/core"
import { activityLabel, displayStatusOf } from "@starbase/core"
import { Archive, ArchiveRestore, GitMerge, type LucideIcon, Trash2 } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { displayStatusLabel, displayStatusTone, statusTextClass } from "../tokens.js"

/** A session row for the sidebar list. Active state gets the blue ring. */
export function SessionRow({
  session,
  activity,
  active = false,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  className
}: {
  session: Session
  /**
   * What the agent is doing right now ("Running npm test"). Absent → the row
   * falls back to the persisted `session.status`.
   */
  activity?: SessionActivity
  active?: boolean
  onSelect?: (id: string) => void
  /** Manual rename (double-click the title) — pins the auto-generated name. */
  onRename?: (id: string, title: string) => void
  /** Archive an active session (collapses into the Archived group; undoable). */
  onArchive?: (id: string) => void
  /** Restore an archived session back to active. */
  onRestore?: (id: string) => void
  /** Permanently delete a session (the caller confirms first). */
  onDelete?: (id: string) => void
  className?: string
}) {
  // One rollup, three jobs: what the row says, what colour it says it in, and
  // whether it dims. The label is one of five words — never the tool or target.
  const display = displayStatusOf(activity, session.status)
  const status = displayStatusTone[display]
  const label = displayStatusLabel[display]
  // The detail the label no longer shows ("Running npm test -- auth") survives on
  // hover. It's genuinely useful when you want it, and it was the reason the
  // label used to be unbounded — a title attribute gives it a home that can't
  // push the branch name out of the row.
  const detail = activity ? activityLabel(activity) : label
  const [draft, setDraft] = useState<string | null>(null)

  // Quick actions — archive/restore + delete — surfaced on hover and via a
  // right-click context menu. The action set depends on whether it's archived.
  const actions: ContextMenuItem[] = [
    ...(session.archived
      ? onRestore
        ? [{ label: "Restore", icon: ArchiveRestore, onSelect: () => onRestore(session.id) }]
        : []
      : onArchive
        ? [{ label: "Archive", icon: Archive, onSelect: () => onArchive(session.id) }]
        : []),
    ...(onDelete
      ? [
          {
            label: "Delete",
            icon: Trash2,
            tone: "danger" as const,
            separated: true,
            onSelect: () => onDelete(session.id)
          }
        ]
      : [])
  ]

  const hoverActions = actions.length > 0 && (
    <div
      className="absolute right-1.5 top-1.5 z-10 hidden items-center gap-0.5 rounded-md bg-panel/90 group-hover:flex"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Names include the title so icon-only buttons are unambiguous for screen
          readers and never collide with the archived-session banner's controls. */}
      {session.archived
        ? onRestore && (
            <RowAction
              icon={ArchiveRestore}
              label={`Restore ${session.title}`}
              onClick={() => onRestore(session.id)}
            />
          )
        : onArchive && (
            <RowAction
              icon={Archive}
              label={`Archive ${session.title}`}
              onClick={() => onArchive(session.id)}
            />
          )}
      {onDelete && (
        <RowAction
          icon={Trash2}
          label={`Delete ${session.title}`}
          danger
          onClick={() => onDelete(session.id)}
        />
      )}
    </div>
  )

  // Wrap the row in a right-click menu only when there's at least one action.
  const withMenu = (node: ReactNode) =>
    actions.length > 0 ? <ContextMenu items={actions}>{node}</ContextMenu> : node

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
    return withMenu(
      <div
        data-testid={`session-row-${session.id}`}
        onClick={() => onSelect?.(session.id)}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-[6px] rounded-lg border px-2.5 py-2 transition-colors",
          active ? "border-blue/[0.32] bg-surface" : "border-transparent hover:bg-surface/40",
          className
        )}
      >
        {hoverActions}
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

  // Off the display rollup, not the raw status, so the row that SAYS "Idle" is
  // the row that dims — including a "done" session, which folds to idle.
  const idle = display === "idle"
  const hasMeta =
    session.prNumber !== null ||
    session.issueNumber != null ||
    session.diff.added > 0 ||
    session.diff.removed > 0
  return withMenu(
    <div
      data-testid={`session-row-${session.id}`}
      onClick={() => onSelect?.(session.id)}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-[7px] rounded-lg border px-2.5 py-2 transition-colors",
        active
          ? "border-blue/[0.32] bg-surface"
          : "border-transparent hover:bg-surface/40",
        idle && !active && "opacity-55",
        className
      )}
    >
      {hoverActions}
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
        <span className={cn("min-w-0 truncate", active ? "text-blue" : "text-muted-foreground")}>
          {session.branch}
        </span>
        <div className="flex-1" />
        {/*
          One of five fixed words, so it needs no width cap and cannot ellipsize —
          the branch beside it gets all the room the label used to take. `detail`
          carries what the label dropped, on hover.
        */}
        <span title={detail} className={cn("flex-none", statusTextClass[status])}>
          {label}
        </span>
      </div>
      {hasMeta && (
        <div className="flex items-center gap-1.5">
          {session.issueNumber != null && (
            <Badge tone="green" size="sm">
              ◉ #{session.issueNumber}
            </Badge>
          )}
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

/** A compact icon button in a row's hover action bar. */
function RowAction({
  icon: Icon,
  label,
  danger = false,
  onClick
}: {
  icon: LucideIcon
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        danger
          ? "text-muted-foreground hover:bg-red/10 hover:text-red"
          : "text-muted-foreground hover:bg-surface hover:text-text-bright"
      )}
    >
      <Icon size={13} />
    </button>
  )
}
