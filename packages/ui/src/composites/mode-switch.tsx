import type { PermissionMode } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Pill } from "../components/pill.js"
import { SegmentedControl } from "../components/segmented-control.js"

const ITEMS: ReadonlyArray<{ value: PermissionMode; label: string }> = [
  { value: "ask", label: "Ask each time" },
  { value: "accept-edits", label: "Accept edits" },
  { value: "auto", label: "Auto" }
]

/**
 * The HITL permission-mode bar from the design: a 3-way switch
 * (Ask each time / Accept edits / Auto) plus a "Paused" pill while the agent is
 * halted at an approval gate.
 */
export function ModeSwitch({
  mode,
  onChange,
  paused = false,
  className
}: {
  mode: PermissionMode
  onChange?: (mode: PermissionMode) => void
  paused?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {paused && (
        <Pill tone="yellow" dot pulse>
          Paused
        </Pill>
      )}
      <span className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground">MODE</span>
      <SegmentedControl items={ITEMS} value={mode} onChange={onChange} />
    </div>
  )
}
