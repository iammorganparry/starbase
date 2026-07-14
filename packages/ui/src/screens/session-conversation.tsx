import { type ReactNode, useState } from "react"
import type { CliInfo, Session, SessionStatus, User } from "@starbase/core"
import { cn } from "../lib/cn.js"
import type { DockSide } from "../app/terminal-panel.js"
import { SessionSidebar } from "../app/session-sidebar.js"
import { TabBar, type TabKey } from "../app/tab-bar.js"
import { ConversationView } from "../app/conversation-view.js"
import { SEED_CONVERSATION } from "../seed.js"
import { EmptyConversation } from "./empty-conversation.js"
import { StubScreen } from "./stub-screen.js"

export interface SessionConversationProps {
  sessions: ReadonlyArray<Session>
  clis: ReadonlyArray<CliInfo>
  activeSessionId: string | null
  onSelectSession: (id: string) => void
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
   */
  renderConversationPane?: (
    view: "conversation" | "plan",
    ctx: { onOpenPlanReview: () => void }
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /**
   * Show the empty state instead of a transcript — the real app sets this when
   * no session is active (first launch), so the seeded demo never renders.
   */
  showEmpty?: boolean
  /** Unified-diff patch for the Changes rail (fallback demo only). */
  patch?: string
  /** Live per-session agent status, overriding the persisted status. */
  liveStatus?: Record<string, SessionStatus>
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
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /**
   * Render the per-session terminal dock (the desktop app's live TerminalDock).
   * Docked to the main content column beside/below the tab body — never shown in
   * the Settings or empty states. Absent in stories.
   */
  renderTerminalDock?: (session: Session) => ReactNode
  /** Which edge the terminal dock attaches to — drives the content column's flow. */
  terminalDockSide?: DockSide
  /** App version, shown in the sidebar footer. */
  version?: string
}

/**
 * The tabs relevant to a session — extra tabs only appear once they have data.
 * The Pull Request tab also shows for a branch with changes but no PR yet, so the
 * "Create pull request" empty state is reachable; Code Review needs a linked PR.
 */
const visibleTabs = (
  active: Session | null,
  planSessions?: ReadonlySet<string>
): ReadonlyArray<TabKey> => {
  const tabs: TabKey[] = ["conversation"]
  if (active && planSessions?.has(active.id)) tabs.push("plan")
  if (active?.prNumber != null) tabs.push("pr", "review")
  // No PR yet: the local worktree diff gets its own Changes tab (Code Review
  // covers local diffs only once a PR exists).
  else if (active?.worktreePath) tabs.push("pr", "changes")
  return tabs
}

/** Screen 01 — the primary session workspace. */
export function SessionConversation(props: SessionConversationProps) {
  const [tab, setTab] = useState<TabKey>("conversation")
  const active = props.sessions.find((s) => s.id === props.activeSessionId) ?? null

  const tabs = visibleTabs(active, props.planSessions)
  // Never leave a hidden tab selected (e.g. after switching to a PR-less session).
  const activeTab = tabs.includes(tab) ? tab : "conversation"
  const connectGithub = props.onOpenSettings ?? (() => {})
  // The active session's live status (running agent) overrides its persisted one.
  const activeStatus = (active && props.liveStatus?.[active.id]) ?? active?.status
  // The live terminal dock for the active session (desktop app only).
  const dock = active && props.renderTerminalDock ? props.renderTerminalDock(active) : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SessionSidebar
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        onSelect={props.onSelectSession}
        onRename={props.onRenameSession}
        onArchive={props.onArchiveSession}
        onRestore={props.onRestoreSession}
        onDelete={props.onDeleteSession}
        liveStatus={props.liveStatus}
        onNewSession={props.onNewSession}
        user={props.user}
        onOpenUsage={props.onOpenUsage}
        onOpenSettings={props.onOpenSettings}
        onSignOut={props.onSignOut}
        ghConnected={props.ghConnected}
        starredRepoNames={props.starredRepoNames}
        onToggleStar={props.onToggleStar}
        version={props.version}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        {props.settingsView ? (
          props.settingsView
        ) : props.showEmpty ? (
          <EmptyConversation
            clis={props.clis}
            version={props.version}
            onNewSession={props.onNewSession}
          />
        ) : (
          <>
            <TabBar
              tabs={tabs}
              active={activeTab}
              onChange={setTab}
              prNumber={active?.prNumber ?? null}
              status={
                activeStatus === "thinking"
                  ? { label: "Thinking", tone: "yellow" }
                  : activeStatus === "needs-input"
                    ? { label: "Needs input", tone: "blue" }
                    : undefined
              }
            />

            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                dock && props.terminalDockSide === "right" ? "flex-row" : "flex-col"
              )}
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {/*
                  The Conversation + Plan tabs share ONE persistent pane (same
                  conversation machine), so switching to Plan Review never unmounts —
                  and thus never aborts — a parked plan run. The pane swaps its own
                  inner view; only the OTHER tabs (pr/review/stub) fully unmount on
                  switch (keyed by activeTab), since the virtualized transcript's
                  measurement cache corrupts if kept mounted-but-hidden.
                */}
                {activeTab === "conversation" || activeTab === "plan" ? (
                  props.renderConversationPane ? (
                    props.renderConversationPane(activeTab === "plan" ? "plan" : "conversation", {
                      onOpenPlanReview: () => setTab("plan")
                    })
                  ) : (
                    <div key="conversation" className="flex min-h-0 min-w-0 flex-1">
                      {props.conversationPane ?? (
                        <ConversationView messages={SEED_CONVERSATION} mode="accept-edits" patch={props.patch} />
                      )}
                    </div>
                  )
                ) : (
                  <div key={activeTab} className="flex min-h-0 min-w-0 flex-1">
                    {activeTab === "pr" && active ? (
                      (props.renderPullRequest?.(active, { onConnectGithub: connectGithub }) ?? (
                        <StubScreen tab="pr" />
                      ))
                    ) : activeTab === "review" && active ? (
                      (props.renderReview?.(active, { onConnectGithub: connectGithub }) ?? (
                        <StubScreen tab="review" />
                      ))
                    ) : activeTab === "changes" && active ? (
                      (props.renderCode?.(active, { onConnectGithub: connectGithub }) ?? <StubScreen tab="changes" />)
                    ) : (
                      <StubScreen tab={activeTab} />
                    )}
                  </div>
                )}
              </div>
              {dock}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
