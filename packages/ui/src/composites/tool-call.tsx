import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

export type ToolCallStatus = "success" | "running" | "error"

export interface ToolCallProps {
  status: ToolCallStatus
  /** Tool name, e.g. "Read", "Grep", "Bash". */
  name: string
  /** Primary target — file path or query. */
  target?: ReactNode
  /** Trailing meta, e.g. line count or "exit 1". */
  meta?: ReactNode
  icon?: ReactNode
  className?: string
}

/** A single agent tool invocation row (success / running / error). */
export function ToolCall({ status, name, target, meta, icon, className }: ToolCallProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        status === "running" && "border-yellow/30",
        status === "error" && "border-red/35 bg-red/[0.05]",
        status === "success" && "border-line",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-[9px] px-2.5 py-1.5 font-mono text-[11.5px]",
          status === "running" && "bg-yellow/[0.08]",
          status === "success" && "bg-surface"
        )}
      >
        {status === "success" && <span className="text-green">✓</span>}
        {status === "error" && <span className="text-red">✗</span>}
        {status === "running" && <StatusDot tone="bg-yellow" size={8} pulse />}
        <span className="text-muted-foreground">{name}</span>
        {icon}
        <span className="flex-1 truncate text-text-bright">{target}</span>
        {meta && (
          <span className={cn("shrink-0", status === "error" ? "text-red" : "text-dim")}>{meta}</span>
        )}
      </div>
    </div>
  )
}
