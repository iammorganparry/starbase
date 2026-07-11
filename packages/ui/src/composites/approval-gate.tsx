import { KeyRound } from "lucide-react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"

/**
 * Human-in-the-loop approval gate — pauses the agent for the operator's call.
 * Matches the design's command-approval card.
 */
export function ApprovalGate({
  title = "Approval needed · run a command",
  command,
  onAllow,
  onDeny,
  onAlways,
  className
}: {
  title?: string
  command: string
  onAllow?: () => void
  onDeny?: () => void
  onAlways?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-blue/50 bg-blue/[0.05]",
        className
      )}
    >
      <div className="flex items-center gap-[9px] border-b border-blue/20 px-3 py-[9px]">
        <span className="flex size-5 items-center justify-center rounded-md bg-blue/[0.16] text-blue">
          <KeyRound size={11} />
        </span>
        <span className="flex-1 text-[12px] font-semibold text-text-bright">{title}</span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-blue">
          <StatusDot tone="bg-blue" size={6} pulse />
          waiting
        </span>
      </div>
      <div className="flex flex-col gap-[9px] px-3 py-2.5">
        <div className="flex items-center gap-[9px] rounded-md border border-line bg-sunken px-2.5 py-[7px] font-mono text-[12px]">
          <span className="text-green">❯</span>
          <span className="flex-1 text-text-bright">{command}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={onDeny}>
            Deny
            <Kbd>esc</Kbd>
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" size="sm" onClick={onAlways}>
            Always
          </Button>
          <Button variant="primary" size="sm" onClick={onAllow}>
            Allow once
            <Kbd onFill>⌥↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
