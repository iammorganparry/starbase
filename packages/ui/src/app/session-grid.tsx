import { type DragEvent, type ReactNode, useEffect, useState } from "react"
import type { DiffStat, Session, SessionActivity } from "@starbase/core"
import { cn } from "../lib/cn.js"
import type { DockSide } from "./terminal-panel.js"
import {
  COLUMN_SPEC,
  columnsOf,
  type GridLayout,
  LAYOUT_LABELS,
  LAYOUT_MODES,
  type LayoutMode,
  SESSION_DND_MIME
} from "./layout-grid.js"
import { SessionPane, type ConversationPaneCtx } from "../screens/session-pane.js"

/**
 * A tiny diagram of the layout, drawn from its column spec.
 *
 * Generated rather than picked from an icon set: the shapes are asymmetric
 * (`2|1` vs `1|2`) and no icon library distinguishes those two, which are
 * precisely the pair the operator most needs to tell apart at a glance. Deriving
 * it also means a new mode gets a correct glyph for free.
 */
function LayoutGlyph({ mode }: { mode: LayoutMode }) {
  const spec = COLUMN_SPEC[mode]
  const SIZE = 14
  const GAP = 1.5
  const colWidth = (SIZE - GAP * (spec.length - 1)) / spec.length
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-3.5" aria-hidden="true">
      {spec.flatMap((rows, col) => {
        const rowHeight = (SIZE - GAP * (rows - 1)) / rows
        return Array.from({ length: rows }, (_, row) => (
          <rect
            key={`${col}-${row}`}
            x={col * (colWidth + GAP)}
            y={row * (rowHeight + GAP)}
            width={colWidth}
            height={rowHeight}
            rx={1}
            fill="currentColor"
          />
        ))
      })}
    </svg>
  )
}

/** The app-level grid shape picker. Lives in the title bar, not in a pane. */
export function LayoutPicker({
  mode,
  onChange
}: {
  mode: LayoutMode
  onChange: (mode: LayoutMode) => void
}) {
  return (
    <div className="flex items-center gap-0.5" data-testid="layout-picker">
      {LAYOUT_MODES.map((m) => {
        const isActive = m === mode
        return (
          <button
            key={m}
            type="button"
            title={LAYOUT_LABELS[m]}
            aria-label={LAYOUT_LABELS[m]}
            aria-pressed={isActive}
            data-testid={`layout-mode-${m}`}
            onClick={() => onChange(m)}
            className={cn(
              "flex size-6 items-center justify-center rounded outline-none transition-colors",
              isActive ? "bg-panel text-blue" : "text-dim hover:bg-panel hover:text-text"
            )}
          >
            <LayoutGlyph mode={m} />
          </button>
        )
      })}
    </div>
  )
}

/** What a slot shows when nothing has been dropped into it yet. */
function EmptySlot({ index }: { index: number }) {
  return (
    <div
      data-testid={`grid-slot-empty-${index}`}
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 text-[12px] text-dim"
    >
      <span className="rounded-md border border-dashed border-hairline px-4 py-3">
        Drag a session here
      </span>
    </div>
  )
}

/**
 * Whether a drag carries one of our session rows.
 *
 * Checks `types`, not the value: during `dragover` the spec blanks
 * `getData` (so a page can't snoop on what's being dragged over it), and only
 * `types` is readable. Getting this wrong means either accepting file drops or
 * rejecting every session drop.
 */
const carriesSession = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(SESSION_DND_MIME)

export interface SessionGridProps {
  layout: GridLayout
  sessions: ReadonlyArray<Session>
  /** Move the focus ring (and, downstream, singleton ownership) to a slot. */
  onFocusSlot: (slot: number) => void
  /** A session was dropped onto a slot. Absent → the grid is read-only. */
  onAssignSlot?: (slot: number, sessionId: string) => void
  /** Empty a slot without touching the session behind it. */
  onClearSlot?: (slot: number) => void
  /** Everything a pane needs to render one session. */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  conversationPane?: ReactNode
  planSessions?: ReadonlySet<string>
  liveActivity?: Record<string, SessionActivity>
  liveDiff?: Record<string, DiffStat>
  onOpenSettings?: () => void
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderIssue?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderTerminalDock?: (session: Session) => ReactNode
  terminalDockSide?: DockSide
  renderBrowserDock?: (session: Session | null) => ReactNode
  browserDockSide?: DockSide
  onToggleBrowser?: () => void
  browserActive?: boolean
}

/**
 * The session grid — one `SessionPane` per filled slot.
 *
 * Nested flex (a row of columns, each a column of panes) rather than a CSS grid,
 * because the layouts are asymmetric: `2|1` splits only its LEFT column, which a
 * uniform `grid-cols-2 grid-rows-2` cannot express without spanning tricks. A
 * column of flex children says the same thing directly.
 *
 * Slots are keyed by INDEX and the pane inside is deliberately unkeyed, so a slot
 * that swaps session keeps its `SessionPane` mounted and therefore keeps its tab
 * selection — matching how switching sessions behaved before the grid existed.
 * The conversation subtree inside is keyed by session id, which is what resets
 * the transcript itself.
 *
 * Note this does mean dragging a session from one slot to another remounts its
 * transcript (keys only reconcile among siblings, and the two slots are different
 * parents), costing scroll position and the virtualizer's measurement cache. That
 * is the same cost a session switch has always paid, and the conversation ACTOR
 * survives regardless — it lives in a module-level registry, not in the tree.
 */
export function SessionGrid(props: SessionGridProps) {
  const { layout, sessions, onAssignSlot } = props
  const single = layout.slots.length === 1
  // The slot currently under the pointer during a drag. Tracked so exactly one
  // slot highlights: `dragleave` fires when crossing into a CHILD element too, so
  // a per-slot boolean would flicker as the cursor moves over the pane's contents.
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  // A drag can end without the slot ever seeing `dragleave` — dropped outside the
  // window, cancelled with Escape, or aborted when the window loses focus — which
  // would leave the highlight painted until the next drag. `dragend` fires on the
  // source for all of those, so listen for it globally while a slot is lit.
  useEffect(() => {
    if (dropTarget === null) return
    const clear = () => setDropTarget(null)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [dropTarget])
  // The session the per-session docks follow. The focused slot normally, falling
  // back to the first filled one so closing the focused pane doesn't strand them.
  const dockSessionId = layout.slots[layout.focused] ?? layout.slots.find((id) => id !== null) ?? null
  const dockSession = dockSessionId === null ? null : (sessions.find((s) => s.id === dockSessionId) ?? null)

  const renderSlot = (index: number) => {
    const sessionId = layout.slots[index] ?? null
    const session = sessionId === null ? null : (sessions.find((s) => s.id === sessionId) ?? null)
    const isFocused = index === layout.focused
    return (
          <div
            key={index}
            data-testid={`grid-slot-${index}`}
            data-focused={isFocused || undefined}
            // Which session this slot is actually rendering. The e2e suite reads
            // the grid's arrangement off these rather than off titles, which are
            // operator-editable and repeat across panes.
            data-session={sessionId ?? undefined}
            // Focus follows a mousedown anywhere in the pane, captured so a click
            // on a control inside still registers the pane as focused first.
            onMouseDownCapture={() => props.onFocusSlot(index)}
            onFocusCapture={() => props.onFocusSlot(index)}
            onDragOver={(e) => {
              if (!onAssignSlot || !carriesSession(e)) return
              // Calling preventDefault is what MARKS this element as a valid drop
              // target — without it the browser refuses the drop entirely.
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              setDropTarget(index)
            }}
            onDragLeave={(e) => {
              // Ignore leaves into a descendant — only a real exit clears the
              // highlight, or it would strobe as the cursor crosses the transcript.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setDropTarget((current) => (current === index ? null : current))
            }}
            onDrop={(e) => {
              if (!onAssignSlot || !carriesSession(e)) return
              e.preventDefault()
              setDropTarget(null)
              const droppedId = e.dataTransfer.getData(SESSION_DND_MIME)
              if (droppedId) onAssignSlot(index, droppedId)
            }}
            className={cn(
              // `flex-1 basis-0` (not bare flex-1): stacked slots in a column
              // split height evenly rather than sizing to content. Without it the
              // slot collapses to its transcript's height and the composer floats
              // mid-pane instead of pinning to the bottom.
              "relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-editor",
              // The focus ring is noise when there's only one pane — with nothing
              // to disambiguate, it would just be a permanent border.
              !single && isFocused && "ring-1 ring-inset ring-blue/40",
              // The drop highlight outranks the focus ring: mid-drag, where the
              // session will LAND matters more than where focus happens to be.
              dropTarget === index && "ring-2 ring-inset ring-blue"
            )}
          >
            {session === null ? (
              <EmptySlot index={index} />
            ) : (
              <SessionPane
                session={session}
                renderConversation={props.renderConversation}
                conversationPane={props.conversationPane}
                planSessions={props.planSessions}
                liveActivity={props.liveActivity}
                liveDiff={props.liveDiff}
                onOpenSettings={props.onOpenSettings}
                renderPullRequest={props.renderPullRequest}
                renderReview={props.renderReview}
                renderCode={props.renderCode}
                renderIssue={props.renderIssue}
                // The docks are mounted ONCE outside the grid (see below), so the
                // toggle is app-level and every pane's copy drives the same dock.
                onToggleBrowser={props.onToggleBrowser}
                browserActive={props.browserActive}
                // No close control in 1-up: with one slot there is nothing to
                // close back to, so it would only be a way to blank the app.
                onClosePane={
                  single || !props.onClearSlot ? undefined : () => props.onClearSlot?.(index)
                }
              />
            )}
          </div>
    )
  }

  // Both docks are mounted HERE, once, outside the slot loop — never inside a
  // pane.
  //
  // The browser preview drives a single native `WebContentsView` in the main
  // process and its unmount cleanup calls `browserPreviewClose()`, with the
  // current URL held in component state. Mounting it inside the focused pane
  // meant that clicking a different pane — to type in its composer, say —
  // unmounted it and remounted a fresh one, destroying the view and reopening at
  // the default URL. You would lose the page, its history and your scroll
  // position just by clicking the pane next to it.
  //
  // The terminal dock is per-SESSION rather than per-pane, so it stays mounted
  // and simply takes whichever session currently owns it as a prop. Passing a
  // prop re-runs its queries; unmounting it would throw away the xterm buffer.
  const dock = dockSession && props.renderTerminalDock ? props.renderTerminalDock(dockSession) : null
  // Session-agnostic (it points at localhost), which is exactly why hoisting it
  // out of the panes costs nothing.
  const browserDock = props.renderBrowserDock ? props.renderBrowserDock(dockSession) : null
  const termSide = props.terminalDockSide ?? "bottom"
  const browserSide = props.browserDockSide ?? "right"

  const grid = (
    <div
      data-testid="session-grid"
      // NOT `data-mode`: the composer already owns that attribute for its
      // execution mode, and this element is an ANCESTOR of it — an unscoped
      // `[data-mode]` locator would match the grid first and read "2|1" where a
      // caller expected "accept-edits". (It did; chat.spec.ts caught it.)
      data-layout-mode={layout.mode}
      className="flex min-h-0 min-w-0 flex-1 gap-px bg-hairline"
    >
      {columnsOf(layout.mode).map((slotIndices, col) => (
        // Every column takes an equal share of the width; rows inside it split
        // that column's height. `basis-0` keeps a column with two panes the same
        // width as one with a single pane — without it flex would size columns by
        // their content and `2|1` would come out lopsided.
        <div
          key={col}
          data-testid={`grid-column-${col}`}
          className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col gap-px"
        >
          {slotIndices.map(renderSlot)}
        </div>
      ))}
    </div>
  )

  // RIGHT-docked panes sit beside the whole grid; BOTTOM-docked ones stack under
  // that row. Each dock CSS-hides itself when closed, so this holds for 0, 1 or 2
  // open docks on independent sides.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        {grid}
        {termSide === "right" ? dock : null}
        {browserSide === "right" ? browserDock : null}
      </div>
      {termSide === "bottom" ? dock : null}
      {browserSide === "bottom" ? browserDock : null}
    </div>
  )
}
