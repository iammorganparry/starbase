import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
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
  MoreHorizontal,
  PanelRight,
  Waypoints,
  Workflow,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"

/** The icon-button styling every control in the right-hand cluster shares. */
const ACTION_CLASS = "flex size-6 flex-none items-center justify-center rounded transition-colors hover:bg-hairline"

/**
 * The pane's own actions, folded into one button.
 *
 * Only reached below the `mid` tier. The labels are IDENTICAL to the inline
 * buttons' `aria-label`s on purpose: a by-name lookup (the e2e suite, a screen
 * reader user, anyone's muscle memory for the command palette) should find the
 * same control by the same name whether it's inline or behind the menu. What
 * changes at narrow widths is where a control sits, never what it's called.
 */
function PaneActionsMenu({
  onToggleSplit,
  splitActive,
  onToggleBrowser,
  browserActive,
  onMovePaneLeft,
  onMovePaneRight
}: {
  onToggleSplit?: () => void
  splitActive: boolean
  onToggleBrowser?: () => void
  browserActive: boolean
  onMovePaneLeft?: () => void
  onMovePaneRight?: () => void
}) {
  const items: Array<{ label: string; icon: LucideIcon; active?: boolean; onSelect: () => void }> = []
  if (onToggleSplit)
    items.push({ label: "Split plan beside conversation", icon: PanelRight, active: splitActive, onSelect: onToggleSplit })
  if (onToggleBrowser)
    items.push({ label: "Browser preview", icon: Globe, active: browserActive, onSelect: onToggleBrowser })
  if (onMovePaneLeft) items.push({ label: "Move pane left", icon: ChevronLeft, onSelect: onMovePaneLeft })
  if (onMovePaneRight) items.push({ label: "Move pane right", icon: ChevronRight, onSelect: onMovePaneRight })

  // Nothing to collapse — render nothing rather than a button that opens onto an
  // empty menu. A single-pane group with no plan and no browser hits this.
  if (items.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More pane actions"
          data-testid="pane-actions-menu"
          title="More pane actions"
          className={cn(ACTION_CLASS, "text-dim hover:text-text-bright")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          // `collisionPadding` keeps the menu off the window edge, which matters
          // far more here than usual: this only renders when the pane is narrow,
          // which is exactly when the window tends to be narrow too.
          collisionPadding={8}
          className="z-50 flex min-w-[200px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              aria-label={item.label}
              onSelect={item.onSelect}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none",
                "data-[highlighted]:bg-surface data-[highlighted]:text-text-bright",
                item.active ? "text-blue" : "text-text-body"
              )}
            >
              <item.icon size={13} className="flex-none" />
              <span className="flex-1 truncate">{item.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

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
  // The PANE's width, not the window's. A four-way split on a 4K display gives
  // every pane a `narrow` tier; a maximised single pane on a laptop gives
  // `wide`. Keying off the window would get both backwards.
  const tier = useWidthTier()
  // Below `wide`, inactive tabs shed their labels. The active one keeps its —
  // stripping every label leaves a row of seven near-identical glyphs with no
  // answer to "what am I looking at", which is the one question the tab bar
  // exists to answer.
  const iconOnly = !atLeast(tier, "wide")
  // Below `mid`, the pane's own actions fold into one button. Close is exempt
  // (see below): burying the only way out of a pane you can't read is a trap.
  const collapseActions = !atLeast(tier, "mid")

  return (
    <div
      data-testid="session-tab-bar"
      data-tier={tier}
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
          <span
            className={cn(
              "truncate text-[12px]",
              atLeast(tier, "mid") ? "max-w-[170px]" : "max-w-[86px]"
            )}
          >
            {pane.title}
          </span>
        </div>
      )}
      {/*
        `min-w-0 flex-1 overflow-x-auto` is the whole fix for this row.

        Without `min-w-0` a flex child's floor is its MIN-CONTENT width, and
        every label here is `whitespace-nowrap`, so the strip's floor was roughly
        970px — in a pane that the split model will happily make 350px. The
        surplus didn't wrap or scroll, it was simply clipped by the pane's
        `overflow-hidden`, taking the right-hand cluster with it. The scrollbar
        is hidden (`sb-no-scrollbar`) because it would eat a third of a 36px row.
      */}
      <div className="sb-no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((key) => {
          const Icon = ICON[key]
          const isActive = key === active
          const showLabel = !iconOnly || isActive
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              aria-current={isActive ? "page" : undefined}
              // The name has to survive the label being hidden — this is what a
              // screen reader and `getByRole("tab", { name })` read once the
              // text is gone, and it doubles as the hover tooltip.
              aria-label={LABEL[key]}
              title={LABEL[key]}
              className={cn(
                "group relative flex flex-none items-center gap-2 border-r border-hairline text-[12.5px] outline-none transition-colors",
                // Icon-only cells lose the label's optical weight, so the
                // horizontal padding tightens with it rather than leaving each
                // glyph marooned in a 60px cell.
                showLabel ? "px-3.5" : "px-2.5",
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
              {showLabel && <span className="whitespace-nowrap">{LABEL[key]}</span>}
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
      {/*
        `flex-none`, not `flex-1`. As `flex-1` with no `min-w-0` this cluster was
        the FIRST thing the browser squeezed when the row overflowed, so close-
        pane and move-pane vanished before a single tab label did — the controls
        you reach for precisely because the pane is too narrow.
      */}
      <div className="flex flex-none items-center justify-end gap-2.5 px-3.5">
        {status && (
          // The status word is the first thing to go: it's a duplicate of the
          // sidebar row's own indicator, so nothing is lost that isn't on screen
          // a few hundred pixels to the left.
          <span className={cn("flex-none", !atLeast(tier, "mid") && "hidden")}>
            <Pill tone={status.tone} pulse title={status.detail}>
              {status.label}
            </Pill>
          </span>
        )}
        {collapseActions && (
          <PaneActionsMenu
            onToggleSplit={onToggleSplit}
            splitActive={splitActive}
            onToggleBrowser={onToggleBrowser}
            browserActive={browserActive}
            onMovePaneLeft={onMovePaneLeft}
            onMovePaneRight={onMovePaneRight}
          />
        )}
        {!collapseActions && onToggleSplit && (
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
        {!collapseActions && onToggleBrowser && (
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
        {!collapseActions && (onMovePaneLeft || onMovePaneRight) && (
          // Grouped with the close × rather than beside the tabs: these are all
          // operations on the PANE, not on what's inside it.
          <div className="flex flex-none items-center">
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
        {/* Never collapsed, at any tier. Every other control here has an
            alternative route (a chord, the sidebar, the menu above); closing an
            unreadable pane is the one thing you'd reach for BECAUSE the pane is
            unreadable, so it stays a one-click target all the way down. */}
        {onClosePane && (
          <button
            type="button"
            onClick={onClosePane}
            aria-label="Close pane"
            data-testid="close-pane"
            title="Close pane (the session keeps running)"
            className={cn(ACTION_CLASS, "text-dim hover:text-text-bright")}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
