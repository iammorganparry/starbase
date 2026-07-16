/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useState } from "react"
import type { Session } from "@starbase/core"
import { AgentTabBar, ConversationView, MAIN_AGENT, PlanReview, SubagentView } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { useConversation } from "./use-conversation.js"

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  onRestore,
  onDelete,
  onInitialPromptConsumed
}: {
  session: Session
  /** Which face of the session to show — the transcript, or the Plan Review. */
  view?: "conversation" | "plan"
  /** Switch the pane to the Plan Review view (from the inline plan card). */
  onOpenPlanReview?: () => void
  /** Restore this session from archived (the banner + locked composer). */
  onRestore?: (sessionId: string) => void
  /** Permanently delete this session (the banner). */
  onDelete?: (sessionId: string) => void
  /** Notify once the composer has consumed the one-shot initial prompt. */
  onInitialPromptConsumed?: (sessionId: string) => void
}) {
  const convo = useConversation(session)

  // The prefilled task is one-shot, but we clear it (backend + app state) only
  // once the user actually SENDS — not on mount. Clearing on mount lost the draft
  // when the user visited the Issue tab first (that unmounts this pane, discarding
  // the composer's seeded text; on return `initialPrompt` was already gone).
  // Consuming on send keeps the seed alive across those unmounts until it's used.
  const sendPrompt: typeof convo.sendPrompt = (...args) => {
    if (session.initialPrompt) onInitialPromptConsumed?.(session.id)
    return convo.sendPrompt(...args)
  }

  // Which sub-agent tab is selected ("main" = the parent conversation). Declared
  // before the Plan Review early-return so hook order stays stable. We derive the
  // effective selection so a finished (auto-removed) sub-agent falls back to Main
  // without an effect — its tab and view disappear together.
  const [selectedAgent, setSelectedAgent] = useState<string>(MAIN_AGENT)
  // The reviewer sits in the same bar as the turn's sub-agents but is not one of
  // them (it is a whole agent run of its own, started by the PR tab or the
  // background auto-review), so it is appended here rather than living in the list.
  const agents = convo.reviewer ? [...convo.subagents, convo.reviewer] : convo.subagents
  const activeSubagent = agents.find((s) => s.id === selectedAgent) ?? null
  const activeAgent = activeSubagent ? selectedAgent : MAIN_AGENT

  // Live agent status + Plan-tab presence are published by the conversation
  // registry (from the actor's own subscription), so they stay correct even
  // while this pane is unmounted for a background session. Nothing to do here.

  const planId = convo.plan?.id ?? null

  if (view === "plan") {
    return (
      <PlanReview
        plan={convo.plan}
        patch={convo.patch}
        onApprove={() => planId && convo.approvePlan(planId)}
        onResume={() => planId && convo.resumePlan(planId)}
        onRevise={() => planId && convo.revisePlan(planId)}
        onComment={(stepId, body) => planId && convo.commentPlanStep(planId, stepId, body)}
      />
    )
  }

  // Directly beneath the main tab bar, a secondary bar surfaces the turn's live
  // sub-agents (only while some exist). Selecting one swaps the pane to its
  // watch-only transcript; "Main" shows the conversation. The stream keeps running
  // either way — the actor lives in the registry, not this pane, so swapping the
  // view never aborts the run.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {agents.length > 0 && (
        <AgentTabBar
          agents={agents.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status
          }))}
          active={activeAgent}
          onChange={setSelectedAgent}
        />
      )}
      {activeSubagent ? (
        <SubagentView subagent={activeSubagent} />
      ) : (
        <ConversationView
          messages={convo.messages}
          mode={convo.mode}
          cli={convo.cli}
          skills={convo.skills}
          files={convo.files}
          paused={convo.paused}
          busy={convo.busy}
          tokens={convo.tokens}
          runStartedAt={convo.runStartedAt}
          queued={convo.queued}
          onUnqueue={convo.unqueue}
          onSendNow={convo.sendNow}
          model={convo.model}
          catalog={convo.catalog}
          onSetHarness={convo.setHarness}
          onSend={sendPrompt}
          onDecideGate={convo.decideGate}
          onSetMode={convo.setMode}
          question={convo.question}
          onAnswerQuestion={convo.answerQuestion}
          onApprovePlan={(id) => convo.approvePlan(id)}
          onResumePlan={(id) => convo.resumePlan(id)}
          onOpenPlanReview={onOpenPlanReview}
          initialDraft={session.initialPrompt}
          archived={
            session.archived
              ? {
                  reason: session.archiveReason ?? "merged",
                  prNumber: session.prNumber,
                  base: session.baseBranch,
                  onRestore: () => onRestore?.(session.id),
                  onDelete: () => onDelete?.(session.id)
                }
              : undefined
          }
        />
      )}
    </div>
  )
}
