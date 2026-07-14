import {
  FileDiff,
  GitCompareArrows,
  GitPullRequest,
  type LucideIcon,
  MessagesSquare,
  Waypoints,
  Workflow
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"

export type TabKey = "conversation" | "changes" | "pr" | "review" | "plan" | "workflow"

const LABEL: Record<TabKey, string> = {
  conversation: "Conversation",
  changes: "Changes",
  pr: "Pull Request",
  review: "Code Review",
  plan: "Plan Review",
  workflow: "Workflow"
}

const ICON: Record<TabKey, LucideIcon> = {
  conversation: MessagesSquare,
  changes: FileDiff,
  pr: GitPullRequest,
  review: GitCompareArrows,
  plan: Waypoints,
  workflow: Workflow
}

/**
 * The main-pane tab bar — IDE/editor-style tabs. Each tab is a flat cell on a
 * darker strip; the active one matches the editor background (so it reads as the
 * foreground surface) with a top accent. Only the `tabs` passed in are shown, so
 * a tab never appears with nothing behind it. The row layout leaves room for a
 * future close affordance (per-tab) when file/code views land.
 */
export function TabBar({
  tabs,
  active,
  onChange,
  prNumber = null,
  changes = null,
  status
}: {
  tabs: ReadonlyArray<TabKey>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Linked PR number for the active session (badges the Pull Request tab). */
  prNumber?: number | null
  /** Live worktree diff totals, shown as `+N −N` on the Changes tab. */
  changes?: { added: number; removed: number } | null
  status?: { label: string; tone: "yellow" | "blue" | "green" }
}) {
  return (
    <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-sunken">
      <div className="flex items-stretch">
        {tabs.map((key) => {
          const Icon = ICON[key]
          const isActive = key === active
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-2 border-r border-hairline px-3.5 text-[12.5px] outline-none transition-colors",
                isActive
                  ? "bg-editor text-text"
                  : "text-muted-foreground hover:bg-panel hover:text-text"
              )}
            >
              {/* Active accent — the tab reads as connected to the content below. */}
              {isActive && <span className="absolute inset-x-0 top-0 h-0.5 bg-blue" />}
              <Icon
                className={cn(
                  "size-3.5 flex-none",
                  isActive ? "text-blue" : "text-dim group-hover:text-muted-foreground"
                )}
              />
              <span className="whitespace-nowrap">{LABEL[key]}</span>
              {key === "pr" && prNumber !== null && (
                <Badge tone="count" size="xs">
                  #{prNumber}
                </Badge>
              )}
              {key === "changes" && changes && changes.added + changes.removed > 0 && (
                <span className="flex items-center gap-1 font-mono text-[10.5px] tabular-nums">
                  <span className="text-green">+{changes.added}</span>
                  <span className="text-red">−{changes.removed}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex flex-1 items-center justify-end gap-2.5 px-3.5">
        {status && (
          <Pill tone={status.tone} pulse>
            {status.label}
          </Pill>
        )}
      </div>
    </div>
  )
}
