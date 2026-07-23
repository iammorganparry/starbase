import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

export type AgentState = "working" | "flagged" | "done"

/** A running-agent card (workflow view): file target, token count, status line. */
export function AgentCard({
  file,
  state,
  tokens,
  status,
  className
}: {
  file: string
  state: AgentState
  tokens?: string
  /** Status line, e.g. "reading middleware…" or "⚠ 2 findings". */
  status?: string
  className?: string
}) {
  const working = state === "working"
  const flagged = state === "flagged"
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg px-2.5 py-2",
        working && "border border-blue bg-surface shadow-[0_0_0_3px] shadow-blue/[0.12]",
        flagged && "border border-red/30 bg-panel",
        state === "done" && "border border-line bg-panel",
        className
      )}
    >
      <div className="flex items-center gap-[7px]">
        <StatusDot
          tone={working ? "bg-yellow" : "bg-green"}
          size={working ? 8 : 7}
          pulse={working}
        />
        <span className="flex-1 truncate font-mono text-[11.5px] font-semibold text-text-bright">
          {file}
        </span>
        {tokens && <span className="font-mono text-[9.5px] text-muted-foreground">{tokens}</span>}
      </div>
      {status && (
        <div
          className={cn("font-mono text-[10px]", flagged ? "text-red" : working ? "text-yellow" : "text-green")}
        >
          {status}
        </div>
      )}
    </div>
  )
}
