import { type ReactNode, useState } from "react"
import type { DiffStat, Session, SessionActivity, SessionDisplayStatus } from "@starbase/core"
import { activityLabel, displayStatusOf } from "@starbase/core"
import { displayStatusLabel } from "../tokens.js"
import { TabBar, type TabKey } from "../app/tab-bar.js"
import { ConversationView } from "../app/conversation-view.js"
import { SEED_CONVERSATION } from "../seed.js"
import { StubScreen } from "./stub-screen.js"

/**
 * The tab-bar pill's accent per reported state. Blue means "you're needed" and is
 * reserved for exactly that — anything the agent is doing under its own steam is
 * yellow, however long it takes. (Monitoring a PR is still the agent's work, not
 * yours; tinting it blue would dilute the one signal that should pull an eye.)
 */
const DISPLAY_TONE: Record<SessionDisplayStatus, "yellow" | "blue" | "green"> = {
  thinking: "yellow",
  running: "yellow",
  monitoring: "yellow",
  "needs-input": "blue",
  idle: "yellow"
}

/**
 * What the host hands the live conversation pane so it can drive the Plan tab.
 * There's no router here — this tiny ctx IS the app's plan-review navigation.
 */
export interface ConversationPaneCtx {
  /**
   * Switch to the Plan Review tab, optionally focused on a step (the Conversation
   * progress rail deep-links; the inline plan card calls it bare).
   */
  onOpenPlanReview: (stepId?: string) => void
  /** The step Plan Review should open at, until the user picks another. */
  planStepId?: string | null
  /** Plan Review's selection moved — retires a spent `planStepId`. */
  onPlanStepSelected?: () => void
}

export interface SessionPaneProps {
  /** The session this pane shows. A pane only exists for a filled grid slot. */
  session: Session
  /**
   * The real app's session-keyed pane, rendered for BOTH the Conversation and
   * Plan tabs from the same machine (so switching to Plan never aborts a parked
   * plan run). `view` selects the face; `ctx.onOpenPlanReview` switches the tab.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /**
   * A static conversation pane for stories / standalone use, when no live
   * `renderConversation` is wired. Falls back again to the seeded transcript.
   */
  conversationPane?: ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Open the Settings view — the "connect GitHub" escape hatch on empty states. */
  onOpenSettings?: () => void
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Issue tab — the rich linked-issue view (shown when one is linked). */
  renderIssue?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /**
   * Toggle the browser-preview pane. App-level, not pane-level: the dock itself is
   * mounted once outside the grid, so every pane's copy of this control drives the
   * same one.
   */
  onToggleBrowser?: () => void
  /** Whether the browser-preview pane is currently open. */
  browserActive?: boolean
  /** Close this pane. Absent in a group of one, where there is nothing to close back to. */
  onClosePane?: () => void
  /** Swap this pane with its left-hand neighbour. Absent at the left-hand end. */
  onMovePaneLeft?: () => void
  /** Swap this pane with its right-hand neighbour. Absent at the right-hand end. */
  onMovePaneRight?: () => void
}

/**
 * The tabs relevant to a session — extra tabs only appear once they have data.
 * The Pull Request tab also shows for a branch with changes but no PR yet, so the
 * "Create pull request" empty state is reachable; Code Review needs a linked PR.
 */
export const visibleTabs = (
  active: Session | null,
  planSessions?: ReadonlySet<string>
): ReadonlyArray<TabKey> => {
  const tabs: TabKey[] = ["conversation"]
  // A linked GitHub issue gets its own rich Issue tab, right after Conversation.
  if (active?.issueNumber != null) tabs.push("issue")
  if (active && planSessions?.has(active.id)) tabs.push("plan")
  if (active?.prNumber != null) tabs.push("pr", "review")
  // No PR yet: the local worktree diff gets its own Changes tab (Code Review
  // covers local diffs only once a PR exists).
  else if (active?.worktreePath) tabs.push("pr", "changes")
  return tabs
}

/**
 * One session's full workspace: its tab bar and its tab body.
 *
 * Not its docks — the terminal and browser preview are mounted once by
 * `SessionSplit`, outside every pane. See the comment there for why.
 *
 * Extracted out of `SessionConversation` so the split can mount SEVERAL of these
 * at once. The important consequence of the split is that `tab`, `target` and
 * `split` are per-pane state now — two panes showing different sessions must be
 * able to sit on different tabs, which a single shared `useState` in the parent
 * could never express.
 *
 * Mount this keyed by session id. The pane reads `props.session` directly rather
 * than looking an id up in a list, so a slot always renders the session it was
 * given even mid-reorder.
 */
export function SessionPane(props: SessionPaneProps) {
  const [tab, setTab] = useState<TabKey>("conversation")
  // A pending deep link into Plan Review (set when the Conversation rail jumps to
  // a step). One-shot: Plan Review reports its own selection back and we drop it,
  // so a later manual pick isn't overridden by a stale target.
  //
  // Still tagged with its session even though a pane is now keyed by session id:
  // the tag costs nothing and keeps the invariant local rather than depending on
  // every caller remembering to key correctly. Step ids are per-plan ordinals
  // (s_01, s_02…) that collide across sessions, so an untagged target that
  // survived a re-key would snap to an unrelated same-numbered step.
  const [target, setTarget] = useState<{ sessionId: string; stepId: string } | null>(null)
  const [split, setSplit] = useState(false)

  const active = props.session
  const planStepTarget = target?.sessionId === active.id ? target.stepId : null

  const tabs = visibleTabs(active, props.planSessions)
  // Never leave a hidden tab selected (e.g. after a session's PR is merged away).
  const activeTab = tabs.includes(tab) ? tab : "conversation"
  // Plan Review beside the transcript. Derived, never merely stored: a session
  // with no plan has nothing to split, so the same reasoning that hides the Plan
  // tab collapses the split — otherwise a plan-less session would leave an empty
  // column pinned open with no control on screen to close it.
  const splitAvailable = activeTab === "conversation" && tabs.includes("plan")
  const splitOpen = split && splitAvailable
  const connectGithub = props.onOpenSettings ?? (() => {})
  // What this session's agent is doing — drives the tab bar's pill.
  const activeActivity = props.liveActivity?.[active.id] ?? null

  return (
    <>
      <TabBar
        tabs={tabs}
        active={activeTab}
        onChange={setTab}
        prNumber={active.prNumber ?? null}
        changes={props.liveDiff?.[active.id] ?? null}
        status={
          activeActivity
            ? {
                // ONE vocabulary for a session's state, shared with the sidebar:
                // "Thinking", "Running", "Needs Input", "Monitoring", "Idle". The
                // pill used to read the raw activity ("Running npm test…"), so
                // the same session answered "what are you doing?" two different
                // ways depending on which part of the window you looked at — and
                // the target string grew the pill on every tool call.
                label: displayStatusLabel[displayStatusOf(activeActivity, active.status)],
                tone: DISPLAY_TONE[displayStatusOf(activeActivity, active.status)],
                // The specifics survive on hover, exactly as they do in the row.
                detail: activityLabel(activeActivity)
              }
            : undefined
        }
        onToggleBrowser={props.onToggleBrowser}
        browserActive={props.browserActive}
        onToggleSplit={splitAvailable ? () => setSplit((v) => !v) : undefined}
        splitActive={splitOpen}
        onClosePane={props.onClosePane}
        onMovePaneLeft={props.onMovePaneLeft}
        onMovePaneRight={props.onMovePaneRight}
      />

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
        props.renderConversation ? (
          <div key={active.id} className="flex min-h-0 min-w-0 flex-1">
            {props.renderConversation(
              active,
              activeTab === "plan" ? "plan" : splitOpen ? "split" : "conversation",
              {
                onOpenPlanReview: (stepId) => {
                  setTarget(stepId ? { sessionId: active.id, stepId } : null)
                  // Already split? Plan Review is on screen — switching tabs
                  // would close the transcript the operator just clicked from.
                  // Just move its selection.
                  if (!splitOpen) setTab("plan")
                },
                planStepId: planStepTarget,
                onPlanStepSelected: () => setTarget(null)
              }
            )}
          </div>
        ) : (
          <div key="conversation" className="flex min-h-0 min-w-0 flex-1">
            {props.conversationPane ?? (
              <ConversationView messages={SEED_CONVERSATION} mode="accept-edits" />
            )}
          </div>
        )
      ) : (
        <div key={activeTab} className="flex min-h-0 min-w-0 flex-1">
          {activeTab === "issue" ? (
            (props.renderIssue?.(active, { onConnectGithub: connectGithub }) ?? (
              <StubScreen tab="issue" />
            ))
          ) : activeTab === "pr" ? (
            (props.renderPullRequest?.(active, { onConnectGithub: connectGithub }) ?? (
              <StubScreen tab="pr" />
            ))
          ) : activeTab === "review" ? (
            (props.renderReview?.(active, { onConnectGithub: connectGithub }) ?? (
              <StubScreen tab="review" />
            ))
          ) : activeTab === "changes" ? (
            (props.renderCode?.(active, { onConnectGithub: connectGithub }) ?? (
              <StubScreen tab="changes" />
            ))
          ) : (
            <StubScreen tab={activeTab} />
          )}
        </div>
      )}
      </div>
    </>
  )
}
