/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Session } from "@starbase/core"
import { agentChildren, agentPath } from "@starbase/core"
import {
  AgentTabBar,
  BackgroundTaskDock,
  BackgroundTaskOutput,
  ConversationView,
  MAIN_AGENT,
  McpStatusDialog,
  PlanReview,
  ResizeHandle,
  SubagentView,
  useResizableWidth
} from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { clearDraft, getDraft, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { useConversation } from "./use-conversation.js"
import { useBackgroundTasks } from "./use-background-tasks.js"
import { useMcp } from "./use-mcp.js"

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
  /**
   * Which face of the session to show: the transcript, the Plan Review, or both
   * side by side. `split` renders the SAME Plan Review beside the transcript
   * rather than a condensed rail — one conversation machine, two columns, so
   * toggling it can never remount (and so never abort) a live run.
   */
  view?: "conversation" | "plan" | "split"
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
  // `convo.cli` rather than `session.cli`: the harness can change mid-session, and
  // MCP config is a property of the harness.
  const mcp = useMcp(session.id, convo.cli)
  const [mcpOpen, setMcpOpen] = useState(false)

  // Declared unconditionally (hook order) — the plan column only reads it in the
  // `split` view, but the `plan` view returns early above.
  const planSplit = useResizableWidth({ storageKey: "sb.split.plan", initial: 520, min: 360, max: 900 })

  // Background tasks. Gated on the HARNESS's capability, read from discovery —
  // only Claude reports a live task set and accepts a per-task stop, so the dock
  // stays hidden elsewhere rather than offering a button with nothing to aim at.
  const clisQuery = useQuery({ queryKey: ["clis"], queryFn: () => rpc.discoveryList() })
  const backgroundTasksSupported =
    clisQuery.data?.find((c) => c.kind === convo.cli)?.backgroundTasks ?? false
  const bgTasks = useBackgroundTasks(session.id, backgroundTasksSupported)

  /**
   * Context accounting for the meter.
   *
   * Re-read when the live token count changes rather than polled: `convo.tokens`
   * moves on every `Usage` event, so keying the query on it gives a meter that
   * tracks the run without a timer running against every open session. Gated on
   * the harness reporting context at all — the meter renders nothing when
   * `triggerAt` is null, and asking for a snapshot we would not draw is waste.
   */
  const contextReporting =
    clisQuery.data?.find((c) => c.kind === convo.cli)?.contextReporting ?? false
  /**
   * The session's context accounting.
   *
   * NOT keyed on the live token count. Keying it there seemed natural — refetch
   * whenever usage moves — but every `Usage` event then produced a new cache
   * entry whose `data` starts `undefined`, so `triggerAt` went null and the
   * meter UNMOUNTED. Mid-run, where usage updates constantly, it could never
   * appear at all. It also fired one RPC per token update. The live number comes
   * from `convo.tokens` instead.
   *
   * It IS keyed on the harness and model, because the trigger point is derived
   * from them: a session switched from Claude to Codex has a different window
   * and therefore a different budget. Keyed on the session alone, the meter and
   * the Compact now action would keep pointing at the old harness's numbers —
   * and because a disabled query still serves its last data, switching to a
   * harness that reports nothing (Cursor) would leave the previous harness's
   * meter on screen rather than hiding it.
   */
  const [requested, setRequested] = useState(false)
  const contextQuery = useQuery({
    queryKey: ["context", session.id, convo.cli, convo.model],
    queryFn: () => rpc.contextState(session.id),
    enabled: contextReporting,
    /**
     * Poll while a compaction could be happening.
     *
     * The digest runs on a background fiber with no push channel to the
     * renderer, so polling is the only way to see it start or finish. Scoped to
     * when something might actually be in flight — a session sitting well inside
     * its budget needs no timer.
     */
    refetchInterval: (query) =>
      requested || query.state.data?.preparing || convo.busy ? 1500 : false
  })
  const preparing = contextQuery.data?.preparing ?? false
  const digestReady = contextQuery.data?.digestReady ?? false
  // The manual request is only needed until the manager reports the fiber it
  // started; after that `preparing` is the authoritative signal.
  useEffect(() => {
    if (preparing || digestReady) setRequested(false)
  }, [preparing, digestReady])
  // A turn crossing the budget starts a digest, so re-read once it settles.
  useEffect(() => {
    if (!convo.busy && contextReporting) void contextQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo.busy, contextReporting])
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null)
  const [taskOutput, setTaskOutput] = useState("")
  const viewingTask = bgTasks.tasks.find((t) => t.id === viewingTaskId) ?? null

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

  const planReview = (
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

  if (view === "plan") return planReview

  // Directly beneath the main tab bar, a secondary bar surfaces the turn's live
  // sub-agents (only while some exist). Selecting one swaps the pane to its
  // watch-only transcript; "Main" shows the conversation. The stream keeps running
  // either way — the actor lives in the registry, not this pane, so swapping the
  // view never aborts the run.
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          contextTriggerAt={contextQuery.data?.triggerAt ?? null}
          contextPreparing={preparing || requested}
          contextDigestReady={digestReady}
          onCompactNow={() => {
            setRequested(true)
            void rpc.contextCompactNow(session.id).catch(() => setRequested(false))
          }}
          runStartedAt={convo.runStartedAt}
          queued={convo.queued}
          onUnqueue={convo.unqueue}
          onSendNow={convo.sendNow}
          model={convo.model}
          catalog={convo.catalog}
          onSetHarness={convo.setHarness}
          mcp={mcp.summary}
          onOpenMcp={() => {
            setMcpOpen(true)
            // Probe on open (cached server-side), so the dialog has something to
            // show without the operator having to ask twice.
            mcp.check(false)
          }}
          onSend={sendPrompt}
          onStop={convo.stop}
          onDecideGate={convo.decideGate}
          onSetMode={convo.setMode}
          adversarialPlanning={convo.adversarialPlanning ?? undefined}
          onPlanAdversarially={convo.planAdversarially}
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
      {/*
        Background tasks dock — harness work that OUTLIVES this turn. Sits below
        the conversation (not in the sub-agent tab bar, which is per-run and
        cleared on the next turn) so a task the operator needs to stop can't be
        swept away while it is still running. Renders nothing when the harness
        has no per-task support or there is nothing to show.
      */}
      {viewingTask && (
        <BackgroundTaskOutput
          task={viewingTask}
          output={taskOutput}
          onClose={() => setViewingTaskId(null)}
        />
      )}
      <BackgroundTaskDock
        tasks={bgTasks.tasks}
        supported={backgroundTasksSupported}
        onStop={bgTasks.stop}
        onDismiss={bgTasks.dismiss}
        onView={(taskId) => {
          setViewingTaskId(taskId)
          void bgTasks.output(taskId).then(setTaskOutput)
        }}
      />
      <McpStatusDialog
        open={mcpOpen}
        cli={convo.cli}
        servers={mcp.servers}
        statuses={mcp.statuses}
        loading={mcp.checking}
        checkedAt={mcp.checkedAt}
        // Refresh always forces a re-probe: the operator clicked *because* they
        // want a fresh answer, so handing back the cache would read as a bug.
        onRefresh={() => mcp.check(true)}
        onClose={() => setMcpOpen(false)}
      />
      </div>

      {/*
        Split view: the real Plan Review beside the transcript. This replaced a
        narrow step-progress rail, which could only ever be a lossy restatement of
        this screen in a column too small to act on. Kept OUTSIDE the transcript's
        scrolling column so the virtualizer measures against a stable width.
      */}
      {view === "split" && (
        <>
          <ResizeHandle aria-label="Resize plan" onResize={(dx) => planSplit.adjust(-dx)} />
          <div
            style={{ width: planSplit.width }}
            className="flex min-h-0 flex-none flex-col overflow-hidden border-l border-hairline"
          >
            {planReview}
          </div>
        </>
      )}
    </div>
  )
}
