import { useState } from "react"
import { cn } from "../lib/cn.js"

/**
 * Collapsible "thinking" summary (dim, purple sparkle). While the agent is still
 * reasoning (`streaming`), it reads "Thinking…" with a pulsing sparkle; once done
 * it shows "Thought for Ns". `seconds` is null until the duration is known.
 */
export function ThoughtBlock({
  seconds,
  streaming = false,
  children,
  defaultOpen = false,
  className
}: {
  seconds: number | null
  streaming?: boolean
  children?: React.ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const collapsible = children != null
  const label = streaming || seconds === null ? "Thinking…" : `Thought for ${seconds}s`
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-sunken", className)}>
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-hairline px-[11px] py-[7px] text-left"
      >
        <span className={cn("text-[11px] text-purple", streaming && "animate-pulse-dot")}>✦</span>
        <span className="flex-1 text-[11.5px] text-text">{label}</span>
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
