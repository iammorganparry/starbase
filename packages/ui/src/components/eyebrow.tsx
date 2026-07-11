import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** Uppercase tracked section label. `accent` gives the Claude-blue treatment. */
export function Eyebrow({
  children,
  accent = false,
  icon,
  className
}: {
  children: ReactNode
  accent?: boolean
  icon?: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[7px] text-[11px] font-semibold uppercase tracking-[0.4px]",
        accent ? "text-blue" : "text-dim",
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** The small "C" Claude glyph used before assistant eyebrows. */
export function ClaudeGlyph() {
  return (
    <span className="flex size-[14px] items-center justify-center rounded-md bg-blue font-mono text-[9px] text-editor">
      C
    </span>
  )
}
