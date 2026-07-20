import {
  CircleDot,
  FileDiff,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  type LucideIcon,
  MessagesSquare,
  PanelRight,
  Waypoints,
  Workflow,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"

export type TabKey = "conversation" | "issue" | "changes" | "pr" | "review" | "plan" | "workflow"

const LABEL: Record<TabKey, string> = {
  conversation: "Conversation",
  issue: "Issue",
  changes: "Changes",
  pr: "Pull Request",
  review: "Code Review",
  plan: "Plan Review",
  workflow: "Workflow"
}

const ICON: Record<TabKey, LucideIcon> = {
  conversation: MessagesSquare,
  issue: CircleDot,
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
  status,
  onToggleBrowser,
  browserActive = false,
  browserDisabled = false,
  browserDisabledReason,
  onToggleSplit,
  splitActive = false,
  onClosePane
}: {
  tabs: ReadonlyArray<TabKey>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Linked PR number for the active session (badges the Pull Request tab). */
  prNumber?: number | null
  /** Live worktree diff totals, shown as `+N −N` on the Changes tab. */
  changes?: { added: number; removed: number } | null
  status?: { label: string; tone: "yellow" | "blue" | "green" }
  /** Toggle the embedded browser preview pane (desktop only; absent in stories). */
  onToggleBrowser?: () => void
  /** Whether the browser preview pane is currently open (highlights the toggle). */
  browserActive?: boolean
  /**
   * Greys out the browser toggle. The preview is a single native view owned by
   * the whole app, so only the FOCUSED pane in a grid can drive it — the others
   * show the control (its absence would read as a missing feature) but inert.
   */
  browserDisabled?: boolean
  /** Tooltip explaining why the toggle is inert, e.g. "Browser preview is in pane 1". */
  browserDisabledReason?: string
  /**
   * Open Plan Review beside the transcript. Omitted — and so hidden — unless the
   * split is actually available: the session has a plan AND the conversation tab
   * is the one on screen. A control that does nothing where it sits is worse than
   * no control at all.
   */
  onToggleSplit?: () => void
  /** Whether the plan is currently split beside the conversation. */
  splitActive?: boolean
  /**
   * Empty this pane's grid slot. Shown only in a multi-pane layout: in 1-up there
   * is nothing to close back TO, and the control would just be a way to blank the
   * app. Closing a slot never touches the session — its agent keeps running.
   */
  onClosePane?: () => void
}) {
  return (
    <div
      data-testid="session-tab-bar"
      className="flex h-9 flex-none items-stretch border-b border-hairline bg-sunken"
    >
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
        {onToggleSplit && (
          <button
            type="button"
            onClick={onToggleSplit}
            aria-label="Split plan beside conversation"
            aria-pressed={splitActive}
            title="Split plan beside conversation"
            className={cn(
              "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
              splitActive ? "text-blue" : "text-dim hover:text-text-bright"
            )}
          >
            <PanelRight className="size-4" />
          </button>
        )}
        {onToggleBrowser && (
          <button
            type="button"
            onClick={onToggleBrowser}
            disabled={browserDisabled}
            aria-label="Browser preview"
            aria-pressed={browserActive}
            data-testid="toggle-browser"
            title={browserDisabledReason ?? "Toggle browser preview (⌃⇧B)"}
            className={cn(
              "flex size-6 items-center justify-center rounded transition-colors",
              browserDisabled
                ? "cursor-not-allowed text-dim/40"
                : "hover:bg-hairline " +
                  (browserActive ? "text-blue" : "text-dim hover:text-text-bright")
            )}
          >
            <Globe className="size-4" />
          </button>
        )}
        {onClosePane && (
          <button
            type="button"
            onClick={onClosePane}
            aria-label="Close pane"
            data-testid="close-pane"
            title="Close pane (the session keeps running)"
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
