import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Globe, PanelBottom, PanelRight, RotateCw, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { useResizableWidth } from "../components/resizable.js"
import type { DockSide } from "./terminal-panel.js"

// ── BrowserPreview ────────────────────────────────────────────────────────────
// The dockable, resizable shell for the embedded browser preview. Purely
// presentational: it owns the URL bar + dock chrome, and renders the live view
// region via `children`. The desktop app supplies a bounds-measured div as
// `children` (the native `WebContentsView` floats over it), and the app owns
// visibility, dock side, and the actual navigation (over RPC).

export interface BrowserPreviewProps {
  /** Which edge the dock is attached to. */
  dock: DockSide
  onDockChange: (side: DockSide) => void
  /** When false the dock is CSS-hidden (the app also hides the native view). */
  visible: boolean
  /** Hide the dock. */
  onToggle: () => void
  /** The currently-loaded URL (seeds the address bar). */
  url: string
  /** Load a URL (Enter / Go). The app validates + drives the native view. */
  onNavigate: (url: string) => void
  /** Reload the current page. */
  onReload: () => void
  /** The live view region — a bounds-measured placeholder the app supplies. */
  children: ReactNode
}

// Persisted, clamped dock sizes — one per axis so switching sides keeps both.
const HEIGHT = { key: "starbase.browser.height", initial: 360, min: 180, max: 820 }
const WIDTH = { key: "starbase.browser.width", initial: 520, min: 320, max: 1000 }

/** The dockable browser-preview shell (URL bar + view region). */
export function BrowserPreview(props: BrowserPreviewProps) {
  const { dock: preferredDock, visible, url } = props
  // The shell's width (from `app-shell.tsx`), not this dock's own — the question
  // is how much room the ROW has to give away, which a dock measuring itself
  // cannot answer.
  const { width: shellWidth } = usePaneWidth()
  // `props.dock` stays the operator's PREFERENCE; this is where it can fit right
  // now. Widening the window restores the side they actually chose.
  const dock = effectiveDock(preferredDock, shellWidth)
  const isBottom = dock === "bottom"
  const height = useResizableWidth({ storageKey: HEIGHT.key, initial: HEIGHT.initial, min: HEIGHT.min, max: HEIGHT.max })
  const width = useResizableWidth({ storageKey: WIDTH.key, initial: WIDTH.initial, min: WIDTH.min, max: WIDTH.max })

  // Dragging the edge toward the content (up / left) GROWS the dock → invert.
  const onResize = useCallback(
    (delta: number) => (isBottom ? height.adjust(-delta) : width.adjust(-delta)),
    [isBottom, height, width]
  )

  // Local address-bar text, seeded from the loaded URL and re-synced when it
  // changes underneath us (e.g. app seeds the session's dev-server port).
  const [draft, setDraft] = useState(url)
  useEffect(() => setDraft(url), [url])

  const submit = () => {
    const next = draft.trim()
    if (next) props.onNavigate(next)
  }

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

      {/* Address bar */}
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-hairline bg-panel px-2">
        <button
          type="button"
          onClick={props.onReload}
          aria-label="Reload"
          title="Reload"
          className="flex size-6 flex-none items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
        >
          <RotateCw className="size-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-hairline bg-sunken px-2">
          <Globe className="size-3.5 flex-none text-dim" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
            }}
            spellCheck={false}
            placeholder="http://localhost:3000"
            aria-label="Preview URL"
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[11.5px] text-text-bright outline-none placeholder:text-dim"
          />
        </div>
        <div className="flex flex-none items-center gap-0.5 pl-0.5">
          <DockSideButton side="bottom" active={isBottom} onClick={() => props.onDockChange("bottom")} />
          <DockSideButton side="right" active={!isBottom} onClick={() => props.onDockChange("right")} />
          <button
            type="button"
            onClick={props.onToggle}
            aria-label="Hide browser preview"
            title="Hide browser preview"
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* View region — the native WebContentsView floats over these bounds. */}
      <div className="relative min-h-0 flex-1 bg-white">{props.children}</div>
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

/**
 * A drag edge that resizes the dock (mirrors the terminal dock's edge): a
 * horizontal bar along the top for a bottom dock, a vertical bar along the left
 * for a right dock. Reports per-move pixel deltas.
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
      aria-label="Resize browser preview"
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
      <span className={cn("absolute", horizontal ? "inset-x-0 -top-[3px] -bottom-[3px]" : "inset-y-0 -left-[3px] -right-[3px]")} />
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
