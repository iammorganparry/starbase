import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"

/** The prompt composer. Presentational for now (wired to input state later). */
export function Composer({
  placeholder = "Message Claude…",
  model = "claude-sonnet",
  mode = "accept edits",
  onSend,
  className
}: {
  placeholder?: string
  model?: ReactNode
  mode?: ReactNode
  onSend?: () => void
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-[11px] rounded-xl border border-line bg-sunken px-[13px] py-2.5", className)}>
      <span className="text-[14px] text-dim">
        {placeholder} <span className="font-mono text-[11px] text-line-strong">/ for commands</span>
      </span>
      <div className="flex items-center gap-2.5">
        <Badge tone="neutral" size="sm">
          {model}
        </Badge>
        <Badge tone="neutral" size="sm">
          {mode}
        </Badge>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={onSend}>
          Send ↵
        </Button>
      </div>
    </div>
  )
}
