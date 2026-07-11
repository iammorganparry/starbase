import { KeyRound } from "lucide-react"
import type { GateDecision, GateKind, GateStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"

const RESOLVED_LABEL: Record<Exclude<GateStatus, "pending">, string> = {
  approved: "Allowed",
  rejected: "Denied",
  always: "Always allowed"
}

/**
 * Human-in-the-loop approval gate — pauses the agent for the operator's call.
 * Renders both the command variant (with the shell command awaiting approval) and
 * the edit variant, and its resolved state once decided. Wired through `onDecide`.
 */
export function ApprovalGate({
  kind,
  title,
  detail,
  command,
  allowLabel,
  status,
  onDecide,
  className
}: {
  kind: GateKind
  title: string
  detail: string
  command?: string | null
  allowLabel?: string | null
  status: GateStatus
  onDecide?: (decision: GateDecision) => void
  className?: string
}) {
  const pending = status === "pending"
  return (
    <div className={cn("overflow-hidden rounded-xl border border-blue/50 bg-blue/[0.05]", className)}>
      <div className="flex items-center gap-[9px] border-b border-blue/20 px-3 py-[9px]">
        <span className="flex size-5 items-center justify-center rounded-md bg-blue/[0.16] text-blue">
          <KeyRound size={11} />
        </span>
        <span className="flex-1 text-[12px] font-semibold text-text-bright">{title}</span>
        {pending ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-blue">
            <StatusDot tone="bg-blue" size={6} pulse />
            waiting
          </span>
        ) : (
          <span
            className={cn(
              "font-mono text-[10px]",
              status === "rejected" ? "text-red" : "text-green"
            )}
          >
            {RESOLVED_LABEL[status]}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-[9px] px-3 py-2.5">
        {kind === "command" && command && (
          <div className="flex items-center gap-[9px] rounded-md border border-line bg-sunken px-2.5 py-[7px] font-mono text-[12px]">
            <span className="text-green">❯</span>
            <span className="flex-1 text-text-bright">{command}</span>
          </div>
        )}
        <span className="text-[12px] leading-[1.5] text-muted-foreground">{detail}</span>
        {pending && (
          <div className="flex items-center gap-2">
            <Button variant="danger" size="sm" onClick={() => onDecide?.("deny")}>
              Deny
              <Kbd>esc</Kbd>
            </Button>
            <div className="flex-1" />
            {allowLabel && (
              <Button variant="secondary" size="sm" onClick={() => onDecide?.("always")}>
                Always allow <span className="font-mono text-dim">{allowLabel}</span>
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => onDecide?.("allow")}>
              Allow once
              <Kbd onFill>⌥↵</Kbd>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
