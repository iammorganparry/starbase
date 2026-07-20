import { type DragEvent, type ReactNode, useState } from "react"
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
 * Panes are keyed by session id so a session dragged between slots KEEPS its
 * mounted transcript (React moves the subtree rather than remounting it). Keying
 * by slot index instead would remount on every rearrange, throwing away scroll
 * position and the virtualizer's measurement cache.
 */
export function SessionGrid(props: SessionGridProps) {
  const { layout, sessions, onAssignSlot } = props
  const single = layout.slots.length === 1
  // The slot currently under the pointer during a drag. Tracked so exactly one
  // slot highlights: `dragleave` fires when crossing into a CHILD element too, so
  // a per-slot boolean would flicker as the cursor moves over the pane's contents.
  const [dropTarget, setDropTarget] = useState<number | null>(null)

  const renderSlot = (index: number) => {
    const sessionId = layout.slots[index] ?? null
    const session = sessionId === null ? null : (sessions.find((s) => s.id === sessionId) ?? null)
    const isFocused = index === layout.focused
    return (
          <div
            key={index}
            data-testid={`grid-slot-${index}`}
            data-focused={isFocused || undefined}
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
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-editor",
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
                key={session.id}
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
                renderTerminalDock={props.renderTerminalDock}
                terminalDockSide={props.terminalDockSide}
                renderBrowserDock={props.renderBrowserDock}
                browserDockSide={props.browserDockSide}
                onToggleBrowser={props.onToggleBrowser}
                browserActive={props.browserActive}
                // Exactly one pane may drive the native browser preview and the
                // terminal dock. In 1-up that's trivially the only pane; in a grid
                // it follows focus, so the docks travel with the operator's attention.
                ownsDocks={isFocused}
                dockOwnerLabel={`pane ${layout.focused + 1}`}
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

  return (
    <div
      data-testid="session-grid"
      data-mode={layout.mode}
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
}
