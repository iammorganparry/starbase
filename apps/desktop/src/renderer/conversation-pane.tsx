/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useEffect, useState } from "react"
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
  onUnlinkIssue,
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
  /** Detach the session's linked issue (linked-issue banner). */
  onUnlinkIssue?: (sessionId: string) => void
  /** Notify once the composer has consumed the one-shot initial prompt. */
  onInitialPromptConsumed?: (sessionId: string) => void
}) {
  const convo = useConversation(session)

  // The prefilled task is one-shot: the composer seeds from it on mount, then we
  // clear it (backend + app state) so switching sessions never re-seeds.
  useEffect(() => {
    if (session.initialPrompt) onInitialPromptConsumed?.(session.id)
    // Only when this session first mounts with a prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const linkedIssue =
    session.issueNumber != null
      ? {
          number: session.issueNumber,
          title: session.issueTitle ?? "",
          url: session.issueUrl,
          labels: session.issueLabels,
          automations: session.automations
        }
      : undefined

  // Which sub-agent tab is selected ("main" = the parent conversation). Declared
  // before the Plan Review early-return so hook order stays stable. We derive the
  // effective selection so a finished (auto-removed) sub-agent falls back to Main
  // without an effect — its tab and view disappear together.
  const [selectedAgent, setSelectedAgent] = useState<string>(MAIN_AGENT)
  const activeSubagent = convo.subagents.find((s) => s.id === selectedAgent) ?? null
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
      {convo.subagents.length > 0 && (
        <AgentTabBar
          agents={convo.subagents.map((s) => ({
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
          cli={session.cli}
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
          models={convo.models}
          onSetModel={convo.setModel}
          onSend={convo.sendPrompt}
          onDecideGate={convo.decideGate}
          onSetMode={convo.setMode}
          question={convo.question}
          onAnswerQuestion={convo.answerQuestion}
          onApprovePlan={(id) => convo.approvePlan(id)}
          onResumePlan={(id) => convo.resumePlan(id)}
          onOpenPlanReview={onOpenPlanReview}
          linkedIssue={linkedIssue}
          initialDraft={session.initialPrompt}
          onOpenIssue={
            session.issueUrl ? () => void window.starbase.openExternal(session.issueUrl!) : undefined
          }
          onUnlinkIssue={onUnlinkIssue ? () => onUnlinkIssue(session.id) : undefined}
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
