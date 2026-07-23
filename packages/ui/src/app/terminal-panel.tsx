import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { PanelBottom, PanelRight, Plus, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { useResizableWidth } from "../components/resizable.js"

// ── TerminalDock ──────────────────────────────────────────────────────────────
// The dockable, resizable One-Dark shell around the live terminal cells. This is
// purely presentational: all PTY/tab state lives in the app (useTerminals), and
// each cell is supplied via the `renderTerminal(id)` render-prop (the desktop
// app's XtermView). The dock persists only its own SIZE to localStorage; the
// app owns which side it docks on and whether it's visible.

export type DockSide = "bottom" | "right"
export type TerminalTabStatus = "running" | "idle" | "exited"

export interface TerminalTab {
  id: string
  title: string
  status: TerminalTabStatus
}

export interface TerminalDockProps {
  /** Which edge the dock is attached to. */
  dock: DockSide
  onDockChange: (side: DockSide) => void
  /** When false the dock is CSS-hidden (its terminals stay mounted — no respawn). */
  visible: boolean
  /** Hide the dock (the ⌃` / close affordance). */
  onToggle: () => void
  tabs: ReadonlyArray<TerminalTab>
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
  /** Working directory shown in the footer (the session's worktree). */
  cwdLabel?: string
  /** Exit code of the most recently exited shell (null → nothing exited yet). */
  lastExit?: number | null
  /** Render the live terminal cell for a tab id (the desktop app's XtermView). */
  renderTerminal: (id: string) => ReactNode
}

// Persisted, clamped dock sizes — one per axis so switching sides keeps both.
const HEIGHT = { key: "starbase.terminal.height", initial: 260, min: 140, max: 720 }
const WIDTH = { key: "starbase.terminal.width", initial: 480, min: 300, max: 920 }

/** The dockable terminal shell. Renders every tab's cell (only the active one is
 * shown) so switching tabs — or hiding the dock — never tears down xterm. */
export function TerminalDock(props: TerminalDockProps) {
  const { dock: preferredDock, tabs, activeId, visible } = props
  // The shell's width (from `app-shell.tsx`), not this dock's own — the question
  // is how much room the ROW has to give away, which a dock measuring itself
  // cannot answer.
  const { width: shellWidth } = usePaneWidth()
  // `props.dock` stays the operator's PREFERENCE; this is where it can fit right
  // now. Widening the window restores the side they actually chose.
  const dock = effectiveDock(preferredDock, shellWidth)
  const isBottom = dock === "bottom"
  // Both hooks always run (stable order); we drive the axis that's docked.
  const height = useResizableWidth({ storageKey: HEIGHT.key, initial: HEIGHT.initial, min: HEIGHT.min, max: HEIGHT.max })
  const width = useResizableWidth({ storageKey: WIDTH.key, initial: WIDTH.initial, min: WIDTH.min, max: WIDTH.max })

  // Dragging the edge toward the content (up / left) GROWS the dock → invert.
  const onResize = useCallback(
    (delta: number) => (isBottom ? height.adjust(-delta) : width.adjust(-delta)),
    [isBottom, height, width]
  )

  return (
    <div
      className={cn(
        "relative flex flex-none flex-col bg-sunken",
        isBottom ? "border-t border-hairline" : "border-l border-hairline",
        !visible && "hidden"
      )}
      style={
        visible
          ? isBottom
            ? { height: height.width }
            : // Capped at a fraction of the row: the stored width is clamped to
              // [300, 920] in absolute pixels, which says nothing about whether
              // it leaves a readable pane beside it.
              { width: clampDockWidth(width.width, shellWidth) }
          : undefined
      }
    >
      <DockResizeEdge orientation={isBottom ? "horizontal" : "vertical"} onResize={onResize} />

      {/* Tab strip */}
      <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel pr-1.5">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onSelect={() => props.onSelect(t.id)}
              onClose={() => props.onClose(t.id)}
            />
          ))}
          <button
            type="button"
            onClick={props.onNew}
            aria-label="New terminal"
            className="flex flex-none items-center px-2.5 text-dim transition-colors hover:text-text-bright"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-none items-center gap-0.5 pl-1.5">
          <DockSideButton side="bottom" active={isBottom} onClick={() => props.onDockChange("bottom")} />
          <DockSideButton side="right" active={!isBottom} onClick={() => props.onDockChange("right")} />
          <button
            type="button"
            onClick={props.onToggle}
            aria-label="Hide terminal"
            title="Hide terminal (⌃`)"
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Body — every terminal stays mounted; only the active one is shown. */}
      <div className="relative min-h-0 flex-1 bg-sunken">
        {tabs.length === 0 ? (
          <EmptyDock onNew={props.onNew} />
        ) : (
          tabs.map((t) => (
            <div key={t.id} className={cn("absolute inset-0", t.id === activeId ? "block" : "hidden")}>
              {props.renderTerminal(t.id)}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex h-7 flex-none items-center gap-2.5 border-t border-hairline bg-panel px-3 font-mono text-[10.5px] text-dim">
        {props.cwdLabel && (
          <>
            <span className="min-w-0 truncate text-muted-foreground">{props.cwdLabel}</span>
            <span className="flex-none text-line">·</span>
          </>
        )}
        {props.lastExit != null && (
          <span className="flex-none">
            last exit <span className={props.lastExit === 0 ? "text-green" : "text-red"}>{props.lastExit}</span>
          </span>
        )}
        <div className="flex-1" />
        <span className="flex-none">⌃` toggle</span>
      </div>
    </div>
  )
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: TerminalTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex flex-none cursor-pointer items-center gap-2 border-r border-hairline px-3 font-mono text-[11.5px]",
        active
          ? "border-t-2 border-t-blue bg-sunken text-text-bright"
          : "text-muted-foreground opacity-70 hover:opacity-100"
      )}
    >
      <span
        className={cn(
          "size-1.5 flex-none rounded-full",
          tab.status === "running" ? "bg-green" : tab.status === "exited" ? "bg-red" : "bg-line-strong"
        )}
      />
      <span className="max-w-[140px] truncate">{tab.title}</span>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="ml-0.5 flex size-4 flex-none items-center justify-center rounded text-dim opacity-0 transition hover:bg-hairline hover:text-text-bright group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function DockSideButton({ side, active, onClick }: { side: DockSide; active: boolean; onClick: () => void }) {
  const Icon = side === "bottom" ? PanelBottom : PanelRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Dock ${side}`}
      aria-pressed={active}
      className={cn(
        "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
        active ? "text-blue" : "text-dim hover:text-text-bright"
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

function EmptyDock({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-2 rounded-md border border-hairline bg-panel px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-text-bright"
      >
        <Plus className="size-3.5" /> New terminal
      </button>
    </div>
  )
}

/**
 * A drag edge that resizes the dock: a horizontal bar along the top for a bottom
 * dock, a vertical bar along the left for a right dock. Reports per-move pixel
 * deltas (mirrors the ResizeHandle in components/resizable but axis-aware).
 */
function DockResizeEdge({
  orientation,
  onResize
}: {
  orientation: "horizontal" | "vertical"
  onResize: (delta: number) => void
}) {
  const horizontal = orientation === "horizontal"
  const last = useRef(0)
  const dragging = useRef(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      const cur = horizontal ? e.clientY : e.clientX
      onResize(cur - last.current)
      last.current = cur
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [horizontal, onResize])

  return (
    <div
      role="separator"
      aria-label="Resize terminal"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        last.current = horizontal ? e.clientY : e.clientX
        setActive(true)
        document.body.style.cursor = horizontal ? "row-resize" : "col-resize"
        document.body.style.userSelect = "none"
      }}
      className={cn(
        "group absolute z-20",
        horizontal ? "inset-x-0 top-0 h-px cursor-row-resize" : "inset-y-0 left-0 w-px cursor-col-resize"
      )}
    >
      {/* Wide invisible hit area for an easy grab. */}
      <span
        className={cn("absolute", horizontal ? "inset-x-0 -top-[3px] -bottom-[3px]" : "inset-y-0 -left-[3px] -right-[3px]")}
      />
      {/* The visible hairline, highlighted while hovered / dragging. */}
      <span
        className={cn(
          "absolute bg-hairline transition-colors group-hover:bg-blue",
          horizontal ? "inset-x-0 top-0 h-px" : "inset-y-0 left-0 w-px",
          active && "bg-blue"
        )}
      />
    </div>
  )
}

/** Bottom terminal pane with shell tabs and a sample session (static; for stories). */
export function TerminalPanel() {
  return (
    <div className="flex h-[256px] flex-none flex-col border-t border-hairline bg-sunken">
      {/* Shell tabs */}
      <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel pr-2">
        <div className="flex items-center gap-2 border-r border-hairline border-t-2 border-t-blue bg-sunken px-3.5">
          <span className="size-1.5 rounded-full bg-green" />
          <span className="font-mono text-[11.5px] text-text-bright">zsh — api</span>
        </div>
        <div className="flex items-center gap-2 border-r border-hairline px-3.5 opacity-60">
          <span className="size-1.5 rounded-full bg-line-strong" />
          <span className="font-mono text-[11.5px] text-muted-foreground">node</span>
        </div>
        <span className="flex items-center px-3 text-[16px] text-dim">+</span>
        <div className="flex-1" />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2.5 font-mono text-[12px] leading-[1.75] text-text">
        <div>
          <span className="text-green">➜</span>&nbsp;&nbsp;
          <span className="font-semibold text-cyan">api</span>{" "}
          <span className="text-blue">git:(</span>
          <span className="text-red">feat/oauth</span>
          <span className="text-blue">)</span> <span className="text-yellow">✗</span> npm test
        </div>
        <div className="h-2" />
        <div>
          <Pass /> <span className="text-muted-foreground">src/auth/</span>session.test.ts
        </div>
        <div>
          <Pass /> <span className="text-muted-foreground">src/auth/</span>refresh.test.ts
        </div>
        <div className="h-2" />
        <div>
          <span className="text-muted-foreground">Tests:</span> <span className="text-green">24 passed</span>, 24 total
        </div>
        <div>
          <span className="text-muted-foreground">Time:</span>&nbsp;&nbsp;3.42s
        </div>
        <div className="h-2.5" />
        <div>
          <span className="text-green">➜</span>&nbsp;&nbsp;
          <span className="font-semibold text-cyan">api</span>{" "}
          <span className="text-blue">git:(</span>
          <span className="text-red">feat/oauth</span>
          <span className="text-blue">)</span> <span className="text-yellow">✗</span>{" "}
          <span className="inline-block h-[15px] w-2 -translate-y-px bg-text align-middle [animation:var(--animate-pulse-dot)]" />
        </div>
      </div>

      {/* Footer */}
      <div className="flex h-7 flex-none items-center gap-2.5 border-t border-hairline bg-panel px-4 font-mono text-[10.5px] text-dim">
        <span>
          <span className="text-green">zsh</span> · ~/dev/trigify/api
        </span>
        <span className="text-line">·</span>
        <span>
          last exit <span className="text-green">0</span>
        </span>
        <div className="flex-1" />
        <span>⌃` toggle</span>
      </div>
    </div>
  )
}

function Pass() {
  return <span className="rounded-sm bg-green px-1.5 font-bold text-editor">PASS</span>
}
