/**
 * BrowserPreviewView — binds the app's browser-preview prefs (`useBrowserPreview`)
 * and the main-process `WebContentsView` (over the `BrowserPreview.*` RPCs) to the
 * presentational `BrowserPreview` dock in @starbase/ui.
 *
 * The native view lives OUTSIDE the DOM, so this component's job is to keep it in
 * sync with an in-DOM placeholder: it streams the placeholder's on-screen rect to
 * `setBounds` (via a rAF loop that only sends on change — catches both resizes and
 * moves), (re)loads on URL change, and destroys the view whenever the pane hides
 * or the component unmounts (no orphaned overlay).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Session } from "@starbase/core"
import { BrowserPreview, type DockSide } from "@starbase/ui"
import { rpc } from "./rpc-client.js"

// Default target until run-scripts (#1) can seed the session's real dev-server
// port. TODO(#1): derive from the session's $STARBASE_PORT when available.
const DEFAULT_URL = "http://localhost:3000"

export interface BrowserPreviewViewProps {
  /** The active session (reserved for future port seeding). Null → none. */
  session: Session | null
  visible: boolean
  onToggle: () => void
  side: DockSide
  onSideChange: (side: DockSide) => void
}

export function BrowserPreviewView({ session, visible, onToggle, side, onSideChange }: BrowserPreviewViewProps) {
  const boundsRef = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState(DEFAULT_URL)

  const rect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = boundsRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, [])

  // Open/close the native view with the pane's visibility, and (re)load on URL
  // change. `open` is idempotent (reuses the view) and also sets initial bounds.
  useEffect(() => {
    if (!visible) {
      void rpc.browserPreviewClose()
      return
    }
    const r = rect()
    if (r) void rpc.browserPreviewOpen(url, r).catch(() => {})
    // Destroy the view when the pane hides or this component unmounts.
    return () => {
      void rpc.browserPreviewClose()
    }
  }, [visible, url, rect])

  // Keep the native view aligned with the placeholder: a rAF loop that pushes new
  // bounds only when they change (handles dock resize AND layout shifts that move
  // the pane without resizing it, which a ResizeObserver would miss).
  useEffect(() => {
    if (!visible) return
    let raf = 0
    let last = ""
    const tick = () => {
      const r = rect()
      if (r) {
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
        if (key !== last) {
          last = key
          void rpc.browserPreviewSetBounds(r)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [visible, rect])

  const empty = useMemo(
    () => (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-dim">
        Loading {url}…
      </div>
    ),
    [url]
  )

  return (
    <BrowserPreview
      dock={side}
      onDockChange={onSideChange}
      visible={visible}
      onToggle={onToggle}
      url={url}
      onNavigate={setUrl}
      onReload={() => void rpc.browserPreviewReload()}
    >
      {/* The native WebContentsView floats over this rect; the label shows through
          until the page paints. `session` is reserved for future port seeding. */}
      <div ref={boundsRef} className="absolute inset-0" data-session={session?.id ?? ""} />
      {empty}
    </BrowserPreview>
  )
}
