/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useMemo, useState } from "react"
import type { DiffActions } from "@starbase/ui"
import type { Session } from "@starbase/core"
import { AgentTabBar, ConversationView, MAIN_AGENT, PlanReview, SubagentView } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { useConversation } from "./use-conversation.js"

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  onRestore,
  onDelete
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
}) {
  const convo = useConversation(session)

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

  // Changes-rail actions: revert lines/files in the worktree (then re-read the
  // diff), or comment on a range — routed to this session's agent as a prompt.
  // Declared before the Plan Review early-return so hook order stays stable.
  const changeActions = useMemo<DiffActions>(
    () => ({
      onRevertLines: (path, startLine, endLine) =>
        void rpc.workspaceRevertLines(session.id, path, startLine, endLine).then(convo.refreshDiff).catch(() => {}),
      onRevertFile: (path) =>
        void rpc.workspaceRevertFile(session.id, path).then(convo.refreshDiff).catch(() => {}),
      onComment: (path, startLine, endLine, body) => {
        const ref = endLine > startLine ? `${path} L${startLine}-${endLine}` : `${path} L${startLine}`
        convo.sendPrompt(`Regarding ${ref}:\n\n${body}`)
      }
    }),
    // convo.refreshDiff / sendPrompt are stable send-wrappers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  )

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
          patch={convo.patch}
          paused={convo.paused}
          busy={convo.busy}
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
          changeActions={changeActions}
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
