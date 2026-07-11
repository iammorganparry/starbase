import { SegmentedControl, type SegmentItem } from "../components/segmented-control.js"
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"

export type TabKey = "conversation" | "pr" | "review" | "plan" | "workflow"

const LABEL: Record<TabKey, string> = {
  conversation: "Conversation",
  pr: "Pull Request",
  review: "Code Review",
  plan: "Plan Review",
  workflow: "Workflow"
}

/**
 * The main-pane tab bar. Only the `tabs` passed in are shown — the caller
 * decides which are relevant to the active session (e.g. no PR → no Pull Request
 * tab), so a tab never appears with nothing behind it.
 */
export function TabBar({
  tabs,
  active,
  onChange,
  prNumber = null,
  status
}: {
  tabs: ReadonlyArray<TabKey>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Linked PR number for the active session (badges the Pull Request tab). */
  prNumber?: number | null
  status?: { label: string; tone: "yellow" | "blue" | "green" }
}) {
  const items: ReadonlyArray<SegmentItem<TabKey>> = tabs.map((key) => ({
    value: key,
    label:
      key === "pr" && prNumber !== null ? (
        <span className="flex items-center gap-1.5">
          Pull Request
          <Badge tone="count" size="xs">
            #{prNumber}
          </Badge>
        </span>
      ) : (
        LABEL[key]
      )
  }))
  return (
    <div className="flex h-10 flex-none items-center gap-3 border-b border-hairline bg-panel px-3.5">
      <div className="flex-1" />
      <SegmentedControl items={items} value={active} onChange={onChange} />
      <div className="flex flex-1 items-center justify-end gap-2.5">
        {status && (
          <Pill tone={status.tone} pulse>
            {status.label}
          </Pill>
        )}
      </div>
    </div>
  )
}
