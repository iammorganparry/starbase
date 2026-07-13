import { type ReactNode, useState } from "react"
import type { CliInfo, Session, SessionStatus } from "@starbase/core"
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
  /** Open the Usage & limits modal (sidebar footer button). */
  onOpenUsage?: () => void
  /** Open the Settings view (sidebar footer cog button). */
  onOpenSettings?: () => void
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SessionSidebar
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        onSelect={props.onSelectSession}
        liveStatus={props.liveStatus}
        onNewSession={props.onNewSession}
        onOpenUsage={props.onOpenUsage}
        onOpenSettings={props.onOpenSettings}
        ghConnected={props.ghConnected}
        starredRepoNames={props.starredRepoNames}
        onToggleStar={props.onToggleStar}
        version={props.version}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        {props.showEmpty ? (
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
          </>
        )}
      </div>
    </div>
  )
}
