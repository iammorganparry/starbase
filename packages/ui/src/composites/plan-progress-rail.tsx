import type { Plan, PlanStep, PlanStepStatus } from "@starbase/core"
import { Check, GitBranch } from "lucide-react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

/** Mirrors `PlanStepList`'s tones so a step reads identically in both places. */
const STATUS_TONE: Record<PlanStepStatus, string> = {
  proposed: "bg-line-strong",
  current: "bg-blue",
  revising: "bg-yellow",
  done: "bg-green"
}

const doneCount = (plan: Plan): number => plan.steps.filter((s) => s.status === "done").length

/**
 * The approved plan's steps as a compact progress rail beside the transcript —
 * so execution is legible without leaving the Conversation. Selecting a step
 * deep-links into Plan Review (the host owns that jump).
 *
 * Progress is inferred upstream by matching the agent's edits against each step's
 * proposed `files` (see `markPlanProgress`), so in practice a step is either
 * proposed or done — there's no reliable in-progress signal to render.
 */
export function PlanProgressRail({
  plan,
  selectedId,
  onSelect,
  className
}: {
  plan: Plan
  /** Highlighted step (the one Plan Review would open at). */
  selectedId?: string | null
  onSelect?: (stepId: string) => void
  className?: string
}) {
  if (plan.steps.length === 0) return null

  const done = doneCount(plan)
  const total = plan.steps.length
  const pct = Math.round((done / total) * 100)

  return (
    <div className={cn("flex min-h-0 flex-col bg-panel", className)}>
      <div className="flex flex-none flex-col gap-2 border-b border-hairline px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text" title={plan.summary}>
            {plan.summary}
          </span>
          <span className="flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
            {done}/{total}
          </span>
        </div>
        {/* A hairline meter — the same signal as the counter, read at a glance. */}
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-green transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
        {plan.steps.map((step) => (
          <Row key={step.id} step={step} selected={step.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function Row({
  step,
  selected,
  onSelect
}: {
  step: PlanStep
  selected: boolean
  onSelect?: (stepId: string) => void
}) {
  const arm = step.kind === "branch-arm"
  return (
    <button
      type="button"
      onClick={() => onSelect?.(step.id)}
      title={step.title}
      className={cn(
        "flex min-h-[28px] items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        "active:scale-[0.99] [transition-property:background-color,border-color,scale]",
        arm && "ml-4",
        selected ? "border border-blue/55 bg-blue/10" : "border border-transparent hover:bg-surface"
      )}
    >
      {step.status === "done" ? (
        <Check className="size-3 flex-none text-green" strokeWidth={2.5} />
      ) : (
        <StatusDot
          tone={STATUS_TONE[step.status]}
          size={6}
          pulse={step.status === "revising"}
          glow={step.status === "current"}
        />
      )}
      <span
        className={cn(
          "flex-none font-mono text-[9.5px] tabular-nums",
          step.status === "done" ? "text-green/70" : "text-muted-foreground"
        )}
      >
        {step.number}
      </span>
      {step.kind === "branch" && <GitBranch className="size-3 flex-none text-purple" />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11.5px]",
          step.status === "done" ? "text-muted-foreground" : "text-text-body",
          selected && "font-semibold text-text"
        )}
      >
        {step.title}
      </span>
    </button>
  )
}
