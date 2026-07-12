/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useEffect, useMemo } from "react"
import type { DiffActions } from "@starbase/ui"
import type { Session } from "@starbase/core"
import { ConversationView, PlanReview } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { setPlanPresent } from "./plan-presence.js"
import { setSessionStatus } from "./session-status.js"
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

  // Publish the live agent status so the sidebar/tab bar reflect it.
  useEffect(() => setSessionStatus(session.id, convo.status), [session.id, convo.status])
  useEffect(() => () => setSessionStatus(session.id, null), [session.id])

  // The Plan Review tab appears only once a plan actually exists (like the PR tab
  // waits for a PR) — being in plan mode alone doesn't warrant it.
  const hasPlanTab = convo.plan !== null
  useEffect(() => setPlanPresent(session.id, hasPlanTab), [session.id, hasPlanTab])
  useEffect(() => () => setPlanPresent(session.id, false), [session.id])

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
        onApprove={() => planId && convo.approvePlan(planId)}
        onRevise={() => planId && convo.revisePlan(planId)}
        onComment={(stepId, body) => planId && convo.commentPlanStep(planId, stepId, body)}
      />
    )
  }

  return (
    <ConversationView
      messages={convo.messages}
      mode={convo.mode}
      cli={session.cli}
      skills={convo.skills}
      files={convo.files}
      patch={convo.patch}
      paused={convo.paused}
      model={convo.model}
      models={convo.models}
      onSetModel={convo.setModel}
      onSend={convo.sendPrompt}
      onDecideGate={convo.decideGate}
      onSetMode={convo.setMode}
      question={convo.question}
      onAnswerQuestion={convo.answerQuestion}
      onApprovePlan={(id) => convo.approvePlan(id)}
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
  )
}
