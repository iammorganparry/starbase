import { useState } from "react"
import { cn } from "../lib/cn.js"

/** Collapsible "thinking" summary (dim, purple sparkle). */
export function ThoughtBlock({
  seconds,
  children,
  defaultOpen = false,
  className
}: {
  seconds: number
  children?: React.ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const collapsible = children != null
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-sunken", className)}>
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-[#23262d] px-[11px] py-[7px] text-left"
      >
        <span className="text-[11px] text-purple">✦</span>
        <span className="flex-1 text-[11.5px] text-text">Thought for {seconds}s</span>
        {collapsible && <span className="text-dim">{open ? "▾" : "▸"}</span>}
      </button>
      {collapsible && open && (
        <div className="px-[11px] py-2 text-[11.5px] leading-[1.55] text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  )
}
