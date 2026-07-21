import type { ReactNode } from "react"
import type { CliInfo, DiffStat, SessionPrStatus, Session, SessionActivity, User } from "@starbase/core"
import type { DockSide } from "../app/terminal-panel.js"
import { SessionSidebar } from "../app/session-sidebar.js"
import { SessionSplit } from "../app/session-split.js"
import type { SplitGroup } from "../app/split-layout.js"
import { EmptyConversation } from "./empty-conversation.js"
import type { ConversationPaneCtx } from "./session-pane.js"

// The pane ctx is part of this screen's public surface (StarbaseApp types its
// `renderConversation` callback with it), so keep it importable from here even
// though it's now defined alongside the pane that consumes it.
export type { ConversationPaneCtx } from "./session-pane.js"

export interface SessionConversationProps {
  sessions: ReadonlyArray<Session>
  clis: ReadonlyArray<CliInfo>
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  /**
   * The split on screen — which sessions sit in which panes, in what proportion,
   * and which pane has the operator's attention. Absent in stories, where a
   * single implicit pane holding `activeSessionId` is synthesised instead.
   */
  group?: SplitGroup | null
  /** Every split, so the sidebar can draw a multi-pane group as one pill. */
  splitGroups?: ReadonlyArray<SplitGroup>
  /** Which group is on screen (highlights its sidebar pill). */
  activeGroupId?: string | null
  /** Move the focus ring to a pane (a click anywhere inside it). */
  onFocusPane?: (index: number) => void
  /** Focus a pane of ANY group from the sidebar — activates that group too. */
  onFocusGroupPane?: (groupId: string, index: number) => void
  /** Insert a session as a new pane at `at` — what an edge drop means. */
  onSplitWith?: (sessionId: string, at: number) => void
  /** Merge a session into a named group (a drop on its sidebar pill). */
  onSplitGroupWith?: (groupId: string, sessionId: string, at: number) => void
  /** Swap a pane's session — what a drop on a pane's middle means. */
  onReplacePane?: (index: number, sessionId: string) => void
  /** Close a pane of the active group, leaving the session running. */
  onClosePane?: (index: number) => void
  /** Close a pane of any group (a sidebar segment's ×). */
  onCloseGroupPane?: (groupId: string, index: number) => void
  /** Reorder a pane within the active group. */
  onMovePane?: (index: number, direction: -1 | 1) => void
  /** Arc's "Separate all tabs" — every pane of a group flies out to its own row. */
  onSeparateAll?: (groupId: string) => void
  /** Continuous divider drag, as a fraction of the split's width. */
  onResizePane?: (index: number, delta: number) => void
  /** Which pane each on-screen session occupies, for the sidebar's badges. */
  slotBySession?: ReadonlyMap<string, number>
  /** Manually rename a session (double-click its sidebar title). */
  onRenameSession?: (id: string, title: string) => void
  /** Archive an active session from the sidebar quick-actions (undoable). */
  onArchiveSession?: (id: string) => void
  /** Restore an archived session from the sidebar quick-actions. */
  onRestoreSession?: (id: string) => void
  /** Permanently delete a session from the sidebar quick-actions (confirms first). */
  onDeleteSession?: (id: string) => void
  /**
   * The live conversation pane (the renderer's session-keyed
   * `ConversationView`). Falls back to a static seeded transcript when absent
   * (stories / standalone).
   */
  conversationPane?: ReactNode
  /**
   * The real app's session-keyed pane, rendered for BOTH the Conversation and
   * Plan tabs from the same machine (so switching to Plan never aborts a parked
   * plan run). `view` selects the face; `ctx.onOpenPlanReview` switches the tab.
   *
   * Takes the session explicitly rather than closing over the active one: the
   * grid mounts several panes at once, and each must render its OWN session.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /**
   * Show the empty state instead of the grid. The HOST owns this rule — it is
   * not re-derived here. `StarbaseApp` sets it when the grid is entirely empty
   * AND a live `renderConversation` is wired, so the Storybook/standalone path
   * (no live renderer) still shows its seeded transcript rather than the
   * first-launch screen.
   */
  showEmpty?: boolean
  /** Unified-diff patch for the Changes rail (fallback demo only). */
  patch?: string
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live linked-PR state per session id, badged onto sidebar rows. */
  prStates?: Record<string, SessionPrStatus>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Open the New Session dialog. */
  onNewSession?: () => void
  /** The signed-in user, shown in the sidebar footer account menu. */
  user?: User
  /** Open the Usage & limits modal (from the sidebar account menu). */
  onOpenUsage?: () => void
  /** Open the Settings view (from the sidebar account menu). */
  onOpenSettings?: () => void
  /** Sign out (from the sidebar account menu). */
  onSignOut?: () => void
  /**
   * When set, the Settings view is open: it replaces the main pane (tabs +
   * conversation) while the sidebar stays visible. `onOpenSettings` toggles it.
   */
  settingsView?: ReactNode
  /** Whether GitHub is connected (drives the sidebar cog's status dot). */
  ghConnected?: boolean
  /** Repo names (sidebar group keys) that are starred — pinned to the top. */
  starredRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's starred state from its sidebar header. */
  onToggleStar?: (repoName: string) => void | Promise<void>
  /** Repo names (sidebar group keys) collapsed to hide their sessions. */
  collapsedRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's collapsed state from its sidebar header. */
  onToggleCollapsed?: (repoName: string) => void | Promise<void>
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Issue tab — the rich linked-issue view (shown when one is linked). */
  renderIssue?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /**
   * Render the per-session terminal dock (the desktop app's live TerminalDock).
   * Docked to the main content column beside/below the tab body — never shown in
   * the Settings or empty states. Absent in stories.
   */
  renderTerminalDock?: (session: Session) => ReactNode
  /** Which edge the terminal dock attaches to — drives the content column's flow. */
  terminalDockSide?: DockSide
  /**
   * Render the embedded browser-preview dock (desktop app's BrowserPreviewView).
   * Docked beside/below the tab body like the terminal dock; absent in stories.
   */
  renderBrowserDock?: (session: Session | null) => ReactNode
  /** Which edge the browser dock attaches to. */
  browserDockSide?: DockSide
  /** Toggle the browser-preview pane (shows a control in the tab bar). */
  onToggleBrowser?: () => void
  /** Whether the browser-preview pane is currently open. */
  browserActive?: boolean
  /** App version, shown in the sidebar footer. */
  version?: string
}

/**
 * Screen 01 — the primary session workspace.
 *
 * Owns the app-level furniture: the sidebar, the Settings takeover, and the
 * first-launch empty state. Everything belonging to ONE session (its tab bar,
 * tab body and docks) lives in `SessionPane`, which is what the grid multiplies.
 */
export function SessionConversation(props: SessionConversationProps) {
  // Stories and standalone use pass no split — synthesise the one-pane group
  // holding whatever `activeSessionId` says, so this screen renders identically
  // either way. A one-pane group is not a special case; it is what a single
  // session IS in this model.
  const group: SplitGroup | null =
    props.group !== undefined
      ? props.group
      : props.activeSessionId === null
        ? null
        : { id: "standalone", panes: [{ sessionId: props.activeSessionId, ratio: 1 }], focused: 0 }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SessionSidebar
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        slotBySession={props.slotBySession}
        splitGroups={props.splitGroups}
        activeGroupId={props.activeGroupId}
        onFocusPane={props.onFocusGroupPane}
        onClosePane={props.onCloseGroupPane}
        onSeparateAll={props.onSeparateAll}
        onSplitWith={props.onSplitGroupWith}
        onSelect={props.onSelectSession}
        onRename={props.onRenameSession}
        onArchive={props.onArchiveSession}
        onRestore={props.onRestoreSession}
        onDelete={props.onDeleteSession}
        liveActivity={props.liveActivity}
        prStates={props.prStates}
        onNewSession={props.onNewSession}
        user={props.user}
        onOpenUsage={props.onOpenUsage}
        onOpenSettings={props.onOpenSettings}
        onSignOut={props.onSignOut}
        ghConnected={props.ghConnected}
        starredRepoNames={props.starredRepoNames}
        onToggleStar={props.onToggleStar}
        collapsedRepoNames={props.collapsedRepoNames}
        onToggleCollapsed={props.onToggleCollapsed}
        version={props.version}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
        {props.settingsView ? (
          props.settingsView
        ) : props.showEmpty ? (
          <EmptyConversation
            clis={props.clis}
            version={props.version}
            onNewSession={props.onNewSession}
          />
        ) : (
          <SessionSplit
            group={group}
            sessions={props.sessions}
            onFocusPane={props.onFocusPane}
            onSplitWith={props.onSplitWith}
            onReplacePane={props.onReplacePane}
            onResize={props.onResizePane}
            onClosePane={props.onClosePane}
            onMovePane={props.onMovePane}
            emptyState={
              <span className="text-[12px] text-dim">Nothing on screen — pick a session</span>
            }
            renderConversation={props.renderConversation}
            conversationPane={props.conversationPane}
            planSessions={props.planSessions}
            liveActivity={props.liveActivity}
            liveDiff={props.liveDiff}
            onOpenSettings={props.onOpenSettings}
            renderPullRequest={props.renderPullRequest}
            renderReview={props.renderReview}
            renderCode={props.renderCode}
            renderIssue={props.renderIssue}
            renderTerminalDock={props.renderTerminalDock}
            terminalDockSide={props.terminalDockSide}
            renderBrowserDock={props.renderBrowserDock}
            browserDockSide={props.browserDockSide}
            onToggleBrowser={props.onToggleBrowser}
            browserActive={props.browserActive}
          />
        )}
      </div>
    </div>
  )
}
