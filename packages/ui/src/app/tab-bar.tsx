import {
  ChevronLeft,
  ChevronRight,
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
  pane,
  onToggleBrowser,
  browserActive = false,
  onToggleSplit,
  splitActive = false,
  onClosePane,
  onMovePaneLeft,
  onMovePaneRight
}: {
  tabs: ReadonlyArray<TabKey>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Linked PR number for the active session (badges the Pull Request tab). */
  prNumber?: number | null
  /** Live worktree diff totals, shown as `+N −N` on the Changes tab. */
  changes?: { added: number; removed: number } | null
  /**
   * The session's state as ONE of the five reported words ("Thinking",
   * "Running", …) — never the tool or target, which is what the sidebar row
   * shows too. `detail` carries the specifics ("Running npm test -- auth") to
   * the hover title, where they can't grow the pill on every tool call.
   */
  status?: { label: string; tone: "yellow" | "blue" | "green"; detail?: string }
  /**
   * Which session this pane holds, when that is a question worth answering —
   * i.e. only in a split. A tab bar says what you can look at and never said
   * whose; with two transcripts side by side the only way to tell them apart was
   * to read them.
   *
   * `index` is 0-based here and rendered 1-based, matching the sidebar's slot
   * badge and the ⌃⇧1..4 chords — one numbering for a pane, wherever it's named.
   * Omit entirely in a group of one, where the sidebar's selection already says
   * it and a chip would be a label on the only thing on screen.
   */
  pane?: { index: number; title: string; focused: boolean }
  /** Toggle the embedded browser preview pane (desktop only; absent in stories). */
  onToggleBrowser?: () => void
  /** Whether the browser preview pane is currently open (highlights the toggle). */
  browserActive?: boolean
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
   * Close this pane. Shown only in a multi-pane split: in a group of one there
   * is nothing to close back TO, and the control would just be a way to blank the
   * app. Closing a pane never touches the session — its agent keeps running.
   */
  onClosePane?: () => void
  /**
   * Swap this pane with the one on its left (Arc's Move Left, ⌃⇧⌥←). Absent at
   * the left-hand end — a control that can only fail is worse than no control.
   */
  onMovePaneLeft?: () => void
  /** Swap this pane with the one on its right (Move Right, ⌃⇧⌥→). */
  onMovePaneRight?: () => void
}) {
  return (
    <div
      data-testid="session-tab-bar"
      className="flex h-9 flex-none items-stretch border-b border-hairline bg-sunken"
    >
      {pane && (
        <div
          data-testid={`pane-chip-${pane.index}`}
          title={`Pane ${pane.index + 1} — ${pane.title} (⌃⇧${pane.index + 1})`}
          className={cn(
            "flex flex-none items-center gap-1.5 border-r border-hairline pl-3 pr-3.5",
            // Dimmed when the pane isn't the focused one, so the chips answer
            // "which is which" and "which is listening" with one glance rather
            // than competing with the focus ring for the second question.
            pane.focused ? "text-text" : "text-dim"
          )}
        >
          <Badge tone={pane.focused ? "blue" : "count"} size="xs">
            {pane.index + 1}
          </Badge>
          <span className="max-w-[170px] truncate text-[12px]">{pane.title}</span>
        </div>
      )}
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
          <Pill tone={status.tone} pulse title={status.detail}>
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
            aria-label="Browser preview"
            aria-pressed={browserActive}
            data-testid="toggle-browser"
            title="Toggle browser preview (⌃⇧B)"
            className={cn(
              "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
              browserActive ? "text-blue" : "text-dim hover:text-text-bright"
            )}
          >
            <Globe className="size-4" />
          </button>
        )}
        {(onMovePaneLeft || onMovePaneRight) && (
          // Grouped with the close × rather than beside the tabs: these are all
          // operations on the PANE, not on what's inside it.
          <div className="flex items-center">
            {onMovePaneLeft && (
              <button
                type="button"
                onClick={onMovePaneLeft}
                aria-label="Move pane left"
                data-testid="move-pane-left"
                title="Move pane left (⌃⇧⌥←)"
                className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            {onMovePaneRight && (
              <button
                type="button"
                onClick={onMovePaneRight}
                aria-label="Move pane right"
                data-testid="move-pane-right"
                title="Move pane right (⌃⇧⌥→)"
                className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
              >
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
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
