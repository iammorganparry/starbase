import { type DragEvent, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import type { Session, SessionActivity } from "@starbase/core"
import { displayStatusOf } from "@starbase/core"
import { Columns2, Scissors, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { displayStatusLabel, displayStatusTone } from "../tokens.js"
import { StatusDot } from "../components/status-dot.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { PEEK_DELAY_MS, peekVariants, SPRING } from "../lib/motion.js"
import { MAX_PANES, SESSION_DND_MIME, type SplitGroup } from "../app/split-layout.js"

/**
 * A split, as ONE sidebar row.
 *
 * This is the shape Arc uses and the reason its sidebar stays legible with a
 * split open: the two tabs collapse into a single rounded container, each half
 * carrying its own favicon and its own close ×. A split is one entry in the list
 * because a split IS one thing.
 *
 * Only used for groups of two or more — a group of one is an ordinary
 * `SessionRow`, and the caller picks. That isn't a special case dodged, it's the
 * model showing through: a one-pane group and a plain session are the same
 * object.
 *
 * The `layoutId` on each segment is what makes merging and separating read as a
 * morph. When a session moves from its own row into this pill (or back out),
 * `motion` matches the two elements by that id across the unmount and tweens
 * between their boxes, so the row visibly *travels* instead of one disappearing
 * while another appears somewhere else.
 */
export function SplitRow({
  group,
  sessions,
  liveActivity,
  active = false,
  onFocusPane,
  onClosePane,
  onSeparateAll,
  onSplitWith,
  splitCandidates = [],
  className
}: {
  group: SplitGroup
  /** Every session, so a pane id can be resolved to a title and a status. */
  sessions: ReadonlyArray<Session>
  /** What each agent is doing right now, keyed by session id. */
  liveActivity?: Record<string, SessionActivity>
  /** Whether this group is the one on screen. */
  active?: boolean
  onFocusPane?: (groupId: string, index: number) => void
  onClosePane?: (groupId: string, index: number) => void
  onSeparateAll?: (groupId: string) => void
  /** A session was dropped on the pill — merge it in at the right-hand end. */
  onSplitWith?: (groupId: string, sessionId: string, at: number) => void
  /** Sessions offered under "Split with ▸" (everything not already in here). */
  splitCandidates?: ReadonlyArray<Session>
  className?: string
}) {
  const [dropping, setDropping] = useState(false)
  const [peeking, setPeeking] = useState(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const full = group.panes.length >= MAX_PANES
  /**
   * Past two panes the sidebar is too narrow for titles: a 264px rail split four
   * ways leaves ~50px a segment, which truncates "Refactor auth flow" to "R…" —
   * a letter that identifies nothing. Arc has the same problem and answers it the
   * same way: keep the icon, drop the text. Here the status dot is the icon, the
   * hover title carries the name, and the peek card spells all of them out.
   */
  const compact = group.panes.length > 2

  useEffect(() => () => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
  }, [])

  const byId = (id: string): Session | null => sessions.find((s) => s.id === id) ?? null

  const openPeekSoon = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    // Delayed so dragging the pointer down the sidebar doesn't strobe a card at
    // every row it crosses.
    peekTimer.current = setTimeout(() => setPeeking(true), PEEK_DELAY_MS)
  }
  const closePeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    setPeeking(false)
  }

  const items: ContextMenuItem[] = [
    {
      label: "Split with",
      icon: Columns2,
      onSelect: () => {},
      // Present-but-empty renders a disabled row: at the cap, or with nothing
      // left to add, saying so beats a flyout that opens onto nothing.
      submenu: full
        ? []
        : splitCandidates.map((s) => ({
            // Keyed by session id, not by title: titles are auto-generated and
            // operator-editable, so two rows reading "Fix build" is ordinary —
            // and keying those on the label would hand React duplicate keys.
            id: s.id,
            label: s.title,
            onSelect: () => onSplitWith?.(group.id, s.id, group.panes.length)
          }))
    },
    ...(onSeparateAll
      ? [
          {
            // Arc's own wording, reached the same way — right-click the grouping.
            label: "Separate all tabs",
            icon: Scissors,
            separated: true,
            onSelect: () => onSeparateAll(group.id)
          }
        ]
      : [])
  ]

  return (
    <ContextMenu items={items}>
      <div
        className={cn("relative", className)}
        onMouseEnter={openPeekSoon}
        onMouseLeave={closePeek}
      >
        <motion.div
          layout
          transition={SPRING}
          data-testid={`split-row-${group.id}`}
          data-active={active || undefined}
          onDragOver={(e: DragEvent<HTMLDivElement>) => {
            if (!onSplitWith || full) return
            if (!Array.from(e.dataTransfer.types).includes(SESSION_DND_MIME)) return
            // preventDefault is what MARKS this as a valid drop target.
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setDropping(true)
            closePeek()
          }}
          onDragLeave={(e: DragEvent<HTMLDivElement>) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDropping(false)
          }}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            if (!onSplitWith || full) return
            e.preventDefault()
            setDropping(false)
            const sessionId = e.dataTransfer.getData(SESSION_DND_MIME)
            // Landing at the right-hand end: a drop on the ROW says "join this
            // split", with no opinion about where. Placement is what dropping on
            // a specific pane's edge is for.
            if (sessionId) onSplitWith(group.id, sessionId, group.panes.length)
          }}
          className={cn(
            "flex items-stretch gap-px overflow-hidden rounded-lg border p-px transition-colors",
            active ? "border-blue/[0.32] bg-surface" : "border-transparent bg-panel/60 hover:bg-surface/40",
            dropping && "border-blue ring-1 ring-blue"
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {group.panes.map((pane, index) => {
              const session = byId(pane.sessionId)
              if (!session) return null
              const display = displayStatusOf(liveActivity?.[session.id], session.status)
              const focused = active && index === group.focused
              return (
                <motion.div
                  key={pane.sessionId}
                  // Matched against this session's standalone `SessionRow` — this
                  // is what makes merge/separate a morph rather than a cut.
                  layoutId={`session-${pane.sessionId}`}
                  layout
                  transition={SPRING}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94 }}
                  // Segments share the row evenly rather than by pane ratio: the
                  // sidebar is ~250px wide, and a 15%-wide segment there is a
                  // sliver with no readable title. The pill says WHICH sessions
                  // are split, not how the panes are proportioned.
                  className={cn(
                    "group/seg flex min-h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-[7px] transition-colors",
                    compact ? "justify-center px-1" : "px-2",
                    focused ? "bg-editor" : "hover:bg-surface/60"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onFocusPane?.(group.id, index)}
                    // A segment is a drag SOURCE as well as a target, writing the
                    // same payload a standalone `SessionRow` does. Without this
                    // there is no gesture for taking a session back out of a
                    // split, or moving one from one split to another — the only
                    // sessions you could drag were the ones not on screen, which
                    // is exactly backwards from Arc, where the sidebar pill is
                    // the handle for the thing you are looking at.
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SESSION_DND_MIME, pane.sessionId)
                      e.dataTransfer.effectAllowed = "copyMove"
                    }}
                    data-testid={`split-segment-${pane.sessionId}`}
                    title={`${session.title} — ${displayStatusLabel[display]}`}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      compact ? "flex-none justify-center" : "flex-1"
                    )}
                  >
                    <StatusDot status={displayStatusTone[display]} size={7} />
                    {!compact && (
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[12px]",
                          focused ? "font-medium text-text" : "text-muted-foreground"
                        )}
                      >
                        {session.title}
                      </span>
                    )}
                  </button>
                  {onClosePane && (
                    <button
                      type="button"
                      // Arc: "hit the X next to either Split View Tab in the
                      // Sidebar to close it". Always visible on the focused
                      // segment, on hover otherwise — an always-on × per segment
                      // is a lot of noise in a four-way split.
                      onClick={(e) => {
                        e.stopPropagation()
                        onClosePane(group.id, index)
                      }}
                      aria-label={`Close ${session.title} pane`}
                      data-testid={`split-close-${pane.sessionId}`}
                      title="Close this pane (the session keeps running)"
                      className={cn(
                        "flex size-4 flex-none items-center justify-center rounded text-dim outline-none transition-colors hover:bg-hairline hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring",
                        // Compact segments have no room for a permanent ×; the
                        // dot alone is the whole segment, so the × arrives on
                        // hover and the peek card offers the alternative.
                        focused && !compact ? "opacity-100" : "opacity-0 group-hover/seg:opacity-100"
                      )}
                    >
                      <X size={11} />
                    </button>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </motion.div>

        {/* Arc's peek card: what's actually in this split, spelled out, for when
            the segments are too narrow to read. */}
        <AnimatePresence>
          {peeking && !dropping && (
            <motion.div
              variants={peekVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              data-testid={`split-peek-${group.id}`}
              className="absolute left-2 right-2 top-full z-40 mt-1 flex flex-col gap-1 rounded-lg border border-line bg-sunken p-2 shadow-2xl"
            >
              {group.panes.map((pane, index) => {
                const session = byId(pane.sessionId)
                if (!session) return null
                const display = displayStatusOf(liveActivity?.[session.id], session.status)
                return (
                  <button
                    key={pane.sessionId}
                    type="button"
                    onClick={() => onFocusPane?.(group.id, index)}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <StatusDot status={displayStatusTone[display]} size={7} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-body">
                      {session.title}
                    </span>
                    <span className="flex-none font-mono text-[10px] text-dim">
                      {displayStatusLabel[display]}
                    </span>
                  </button>
                )
              })}
              <div className="mt-0.5 flex items-center gap-1 border-t border-line pt-1.5">
                {onSeparateAll && (
                  <button
                    type="button"
                    onClick={() => onSeparateAll(group.id)}
                    title="Separate all tabs"
                    aria-label="Separate all tabs"
                    data-testid={`split-separate-${group.id}`}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[11px] text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Scissors size={12} />
                    Separate
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ContextMenu>
  )
}
