import type { PlanStepAssignee } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { PROVIDER_LABEL, ProviderIcon } from "../components/provider-icon.js"

export function PlanAssignee({
  assignee,
  compact = false,
  className
}: {
  assignee: PlanStepAssignee
  compact?: boolean
  className?: string
}) {
  const label = `Assigned to ${assignee.cli} ${assignee.model}`

  if (compact) {
    return (
      <span
        aria-label={label}
        title={`${label}${assignee.reason ? ` — ${assignee.reason}` : ""}`}
        className={cn(
          "flex min-w-0 max-w-[132px] flex-none items-center gap-1.5 rounded-md bg-surface px-1.5 py-1 text-[10px] text-text-body shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]",
          className
        )}
      >
        <ProviderIcon cli={assignee.cli} size={12} />
        <span className="truncate font-mono">{assignee.model}</span>
      </span>
    )
  }

  return (
    <div
      aria-label={label}
      className={cn(
        "flex items-start gap-3 rounded-lg bg-panel p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]",
        className
      )}
    >
      <span className="grid size-9 flex-none place-items-center rounded-md bg-surface">
        <ProviderIcon cli={assignee.cli} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.45px] text-muted-foreground">
          Assigned model
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-mono text-[12.5px] font-semibold text-text">
            {assignee.model}
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            via {PROVIDER_LABEL[assignee.cli]}
          </span>
        </div>
        {assignee.reason && (
          <p className="m-0 mt-1 text-pretty text-[11.5px] leading-[1.45] text-text-body">
            {assignee.reason}
          </p>
        )}
        {assignee.evidence && (
          <span className="mt-1.5 inline-flex rounded-sm bg-blue/10 px-1.5 py-0.5 font-mono text-[9.5px] text-blue">
            [{assignee.evidence.level}, n={assignee.evidence.observations}]
          </span>
        )}
      </div>
    </div>
  )
}
