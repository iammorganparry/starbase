import type { Plan, PlanStep, PlanStepStatus } from "@starbase/core"
import { Check, GitBranch, MessageSquareText } from "lucide-react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

const STATUS_TONE: Record<PlanStepStatus, string> = {
  proposed: "bg-line-strong",
  current: "bg-blue",
  revising: "bg-yellow",
  done: "bg-green"
}

const commentCounts = (plan: Plan): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const c of plan.comments) counts.set(c.stepId, (counts.get(c.stepId) ?? 0) + 1)
  return counts
}

/**
 * The plan's steps as a selectable list — the Plan Review navigator. Branch arms
 * (4a / 4b) sit indented under their branch parent, flagged steps carry a dot,
 * and a comment count shows where scrutiny has landed. Selecting a row opens its
 * spec. Built from atoms (StatusDot + tokens), no new primitives.
 */
export function PlanStepList({
  plan,
  selectedId,
  onSelect,
  className
}: {
  plan: Plan
  selectedId?: string | null
  onSelect?: (stepId: string) => void
  className?: string
}) {
  const counts = commentCounts(plan)
  return (
    <div className={cn("flex flex-col gap-1 p-2", className)}>
      {plan.steps.map((step) => (
        <Row
          key={step.id}
          step={step}
          comments={counts.get(step.id) ?? 0}
          selected={step.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function Row({
  step,
  comments,
  selected,
  onSelect
}: {
  step: PlanStep
  comments: number
  selected: boolean
  onSelect?: (stepId: string) => void
}) {
  const arm = step.kind === "branch-arm"
  const branch = step.kind === "branch"
  return (
    <button
      type="button"
      onClick={() => onSelect?.(step.id)}
      className={cn(
        "group flex min-h-[34px] items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        "active:scale-[0.99] [transition-property:background-color,border-color,scale]",
        arm && "ml-5",
        selected
          ? "border border-blue/55 bg-blue/10"
          : "border border-transparent hover:bg-surface"
      )}
    >
      {step.status === "done" ? (
        <Check className="size-3.5 flex-none text-green" strokeWidth={2.5} />
      ) : (
        <StatusDot
          tone={STATUS_TONE[step.status]}
          size={7}
          pulse={step.status === "revising"}
          glow={step.status === "current"}
        />
      )}
      <span
        className={cn(
          "font-mono text-[10px] tabular-nums",
          step.status === "done" ? "text-green/70" : "text-muted-foreground"
        )}
      >
        {step.number}
      </span>
      {branch && <GitBranch className="size-3.5 flex-none text-purple" />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px]",
          selected || step.status === "current" ? "font-semibold text-text" : "text-text-body"
        )}
      >
        {step.title}
      </span>
      {step.condition && (
        <span className="flex-none font-mono text-[9.5px] text-muted-foreground">{step.condition}</span>
      )}
      {comments > 0 && (
        <span className="flex flex-none items-center gap-1 font-mono text-[9.5px] text-yellow">
          <MessageSquareText className="size-3" />
          {comments}
        </span>
      )}
    </button>
  )
}
