import * as React from "react"
import { cn } from "../lib/cn.js"

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

const readStored = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * A persisted, drag-resizable width. `adjust(dx)` nudges the width by a pixel
 * delta (from a drag handle), clamped to `[min, max]` and mirrored to
 * localStorage so the size survives reloads.
 */
export function useResizableWidth({
  storageKey,
  initial,
  min,
  max
}: {
  storageKey: string
  initial: number
  min: number
  max: number
}) {
  const [width, setWidth] = React.useState(() => clamp(readStored(storageKey) ?? initial, min, max))
  const ref = React.useRef(width)
  ref.current = width

  const adjust = React.useCallback(
    (dx: number) => {
      const next = clamp(ref.current + dx, min, max)
      ref.current = next
      setWidth(next)
      try {
        localStorage.setItem(storageKey, String(next))
      } catch {
        /* ignore quota / privacy-mode failures */
      }
    },
    [storageKey, min, max]
  )

  return { width, adjust }
}

/**
 * A thin vertical drag handle between two columns. Reports per-move pixel deltas
 * via `onResize`; the visible hairline widens to blue on hover/drag and the hit
 * area extends a few px each side for an easy grab.
 */
export function ResizeHandle({
  onResize,
  className,
  "aria-label": ariaLabel = "Resize panel"
}: {
  onResize: (deltaX: number) => void
  className?: string
  "aria-label"?: string
}) {
  const last = React.useRef(0)
  const dragging = React.useRef(false)
  const [active, setActive] = React.useState(false)

  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      onResize(e.clientX - last.current)
      last.current = e.clientX
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
  }, [onResize])

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        last.current = e.clientX
        setActive(true)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }}
      className={cn(
        "group relative z-10 w-px flex-none cursor-col-resize self-stretch bg-hairline",
        className
      )}
    >
      {/* Wide invisible hit area for an easy grab. */}
      <span className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      {/* The visible hairline, highlighted while hovered / dragging. */}
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-px transition-colors group-hover:bg-blue",
          active && "bg-blue"
        )}
      />
    </div>
  )
}
