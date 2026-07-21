import type { ReactNode } from "react"
import type { DiffStat, Session, SessionActivity } from "@starbase/core"
import type { DockSide } from "./terminal-panel.js"
import type { Pane, SplitGroup } from "./split-layout.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { effectiveDock } from "./dock-fit.js"
import { SplitView } from "./split-view.js"
import { SessionPane, type ConversationPaneCtx } from "../screens/session-pane.js"

export interface SessionSplitProps {
  /** The group on screen — one pane per session. `null` renders the empty state. */
  group: SplitGroup | null
  sessions: ReadonlyArray<Session>
  /** Move the focus ring (and, downstream, singleton ownership) to a pane. */
  onFocusPane?: (index: number) => void
  /** A session was dropped on a pane's edge — insert it as a new pane at `at`. */
  onSplitWith?: (sessionId: string, at: number) => void
  /** A session was dropped on a pane's middle — swap that pane's session. */
  onReplacePane?: (index: number, sessionId: string) => void
  /** Continuous divider drag, as a fraction of the row's width. */
  onResize?: (index: number, delta: number) => void
  /** Close one pane, leaving its session running. */
  onClosePane?: (index: number) => void
  /** Reorder the focused pane — Arc's Move Left / Move Right. */
  onMovePane?: (index: number, direction: -1 | 1) => void
  /** Shown when nothing is on screen at all. */
  emptyState?: ReactNode
  /** Everything a pane needs to render one session. */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  conversationPane?: ReactNode
  planSessions?: ReadonlySet<string>
  liveActivity?: Record<string, SessionActivity>
  liveDiff?: Record<string, DiffStat>
  onOpenSettings?: () => void
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderIssue?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderTerminalDock?: (session: Session) => ReactNode
  terminalDockSide?: DockSide
  renderBrowserDock?: (session: Session | null) => ReactNode
  browserDockSide?: DockSide
  onToggleBrowser?: () => void
  browserActive?: boolean
}

/**
 * The split, wired to real sessions — `SplitView`'s geometry with a live
 * `SessionPane` inside each pane, and the two docks mounted around it.
 *
 * The layering is deliberate: `SplitView` knows about panes, ratios and drops and
 * nothing about sessions, which is what let it be approved in Storybook against
 * placeholders. This file is the only place the two meet.
 */
export function SessionSplit(props: SessionSplitProps) {
  const { group, sessions } = props
  const panes = group?.panes ?? []
  const single = panes.length <= 1

  // The session the per-session docks follow: the focused pane's, falling back to
  // the first pane so closing the focused one never strands them.
  const dockSessionId = group === null ? null : (group.panes[group.focused]?.sessionId ?? group.panes[0]?.sessionId ?? null)
  const dockSession = dockSessionId === null ? null : (sessions.find((s) => s.id === dockSessionId) ?? null)

  const renderPane = (pane: Pane, index: number) => {
    const session = sessions.find((s) => s.id === pane.sessionId)
    // A pane pointing at a session that has gone is transient — `prune` in
    // `useSplitLayout` removes it on the next tick. Render nothing rather than
    // throwing in the frame between.
    if (!session) return null
    return (
      <SessionPane
        session={session}
        renderConversation={props.renderConversation}
        conversationPane={props.conversationPane}
        planSessions={props.planSessions}
        liveActivity={props.liveActivity}
        liveDiff={props.liveDiff}
        onOpenSettings={props.onOpenSettings}
        // Identity only where it disambiguates: a group of one needs no chip,
        // and `group` is non-null wherever a pane is being rendered at all.
        pane={single ? undefined : { index, focused: index === (group?.focused ?? 0) }}
        renderPullRequest={props.renderPullRequest}
        renderReview={props.renderReview}
        renderCode={props.renderCode}
        renderIssue={props.renderIssue}
        // The docks are mounted ONCE below, outside the pane loop, so the toggle
        // is app-level and every pane's copy drives the same dock.
        onToggleBrowser={props.onToggleBrowser}
        browserActive={props.browserActive}
        // No close control in a group of one: there is nothing to close back to,
        // so it would only be a way to blank the app.
        onClosePane={single || !props.onClosePane ? undefined : () => props.onClosePane?.(index)}
        // Reordering only means something with a neighbour to trade places with;
        // the ends are handled by the reducer refusing to move past them.
        onMovePaneLeft={single || !props.onMovePane || index === 0 ? undefined : () => props.onMovePane?.(index, -1)}
        onMovePaneRight={
          single || !props.onMovePane || index === panes.length - 1
            ? undefined
            : () => props.onMovePane?.(index, 1)
        }
      />
    )
  }

  // Both docks are mounted HERE, once, outside the pane loop — never inside a
  // pane.
  //
  // The browser preview drives a single native `WebContentsView` in the main
  // process and its unmount cleanup calls `browserPreviewClose()`, with the
  // current URL held in component state. Mounting it inside the focused pane
  // meant that clicking a different pane — to type in its composer, say —
  // unmounted it and remounted a fresh one, destroying the view and reopening at
  // the default URL. You would lose the page, its history and your scroll
  // position just by clicking the pane next to it.
  //
  // The terminal dock is per-SESSION rather than per-pane, so it stays mounted
  // and simply takes whichever session currently owns it as a prop. Passing a
  // prop re-runs its queries; unmounting it would throw away the xterm buffer.
  const dock = dockSession && props.renderTerminalDock ? props.renderTerminalDock(dockSession) : null
  // Session-agnostic (it points at localhost), which is exactly why hoisting it
  // out of the panes costs nothing.
  const browserDock = props.renderBrowserDock ? props.renderBrowserDock(dockSession) : null
  // Where each dock GOES. The same pure rule the docks apply to their own
  // borders and size (`dock-fit.ts`), evaluated against the same shell width, so
  // placement and appearance can't disagree — a right-docked panel rendered into
  // the bottom row would draw a left border across the middle of the window.
  const { width: shellWidth } = usePaneWidth()
  const termSide = effectiveDock(props.terminalDockSide ?? "bottom", shellWidth)
  const browserSide = effectiveDock(props.browserDockSide ?? "right", shellWidth)

  // RIGHT-docked panes sit beside the whole split; BOTTOM-docked ones stack under
  // that row. Each dock CSS-hides itself when closed, so this holds for 0, 1 or 2
  // open docks on independent sides.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <SplitView
          group={group}
          renderPane={renderPane}
          onFocusPane={props.onFocusPane}
          onSplitWith={props.onSplitWith}
          onReplacePane={props.onReplacePane}
          onResize={props.onResize}
          emptyState={props.emptyState}
        />
        {termSide === "right" ? dock : null}
        {browserSide === "right" ? browserDock : null}
      </div>
      {termSide === "bottom" ? dock : null}
      {browserSide === "bottom" ? browserDock : null}
    </div>
  )
}
