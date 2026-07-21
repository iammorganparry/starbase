import type { ExecutionMode } from "@starbase/core"
import { Check, Zap } from "lucide-react"
import { Button } from "../components/button.js"
import { ButtonGroup } from "../components/button-group.js"

export function PlanApprovalActions({
  onApprove,
  className
}: {
  onApprove?: (executionMode?: ExecutionMode) => void
  className?: string
}) {
  return (
    <ButtonGroup aria-label="Plan approval options" className={className}>
      <Button size="sm" onClick={() => onApprove?.()}>
        <Check className="size-3" />
        Approve
      </Button>
      <Button variant="secondary" size="sm" onClick={() => onApprove?.("auto")}>
        <Zap className="size-3 text-yellow" />
        Approve and auto
      </Button>
    </ButtonGroup>
  )
}
