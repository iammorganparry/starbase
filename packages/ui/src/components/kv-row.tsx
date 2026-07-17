import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * A dim fixed-width label with its value — dev-server URLs, response headers.
 *
 * The label column is a fixed px width rather than a grid so several rows can be
 * mixed with free-form content in the same stack and still line up; callers pass
 * the same `labelWidth` to a run of rows.
 */
export function KeyValueRow({
  label,
  labelWidth = 64,
  children,
  className
}: {
  label: ReactNode
  labelWidth?: number
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex gap-2 font-mono text-[11.5px] leading-[1.6]", className)}>
      <span className="flex-none text-dim" style={{ width: labelWidth }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{children}</span>
    </div>
  )
}
