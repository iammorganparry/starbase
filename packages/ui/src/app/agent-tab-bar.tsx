import { ChevronRight, MessagesSquare } from "lucide-react"
import type { SubagentStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

/** The "Main" tab id — the parent conversation, always the first crumb. */
export const MAIN_AGENT = "main"

/** One sub-agent cell's data (a projection of `Subagent`, sans transcript). */
export interface AgentTabItem {
  id: string
  /** Sub-agent type, e.g. "Explore" / "general-purpose". */
  name: string
  /** The task description — shown as the cell's tooltip. */
  description: string
  status: SubagentStatus
  /** This agent spawned sub-agents of its own — offer a drill-in affordance. */
  hasChildren: boolean
}

/** One crumb in the drill path — `MAIN_AGENT`, then each drilled-into agent. */
export interface AgentCrumb {
  id: string
  name: string
}

/** Status → dot tone + pulse (working pulses like a live run). */
const DOT: Record<SubagentStatus, { tone: string; pulse: boolean }> = {
  working: { tone: "bg-yellow", pulse: true },
  done: { tone: "bg-green", pulse: false },
  error: { tone: "bg-red", pulse: false }
}

/**
 * The secondary tab bar, nested directly beneath the main `TabBar`. It surfaces
 * the harness's live sub-agents (`Task` spawns) as watch-only tabs. It reads as a
 * level deeper than the main bar — it sits ON the editor surface (not the darker
 * strip) with a bottom accent on the active cell (the main bar uses a top accent).
 *
 * Sub-agents nest arbitrarily, which a flat strip can't express, so the bar shows
 * ONE level at a time: a breadcrumb of the drill path, then a cell per agent at
 * that level. An agent that spawned its own sub-agents gets a `>` affordance to
 * drill into them. This keeps the strip a fixed height at any depth.
 *
 * Presentational only — the pane owns the drill level, derives each level's cells,
 * and owns which cell is active.
 */
export function AgentTabBar({
  agents,
  trail,
  active,
  onChange,
  onDrill,
  onNavigate
}: {
  /** The agents at the current drill level (the current crumb's children). */
  agents: ReadonlyArray<AgentTabItem>
  /** The drilled-into agents below Main, outermost first. Empty = at Main. */
  trail: ReadonlyArray<AgentCrumb>
  /** The active cell id — `MAIN_AGENT` or a sub-agent id. */
  active: string
  onChange: (key: string) => void
  /** Descend into an agent's own sub-agents. */
  onDrill: (id: string) => void
  /** Jump the drill level to a crumb (`MAIN_AGENT` = back to the top). */
  onNavigate: (id: string) => void
}) {
  return (
    <div className="flex h-8 flex-none items-stretch overflow-x-auto border-b border-hairline bg-editor">
      <button
        type="button"
        onClick={() => onNavigate(MAIN_AGENT)}
        aria-current={active === MAIN_AGENT ? "page" : undefined}
        className={cn(
          "group relative flex flex-none items-center gap-1.5 border-r border-hairline px-3 text-[11.5px] outline-none transition-colors",
          active === MAIN_AGENT ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
        )}
      >
        {active === MAIN_AGENT && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
        <MessagesSquare
          className={cn("size-3 flex-none", active === MAIN_AGENT ? "text-blue" : "text-dim")}
        />
        <span className="whitespace-nowrap">Main</span>
      </button>

      {/* The drill path. Each crumb jumps the level back to that agent's children. */}
      {trail.map((crumb) => (
        <button
          key={crumb.id}
          type="button"
          onClick={() => onNavigate(crumb.id)}
          title={`Back to ${crumb.name}'s sub-agents`}
          className={cn(
            "relative flex flex-none items-center gap-1 border-r border-hairline pl-1.5 pr-2.5 text-[11.5px] outline-none transition-colors",
            active === crumb.id
              ? "text-text"
              : "text-muted-foreground hover:bg-panel hover:text-text"
          )}
        >
          {active === crumb.id && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
          <ChevronRight className="size-3 flex-none text-dim" />
          <span className="whitespace-nowrap font-medium">{crumb.name}</span>
        </button>
      ))}

      {agents.map((agent) => {
        const isActive = agent.id === active
        const dot = DOT[agent.status]
        return (
          <div
            key={agent.id}
            className={cn(
              "group relative flex flex-none items-stretch border-r border-hairline transition-colors",
              isActive ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
            )}
          >
            {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
            <button
              type="button"
              onClick={() => onChange(agent.id)}
              title={agent.description || agent.name}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 pl-3 text-[11.5px] outline-none",
                agent.hasChildren ? "pr-1.5" : "pr-3"
              )}
            >
              <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} />
              <span className="whitespace-nowrap font-medium">{agent.name}</span>
              {agent.description && (
                <span className="max-w-[180px] truncate text-dim group-hover:text-muted-foreground">
                  {agent.description}
                </span>
              )}
            </button>
            {agent.hasChildren && (
              <button
                type="button"
                onClick={() => onDrill(agent.id)}
                title={`Show ${agent.name}'s sub-agents`}
                aria-label={`Show ${agent.name}'s sub-agents`}
                className="flex items-center pr-2 text-dim outline-none transition-colors hover:text-text"
              >
                <ChevronRight className="size-3 flex-none" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
