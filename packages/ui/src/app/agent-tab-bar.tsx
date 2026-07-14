import { MessagesSquare } from "lucide-react"
import type { SubagentStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

/** The "Main" tab id — the parent conversation, always the first cell. */
export const MAIN_AGENT = "main"

/** One sub-agent cell's data (a projection of `Subagent`, sans transcript). */
export interface AgentTabItem {
  id: string
  /** Sub-agent type, e.g. "Explore" / "general-purpose". */
  name: string
  /** The task description — shown as the cell's tooltip. */
  description: string
  status: SubagentStatus
}

/** Status → dot tone + pulse (working pulses like a live run). */
const DOT: Record<SubagentStatus, { tone: string; pulse: boolean }> = {
  working: { tone: "bg-yellow", pulse: true },
  done: { tone: "bg-green", pulse: false },
  error: { tone: "bg-red", pulse: false }
}

/**
 * The secondary tab bar, nested directly beneath the main `TabBar`. It surfaces
 * the harness's live sub-agents (`Task` spawns) as watch-only tabs: a "Main" cell
 * for the parent conversation, then one cell per running sub-agent. It reads as a
 * level deeper than the main bar — it sits ON the editor surface (not the darker
 * strip) with a bottom accent on the active cell (the main bar uses a top accent).
 * Presentational only; the pane owns which cell is active and drops finished ones.
 */
export function AgentTabBar({
  agents,
  active,
  onChange
}: {
  agents: ReadonlyArray<AgentTabItem>
  /** The active cell id — `MAIN_AGENT` or a sub-agent id. */
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex h-8 flex-none items-stretch border-b border-hairline bg-editor">
      <button
        type="button"
        onClick={() => onChange(MAIN_AGENT)}
        aria-current={active === MAIN_AGENT ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-1.5 border-r border-hairline px-3 text-[11.5px] outline-none transition-colors",
          active === MAIN_AGENT ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
        )}
      >
        {active === MAIN_AGENT && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
        <MessagesSquare
          className={cn("size-3 flex-none", active === MAIN_AGENT ? "text-blue" : "text-dim")}
        />
        <span className="whitespace-nowrap">Main</span>
      </button>

      {agents.map((agent) => {
        const isActive = agent.id === active
        const dot = DOT[agent.status]
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onChange(agent.id)}
            title={agent.description || agent.name}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-1.5 border-r border-hairline px-3 text-[11.5px] outline-none transition-colors",
              isActive ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
            )}
          >
            {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
            <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} />
            <span className="whitespace-nowrap font-medium">{agent.name}</span>
            {agent.description && (
              <span className="max-w-[180px] truncate text-dim group-hover:text-muted-foreground">
                {agent.description}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
