import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"

export type PhaseState = "active" | "pending" | "done"

/** A workflow phase node (active = blue ring + pulse, pending = dashed outline). */
export function PhaseNode({
  index,
  title,
  state,
  hint,
  counts,
  className
}: {
  index: string
  title: string
  state: PhaseState
  /** Trailing status word, e.g. "viewing". */
  hint?: string
  /** Progress counts line, e.g. "5✓ 6● 1✗". */
  counts?: string
  className?: string
}) {
  const active = state === "active"
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg px-[11px] py-[9px]",
        active
          ? "border border-blue bg-surface shadow-[0_0_0_3px_rgba(97,175,239,.13)]"
          : "border border-dashed border-line bg-editor opacity-[.72]",
        className
      )}
    >
      <div className="flex items-center gap-[7px]">
        {active ? (
          <StatusDot tone="bg-yellow" size={9} pulse />
        ) : (
          <span className="size-[9px] flex-none rounded-full border-[1.5px] border-line-strong" />
        )}
        <Badge tone={active ? "blue" : "count"} size="xs">
          {index}
        </Badge>
        <span
          className={cn("flex-1 text-[12px] font-semibold", active ? "text-text-bright" : "text-text")}
        >
          {title}
        </span>
        {hint && <span className="text-[9px] text-blue">{hint}</span>}
      </div>
      {counts && <div className="font-mono text-[9.5px] text-muted-foreground">{counts}</div>}
    </div>
  )
}
