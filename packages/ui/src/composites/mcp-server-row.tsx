import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"

/** A configured MCP server row: icon, name, transport, tool count, on/off state. */
export function McpServerRow({
  name,
  transport,
  meta,
  enabled = true,
  glyph = "◆",
  className
}: {
  name: string
  transport: string
  /** e.g. "6 tools · project". */
  meta?: ReactNode
  enabled?: boolean
  glyph?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-[11px] py-[9px]", className)}>
      <span className="flex size-[26px] items-center justify-center rounded-md border border-line bg-sunken text-[12px] text-text-bright">
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold text-text-bright">{name}</span>
          <Badge tone="count" size="xs">
            {transport}
          </Badge>
        </div>
        {meta && <div className="mt-0.5 font-mono text-[10px] text-dim">{meta}</div>}
      </div>
      <span
        className={cn(
          "flex items-center gap-1.5 text-[10.5px]",
          enabled ? "text-green" : "text-dim"
        )}
      >
        <StatusDot tone={enabled ? "bg-green" : "bg-line-strong"} size={6} glow={false} />
        {enabled ? "on" : "off"}
      </span>
    </div>
  )
}
