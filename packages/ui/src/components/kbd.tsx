import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** A monospace keyboard chip. `onFill` variant sits on a primary-colored surface. */
export function Kbd({
  children,
  onFill = false,
  className
}: {
  children: ReactNode
  onFill?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] leading-none",
        onFill ? "bg-blue text-editor" : "border border-line text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}
