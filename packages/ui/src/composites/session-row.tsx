import { useState } from "react"
import type { DragEvent, ReactNode } from "react"
import { motion } from "motion/react"
import { SPRING } from "../lib/motion.js"
import { SESSION_DND_MIME } from "../app/split-layout.js"
import type { SessionPrStatus, Session, SessionActivity } from "@starbase/core"
import { activityLabel, displayStatusOf } from "@starbase/core"
import { Archive, ArchiveRestore, GitMerge, type LucideIcon, Trash2 } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { PrStatusGlyph } from "./pr-glyph.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { displayStatusLabel, displayStatusTone, statusTextClass } from "../tokens.js"

/** A session row for the sidebar list. Active state gets the blue ring. */
export function SessionRow({
  session,
  activity,
  prState,
  active = false,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  slotIndex = null,
  className
}: {
  session: Session
  /**
   * What the agent is doing right now ("Running npm test"). Absent → the row
   * falls back to the persisted `session.status`.
   */
  activity?: SessionActivity
  /**
   * Live state of the session's linked PR. A merged/closed PR badges the row
   * rather than retiring the session: one session can outlive several PRs (open
   * one, merge it, open the next off the same worktree), so merging PR #204 says
   * nothing about whether the WORK is done. Archiving is the operator's call.
   */
  /**
   * The linked PR's state + CI rollup, driving the row's leading glyph. Absent
   * (or null) for a session with no PR, which renders a hollow ring.
   */
  prState?: SessionPrStatus | null
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
  /**
   * Which grid slot this session currently occupies, or null when it isn't on
   * screen. Drives the numbered badge — the answer to "where did that one go?"
   * when four sessions are live at once.
   */
  slotIndex?: number | null
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

  /**
   * Drag props shared by both row variants. The row is the drag SOURCE for the
   * session grid; the slots downstream are the targets.
   *
   * `effectAllowed = "copyMove"` because a drop doesn't remove the session from
   * the sidebar — the row stays put and simply gains a slot badge.
   */
  const dragProps = {
    // Never while renaming: in Chromium a `draggable` ancestor swallows
    // press-and-drag inside a descendant text input, so selecting part of the
    // title would start dragging the row instead.
    draggable: draft === null,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(SESSION_DND_MIME, session.id)
      e.dataTransfer.effectAllowed = "copyMove"
    }
  }

  /**
   * The numbered badge marking a session that's live in the grid. 1-based for
   * display — the operator counts panes from one, even though slots are indexed
   * from zero everywhere in the model.
   */
  const slotBadge =
    slotIndex == null ? null : (
      <span
        data-testid={`session-slot-badge-${session.id}`}
        title={`Showing in pane ${slotIndex + 1}`}
        className="flex-none"
      >
        {/* Blue, unlike the neutral `count` badges beside it: this one says "on
            screen right now", which is a different kind of fact from a PR number. */}
        <Badge tone="blue" size="xs">
          {slotIndex + 1}
        </Badge>
      </span>
    )

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
        {...dragProps}
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
          {slotBadge}
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
    // The motion element is a WRAPPER rather than the row itself because
    // `motion.div` claims `onDragStart` for its own pan gesture, whose signature
    // is incompatible with the HTML5 drag handler this row needs to be a drag
    // source. Wrapping keeps both: motion owns the box, the inner div owns the
    // drag.
    //
    // `layoutId` pairs this row with the same session's SEGMENT inside a
    // `SplitRow` pill. When the session is dragged into a split (or separated
    // back out) `motion` matches the two elements across the unmount and tweens
    // between their boxes, so the row visibly travels into the pill instead of
    // vanishing here and appearing there. The id must match `split-row.tsx`.
    //
    // An ARCHIVED row carries no id at all. Archiving evicts a session from its
    // split (see the prune in `use-split-layout`), so an archived row has no
    // segment left to morph with — and an id with no counterpart is pure risk:
    // if a stale persisted workspace ever named an archived session, both
    // elements would mount with the same id for a frame, which is undefined in
    // motion and can snap either one to the other's box.
    <motion.div
      layoutId={session.archived ? undefined : `session-${session.id}`}
      layout
      transition={SPRING}
    >
    <div
      data-testid={`session-row-${session.id}`}
      {...dragProps}
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
        {/*
          The leading slot shows the PR, not the agent.
          
          Both were candidates and the PR won on scan value: what the agent is
          doing changes every few seconds and is already spelled out as a WORD on
          the line below ("Running", "Needs Input"), where it can't be mistaken
          for anything else. Where a PR stands changes a few times a day and had
          no at-a-glance representation at all — you had to open the row's third
          line to find it. Two coloured dots would also have collided: a red
          activity dot and a red CI glyph mean entirely different things.
        */}
        <PrStatusGlyph pr={prState} />
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
        {slotBadge}
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
            // The badge is now just the NUMBER — a thing you click and quote.
            // Its state words moved to the leading glyph, which says the same
            // thing higher up the row and without spending a line on it.
            <Badge
              tone={
                prState?.state === "merged" ? "purple" : prState?.state === "closed" ? "red" : "neutral"
              }
              size="sm"
            >
              ⑂ #{session.prNumber}
            </Badge>
          )}
          <DiffStat added={session.diff.added} removed={session.diff.removed} />
        </div>
      )}
    </div>
    </motion.div>
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
