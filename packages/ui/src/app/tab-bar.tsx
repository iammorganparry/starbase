import { SegmentedControl, type SegmentItem } from "../components/segmented-control.js"
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"

export type TabKey = "conversation" | "pr" | "review" | "plan" | "workflow"

/** Tabs, with the PR badge shown only when the active session has a linked PR. */
const tabs = (prNumber: number | null): ReadonlyArray<SegmentItem<TabKey>> => [
  { value: "conversation", label: "Conversation" },
  {
    value: "pr",
    label: (
      <span className="flex items-center gap-1.5">
        Pull Request
        {prNumber !== null && (
          <Badge tone="count" size="xs">
            #{prNumber}
          </Badge>
        )}
      </span>
    )
  },
  { value: "review", label: "Code Review" },
  { value: "plan", label: "Plan Review" },
  { value: "workflow", label: "Workflow" }
]

/** The main-pane tab bar: centered segmented control + right-hand status. */
export function TabBar({
  active,
  onChange,
  prNumber = null,
  status,
  cost
}: {
  active: TabKey
  onChange: (key: TabKey) => void
  /** Linked PR number for the active session, or null. */
  prNumber?: number | null
  status?: { label: string; tone: "yellow" | "blue" | "green" }
  cost?: string
}) {
  return (
    <div className="flex h-10 flex-none items-center gap-3 border-b border-hairline bg-panel px-3.5">
      <div className="flex-1" />
      <SegmentedControl items={tabs(prNumber)} value={active} onChange={onChange} />
      <div className="flex flex-1 items-center justify-end gap-2.5">
        {status && (
          <Pill tone={status.tone} pulse>
            {status.label}
          </Pill>
        )}
        {cost && <span className="font-mono text-[11px] text-dim">{cost}</span>}
      </div>
    </div>
  )
}
