import type { Plan } from "@starbase/core"
import { ClipboardList, GitBranch } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Pill } from "../components/pill.js"

const WIDTH = "w-full"
const branchCount = (plan: Plan): number => plan.steps.filter((s) => s.kind === "branch").length

/**
 * The inline, in-transcript plan card: a compact summary of a proposed plan — the
 * step preview + the two primary actions. The decision-flow canvas and full
 * drill-in / comment / revise live in the Plan Review view. Read-only once the
 * plan is settled.
 */
export function PlanCard({
  plan,
  onApprove,
  onOpenReview,
  className
}: {
  plan: Plan
  onApprove?: () => void
  /** Open the full Plan Review view (step drill-in, comments, revise). */
  onOpenReview?: () => void
  className?: string
}) {
  const branches = branchCount(plan)
  const pending = plan.status === "proposed" || plan.status === "revising"
  const topSteps = plan.steps.filter((s) => s.kind !== "branch-arm")

  return (
    <div className={cn(WIDTH, "flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5", className)}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-6 place-items-center rounded-md bg-blue/12 text-blue">
          <ClipboardList className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{plan.summary}</span>
        {plan.status === "revising" ? (
          <Pill tone="yellow" pulse>
            Revising
          </Pill>
        ) : plan.status === "approved" ? (
          <Badge tone="green" size="xs">
            Approved
          </Badge>
        ) : plan.status === "rejected" || plan.status === "stale" ? (
          <Badge tone="neutral" size="xs">
            {plan.status === "stale" ? "Stale" : "Rejected"}
          </Badge>
        ) : (
          <Pill tone="yellow" pulse>
            Planning
          </Pill>
        )}
      </div>

      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {topSteps.map((s) => (
          <li key={s.id} className="flex items-center gap-2.5 text-[12.5px] text-text-body">
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{s.number}</span>
            {s.kind === "branch" && <GitBranch className="size-3 flex-none text-purple" />}
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-2 border-t border-hairline pt-3">
        <span className="mr-auto font-mono text-[10px] text-muted-foreground">
          {plan.steps.length} steps · {branches} {branches === 1 ? "branch" : "branches"}
        </span>
        {onOpenReview && (
          <Button variant="secondary" size="sm" onClick={onOpenReview}>
            Open Plan Review
          </Button>
        )}
        {pending && (
          <Button size="sm" onClick={onApprove}>
            Approve plan &amp; start
          </Button>
        )}
      </div>
    </div>
  )
}
