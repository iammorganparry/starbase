/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useEffect, useState } from "react"
import type { Session } from "@starbase/core"
import { agentChildren, agentPath } from "@starbase/core"
import { AgentTabBar, ConversationView, MAIN_AGENT, PlanReview, SubagentView } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { clearDraft, getDraft, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { useConversation } from "./use-conversation.js"

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  planStepId,
  onPlanStepSelected,
  onRestore,
  onDelete,
  onInitialPromptConsumed
}: {
  session: Session
  /** Which face of the session to show — the transcript, or the Plan Review. */
  view?: "conversation" | "plan"
  /**
   * Switch the pane to the Plan Review view — bare from the inline plan card, or
   * with a step id from the Conversation progress rail (a deep link).
   */
  onOpenPlanReview?: (stepId?: string) => void
  /** The step Plan Review should open at (a pending deep link from the rail). */
  planStepId?: string | null
  /** Plan Review's selection moved — lets the host retire a spent deep link. */
  onPlanStepSelected?: () => void
  /** Restore this session from archived (the banner + locked composer). */
  onRestore?: (sessionId: string) => void
  /** Permanently delete this session (the banner). */
  onDelete?: (sessionId: string) => void
  /** Notify once the composer has consumed the one-shot initial prompt. */
  onInitialPromptConsumed?: (sessionId: string) => void
}) {
  const convo = useConversation(session)

  // The composer's draft lives in the store, not the composer — this pane is
  // mounted keyed by session id, so switching sessions unmounts it and any local
  // state goes with it. See `draft-store`.
  const draft = useDraft(session.id)

  // The prefilled task is one-shot, but we clear it (backend + app state) only
  // once the user actually SENDS — not on mount. Clearing on mount lost the draft
  // when the user visited the Issue tab first (that unmounts this pane, discarding
  // the composer's seeded text; on return `initialPrompt` was already gone).
  // Consuming on send keeps the seed alive across those unmounts until it's used.
  // It now seeds the DRAFT STORE (once ever, never over existing text), so the
  // prefill survives the same unmounts the store was built for.
  useEffect(() => {
    if (session.initialPrompt) seedDraftOnce(session.id, session.initialPrompt)
  }, [session.id, session.initialPrompt])

  const sendPrompt: typeof convo.sendPrompt = (...args) => {
    if (session.initialPrompt) onInitialPromptConsumed?.(session.id)
    // The turn is on its way to the agent — the draft has served its purpose.
    clearDraft(session.id)
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

  // Sub-agents nest, so the bar shows one level at a time: `level` is the agent
  // whose children are listed (MAIN_AGENT = the top level). Derived the same way
  // as the selection — if the drilled-into agent is gone (the list resets on the
  // next run) we fall back to the top level rather than stranding an empty bar.
  const [level, setLevel] = useState<string>(MAIN_AGENT)
  const effectiveLevel =
    level !== MAIN_AGENT && convo.subagents.some((s) => s.id === level) ? level : MAIN_AGENT
  const levelAgents = agentChildren(
    convo.subagents,
    effectiveLevel === MAIN_AGENT ? null : effectiveLevel
  )
  // The reviewer is a top-level agent of its own — a whole run started by the PR
  // tab or the background auto-review, not a `Task` spawn — so it joins the top
  // level of the bar, but never the children of a sub-agent drilled into.
  const barAgents =
    effectiveLevel === MAIN_AGENT && convo.reviewer
      ? [...levelAgents, convo.reviewer]
      : levelAgents
  const trail =
    effectiveLevel === MAIN_AGENT
      ? []
      : agentPath(convo.subagents, effectiveLevel).map((s) => ({ id: s.id, name: s.name }))

  // Drilling into an agent shows its children AND its own transcript; a crumb
  // jumps the level back up. Both keep the two states in step.
  const goToAgent = (id: string) => {
    setLevel(id)
    setSelectedAgent(id)
  }
  const goToMain = () => {
    setLevel(MAIN_AGENT)
    setSelectedAgent(MAIN_AGENT)
  }

  // Live agent status + Plan-tab presence are published by the conversation
  // registry (from the actor's own subscription), so they stay correct even
  // while this pane is unmounted for a background session. Nothing to do here.

  const planId = convo.plan?.id ?? null

  if (view === "plan") {
    return (
      <PlanReview
        plan={convo.plan}
        patch={convo.patch}
        selectedStepId={planStepId}
        onSelectStep={onPlanStepSelected}
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
      {barAgents.length > 0 && (
        <AgentTabBar
          agents={barAgents.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status,
            hasChildren: convo.subagents.some((c) => c.parentId === s.id)
          }))}
          trail={trail}
          active={activeAgent}
          onChange={setSelectedAgent}
          onDrill={goToAgent}
          onNavigate={(id) => (id === MAIN_AGENT ? goToMain() : goToAgent(id))}
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
          onStop={convo.stop}
          onDecideGate={convo.decideGate}
          onSetMode={convo.setMode}
          question={convo.question}
          onAnswerQuestion={convo.answerQuestion}
          onApprovePlan={(id) => convo.approvePlan(id)}
          onResumePlan={(id) => convo.resumePlan(id)}
          onOpenPlanReview={onOpenPlanReview}
          plan={convo.plan}
          draft={draft.text}
          // Merge against the LIVE draft, never the render-time `draft` closure:
          // on send the composer fires onSend → setValue("") → setAttachments([])
          // in one go, so a stale spread would resurrect the text it just sent.
          onDraftChange={(text) => setDraft(session.id, { ...getDraft(session.id), text })}
          draftAttachments={draft.attachments}
          onDraftAttachmentsChange={(attachments) =>
            setDraft(session.id, { ...getDraft(session.id), attachments })
          }
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
