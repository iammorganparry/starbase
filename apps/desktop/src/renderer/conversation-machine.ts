/**
 * Deterministic conversation flow as an XState chart — mirrors `app-machine.ts`.
 * Loading the transcript, streaming a turn, and pausing at a gate are modelled as
 * states/actors, so there are no data-fetching `useEffect`s: the machine is
 * spawned fresh per session (the view keys it by session id) and drives itself.
 *
 * The agent stream is an invoked `fromCallback` actor that forwards each
 * normalized `StreamEvent` back as a `STREAM_EVENT`; the machine folds it into
 * the transcript with the same `applyStreamEvent` the main process persists with.
 */
import type {
  PlanningReadiness,
  Attachment,
  CliKind,
  ExecutionMode,
  GateDecision,
  Message,
  PermissionMode,
  Plan,
  PlanComment,
  ProviderModels,
  QuestionAnswer,
  ReasoningEffort,
  ReviewPhase,
  Session,
  SessionStatus,
  SettledSessionStatus,
  Skill,
  StreamEvent,
  Subagent
} from "@starbase/core"
import {
  activityOf,
  addPlanComment,
  applyReviewEvent,
  applyStreamEvent,
  applySubagentEvent,
  assistantMessage,
  defaultModel,
  nextReviewPhase,
  isSubagentEvent,
  retractSubagent,
  setGateStatus,
  setPlanStatus,
  setQuestionAnswers,
  settleLoaded,
  settleStreaming,
  STOPPED_NOTE,
  supportsPlanMode,
  userMessage
} from "@starbase/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"

const isExecutionMode = (mode: PermissionMode): mode is ExecutionMode =>
  mode !== "plan" && mode !== "gigaplan"

type AgentTarget = "session" | "orchestrator"

const agentTargetFor = (mode: PermissionMode): AgentTarget =>
  mode === "gigaplan" ? "orchestrator" : "session"

const messageSourceFor = (target: AgentTarget) =>
  target === "orchestrator" ? ("gigaplan-intake" as const) : undefined

export interface ConversationContext {
  readonly session: Session
  readonly messages: ReadonlyArray<Message>
  readonly mode: PermissionMode
  /** Last concrete harness permission mode, retained while Plan/Gigaplan is selected. */
  readonly executionMode: ExecutionMode
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  /**
   * The composer chip's state: the session's live harness + model, and the
   * catalogue of every installed harness's models to choose from. `cli` is held
   * here (not read off `session`) because it can change mid-session.
   */
  readonly cli: CliKind
  readonly model: string
  readonly catalog: ReadonlyArray<ProviderModels>
  /** The worktree's current unified diff, for the Changes rail. */
  readonly patch: string
  readonly pendingText: string
  /** Images attached to the turn currently running (sent to the harness). */
  readonly pendingImages: ReadonlyArray<Attachment>
  /** Harness target for the pending turn; Gigaplan intake has its own thread. */
  readonly agentTarget: AgentTarget
  /** Semantic thinking strength for the next and subsequent turns. */
  readonly reasoningEffort?: ReasoningEffort
  /**
   * Messages the operator sent while the agent was busy — held FIFO and sent, one
   * turn at a time, as soon as the current run (and its diff refresh) settles.
   */
  readonly queued: ReadonlyArray<QueuedMessage>
  /**
   * Live sub-agents (harness `Task` spawns) for the current turn — each a
   * watch-only tab. Populated from `agentId`-tagged + `Subagent*` events, dropped
   * when an agent finishes; never persisted (transcripts.json holds the main turn).
   */
  readonly subagents: ReadonlyArray<Subagent>
  /**
   * When set, the running turn is a stale-plan re-drive (`Agent.resumePlan`) for
   * this plan id rather than a normal `Agent.run`; cleared when the next normal
   * turn starts.
   */
  readonly resumePlanId: string | null
  /**
   * When set, the running turn is an adversarial planning round for this brief
   * rather than a normal `Agent.run`. Follows `resumePlanId` exactly: one flag on
   * the context that redirects `agentStream` to a different RPC, so the machine
   * keeps ONE running state instead of growing a parallel one per run kind.
   */
  readonly adversarialBrief: string | null
  /**
   * When set, the running turn is a Gigaplan EXECUTION of this plan — each step
   * on the harness the plan assigned it — rather than a normal run. Follows
   * `resumePlanId` and `adversarialBrief` exactly: one flag that redirects
   * `agentStream` to a different RPC, so the machine keeps one running state
   * instead of a parallel one per run kind.
   */
  readonly executePlanId: string | null
  /** Permission mode selected when the approved Gigaplan starts executing. */
  readonly executePlanMode: ExecutionMode | null
  /**
   * Whether adversarial planning is offerable, and the reason when it isn't.
   * Null until the first load — the entry stays disabled until we actually know,
   * so it can never flash enabled and then refuse.
   */
  readonly planReadiness: PlanningReadiness | null
  /** Tokens currently occupying the main agent's context window. */
  readonly tokens: number
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  readonly runStartedAt: number | null
  /**
   * How the most recent run ENDED, or null while one is in flight.
   *
   * A `Failed` folds into the transcript as ordinary text (see the fold), so by
   * the time an observer sees the settled messages it can no longer tell a
   * failure from a normal reply. The notifier needs that distinction — "your
   * agent finished" and "your agent died" are not interchangeable — so the fold
   * records it here rather than making every observer re-derive it.
   */
  readonly lastOutcome: "done" | "failed" | null
  /**
   * The last lifecycle status known to be in the store, so a settling turn only
   * hits the disk when the status actually CHANGED (sessions.json is rewritten
   * whole on every write). Seeded from the loaded session, so it's the full
   * `SessionStatus`; only a `SettledSessionStatus` is ever written.
   */
  readonly persistedStatus: SessionStatus
  /**
   * Whether the transcript actually loaded. False after a load failure, where
   * `messages` is empty through no fault of the session — status must not be
   * derived from it (see `persistSettledStatus`).
   */
  readonly loaded: boolean
  /**
   * The adversarial reviewer, surfaced as a tab in the same bar as the harness's
   * sub-agents. Null until a review runs. It lives here rather than in `subagents`
   * because it is NOT part of a turn: it is started by the PR tab's button or by
   * the background auto-review poll, and so must survive the per-turn reset.
   */
  readonly reviewer: Subagent | null
  /** Where the running review has got to — the PR button's label. */
  readonly reviewPhase: ReviewPhase
  /** Epoch ms the review started, or null when no review is running. */
  readonly reviewStartedAt: number | null
}

/** A prompt held while busy, including the harness target chosen when it was sent. */
export interface QueuedMessage {
  readonly text: string
  readonly images: ReadonlyArray<Attachment>
  readonly target: AgentTarget
}

type ConversationEvent =
  | { type: "SEND"; text: string; images?: ReadonlyArray<Attachment> }
  | { type: "UNQUEUE"; index: number }
  | { type: "SEND_NOW"; index: number }
  | { type: "STREAM_EVENT"; event: StreamEvent }
  | { type: "PATCH_UPDATED"; patch: string }
  | { type: "DECIDE_GATE"; gateId: string; decision: GateDecision }
  | { type: "ANSWER_QUESTION"; requestId: string; answers: ReadonlyArray<QuestionAnswer> }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_HARNESS"; cli: CliKind; model: string }
  | { type: "SET_REASONING"; reasoningEffort?: ReasoningEffort }
  | { type: "SKILLS_LOADED"; skills: ReadonlyArray<Skill> }
  | { type: "CATALOG_LOADED"; catalog: ReadonlyArray<ProviderModels> }
  | { type: "READINESS_LOADED"; readiness: PlanningReadiness }
  | { type: "HANDOFF_PLAN" }
  | { type: "REVIEW_EVENT"; event: StreamEvent }
  | { type: "COMMENT_PLAN_STEP"; planId: string; stepId: string; body: string }
  | { type: "REVISE_PLAN"; planId: string }
  | { type: "APPROVE_PLAN"; planId: string; executionMode?: ExecutionMode }
  | { type: "RESUME_PLAN"; planId: string }
  | { type: "REFRESH_DIFF" }
  | { type: "STOP" }

interface LoadedData {
  readonly transcript: ReadonlyArray<Message>
  readonly files: ReadonlyArray<string>
  readonly patch: string
}

/**
 * Load the persisted transcript, worktree files + diff.
 *
 * Skills are NOT here, deliberately — they are fetched out of band (see
 * `loadSkills`), exactly like the model catalogue. `Skills.list` asks the
 * harness itself what commands it has, which means spawning it: hundreds of ms
 * to seconds. `loading` handles almost no events, so gating the transcript on a
 * CLI probe silently swallows everything the operator does in that window —
 * including SEND, which is to say the composer looks alive but does nothing.
 * The `/` menu just fills itself in a beat later.
 */
const loadConversation = fromPromise<LoadedData, { session: Session }>(async ({ input }) => {
  const [rawTranscript, files, patch] = await Promise.all([
    rpc.sessionsTranscript(input.session.id),
    input.session.worktreePath
      ? rpc.workspaceFiles(input.session.worktreePath)
      : Promise.resolve([] as ReadonlyArray<string>),
    rpc.sessionsDiff(input.session.id)
  ])
  // A loaded transcript has no live run — settle any turn left mid-stream (the
  // app was closed mid-response) so it doesn't show the typing indicator forever,
  // and resolve orphaned approval gates / questions whose live run has died (their
  // approve/deny buttons would otherwise be dead no-ops).
  const transcript = rawTranscript.map(settleLoaded)
  return { transcript, files, patch }
})

/** Re-read the worktree diff after a turn completes (edits may have landed). */
const refreshDiff = fromPromise<string, { session: Session }>(({ input }) =>
  rpc.sessionsDiff(input.session.id)
)

/**
 * Halt the current run, and WAIT for the halt to land.
 *
 * Firing this and moving on is what used to eat the operator's next message.
 * `agentStop` interrupts the run's fiber, but the runner keyed that fiber by
 * session id alone — so if the next turn had already started, the interrupt
 * found the NEW run and killed it. The operator's fresh message came back as a
 * bare "Stopped." and they re-sent it, usually within five seconds.
 *
 * The runner now serialises stop against a turn's setup, so this await is the
 * belt to that braces: waiting here means the next run is not merely
 * unkillable-by-mistake, it does not exist yet.
 */
const stopAgent = fromPromise<void, { sessionId: string }>(({ input }) =>
  rpc.agentStop(input.sessionId)
)

/**
 * How long we wait for a stop to land before starting the next turn anyway.
 *
 * A harness can take real time to tear a child down, and an operator who hit
 * "send now" is asking for the next turn, not for a progress bar. Past the cap
 * we proceed: the runner's own lock still orders the two runs correctly, so the
 * cost of being early here is a slower first token, not a lost turn.
 */
const STOP_SETTLE_CAP = 3_000

/** Subscribe to the agent's event stream, forwarding each event into the machine. */
const agentStream = fromCallback<
  ConversationEvent,
  {
    sessionId: string
    text: string
    images: ReadonlyArray<Attachment>
    resumePlanId: string | null
    adversarialBrief: string | null
    executePlanId: string | null
    executePlanMode: ExecutionMode | null
    agentTarget: "session" | "orchestrator"
    reasoningEffort?: ReasoningEffort
  }
>(({ sendBack, input }) => {
  const onEvent = (event: StreamEvent) => sendBack({ type: "STREAM_EVENT", event })
  // Three run kinds, one actor. An adversarial round is a planning round rather
  // than a turn; a stale-plan approval re-drives execution via `resumePlan`
  // (which restores the exec mode and prompts with the plan embedded); anything
  // else is a normal turn. They share the `running` state because they share
  // everything that matters downstream — the same StreamEvents, the same fold,
  // the same stop button.
  const cancel = input.adversarialBrief !== null
    ? // The brief's screenshots go with it: a Gigaplan round is very often
      // "build this mockup", and the roles run headless with no other way to see it.
      rpc.planAdversarial(
        input.sessionId,
        input.adversarialBrief.length > 0 ? input.adversarialBrief : undefined,
        onEvent,
        input.images
      )
    : input.executePlanId
      ? rpc.planExecute(input.sessionId, input.executePlanId, input.executePlanMode, onEvent)
      : input.resumePlanId
        ? rpc.agentResumePlan(input.sessionId, input.resumePlanId, onEvent)
        : rpc.agentRun(input.sessionId, input.text, onEvent, input.images, {
            target: input.agentTarget,
            reasoningEffort: input.reasoningEffort ?? null
          })
  return cancel
})

/**
 * Watch the adversarial reviewer for this session, for the whole life of the
 * machine — not just while a turn runs.
 *
 * Always-on because the reviewer is usually not started from here: the PR tab's
 * button fires it, and the background auto-review poll can start one for a
 * session nobody is looking at. Subscribing costs nothing while idle (the stream
 * stays quiet until a review starts) and means the Reviewer tab is live the
 * moment one does.
 */
const reviewStream = fromCallback<ConversationEvent, { sessionId: string }>(
  ({ sendBack, input }) =>
    rpc.reviewWatch(input.sessionId, (event) => sendBack({ type: "REVIEW_EVENT", event }))
)

const patchLast = (
  messages: ReadonlyArray<Message>,
  fn: (last: Message) => Message
): ReadonlyArray<Message> =>
  messages.length === 0 ? messages : [...messages.slice(0, -1), fn(messages[messages.length - 1]!)]

const gateStatusFor = (decision: GateDecision) =>
  decision === "deny" ? "rejected" : decision === "always" ? "always" : "approved"

const stamp = () => Date.now().toString(36)

/**
 * A new turn clears the tab bar — but the reviewer is not part of a turn. Keep a
 * working one (sending a message must not cost you sight of a live agent that is
 * still running in the background); drop a finished one, which matches how a
 * sub-agent's tab clears when the next run starts.
 */
const keepReviewer = (reviewer: Subagent | null): Subagent | null =>
  reviewer?.status === "working" ? reviewer : null

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as { session: Session }
  },
  actors: { loadConversation, agentStream, refreshDiff, reviewStream, stopAgent },
  guards: {
    isTerminal: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      (event.event._tag === "Done" || event.event._tag === "Failed"),
    hasQueued: ({ context }) => context.queued.length > 0,
    canPlanAdversarially: ({ context }) => context.planReadiness?.ready === true,

    /**
     * Whether THIS plan needs the per-step executor — asked of the plan, not of
     * the composer.
     *
     * `orchestrates` is the right question for a SEND, which is about what the
     * operator is doing now. It is the wrong question for approving a plan,
     * which is about what an earlier round already produced: a Gigaplan whose
     * steps carry assignees still has to run per-step even if the operator has
     * since flipped the mode chip, and readiness can go false simply by a
     * harness disappearing. Guarding approval on the live mode silently dropped
     * the click in both cases — the plan sat there with a button that did
     * nothing.
     */
    planExecutesPerStep: ({ context, event }) => {
      if (event.type !== "APPROVE_PLAN" && event.type !== "RESUME_PLAN") return false
      const planId = event.planId
      const plan = context.messages.reduce<Plan | null>(
        (found, m) =>
          m.parts.reduce<Plan | null>(
            (inner, p) => (p._tag === "Plan" && p.plan.id === planId ? p.plan : inner),
            found
          ),
        null
      )
      return plan !== null && plan.steps.some((st) => st.assignee !== undefined)
    },

  },
  actions: {
    appendTurns: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const text = event.text
      const images = event.images ?? []
      const now = new Date().toISOString()
      const id = stamp()
      const target = agentTargetFor(context.mode)
      return {
        pendingText: text,
        pendingImages: images,
        agentTarget: target,
        // A fresh turn starts with no sub-agents (any from a prior turn are gone).
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        resumePlanId: null,
        adversarialBrief: null,
        executePlanId: null,
        executePlanMode: null,
        // Context occupancy belongs to the resumed harness conversation, not to
        // one run. Keep the last reading visible until Usage replaces it.
        runStartedAt: Date.now(),
        lastOutcome: null,
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, text, now, images, messageSourceFor(target)),
          assistantMessage(`a_local_${id}`, now, messageSourceFor(target))
        ]
      }
    }),
    // Start a stale-plan re-drive: mark the plan approved, append a human-readable
    // turn, and flag the run so `agentStream` calls `resumePlan` (which restores
    // the exec mode + prompts the agent with the plan embedded).
    startResumePlan: assign(({ context, event }) => {
      // Also the fallback for APPROVE_PLAN on a plan with no per-step
      // assignees — an ordinary plan approved in an ordinary mode. Re-driving it
      // on the session's own harness is the honest behaviour; dropping the click
      // is not.
      if (event.type !== "RESUME_PLAN" && event.type !== "APPROVE_PLAN") return {}
      const now = new Date().toISOString()
      const id = stamp()
      return {
        resumePlanId: event.planId,
        agentTarget: "session" as const,
        // Both cleared, because `agentStream` picks its RPC by checking these in
        // order and `adversarialBrief` wins. Leaving the finished round's brief
        // set meant approving its plan started a WHOLE SECOND ROUND — two
        // flagship models and minutes of wall clock — instead of re-driving.
        // Every other run-starting action clears them; this one didn't.
        adversarialBrief: null,
        executePlanId: null,
        executePlanMode: null,
        pendingText: "",
        pendingImages: [],
        // A fresh run (the plan re-drive) starts with no sub-agents carried over.
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        runStartedAt: Date.now(),
        lastOutcome: null,
        messages: [
          ...context.messages.map((m) => setPlanStatus(m, event.planId, "approved")),
          userMessage(`u_local_${id}`, "Approved — implement the plan.", now),
          assistantMessage(`a_local_${id}`, now)
        ]
      }
    }),
    // Hold a message sent mid-run; it's replayed as a fresh turn once the agent
    // frees up (see `dequeueTurn`). A send with neither text nor images is ignored.
    enqueue: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const text = event.text.trim()
      const images = event.images ?? []
      if (text.length === 0 && images.length === 0) return {}
      return {
        queued: [...context.queued, { text, images, target: agentTargetFor(context.mode) }]
      }
    }),
    // Drop a still-pending queued message before it's sent.
    removeQueued: assign(({ context, event }) => {
      if (event.type !== "UNQUEUE") return {}
      return { queued: context.queued.filter((_, i) => i !== event.index) }
    }),
    // "Send now": jump a queued message to the head so it runs as the very next
    // turn. Paired with `callStop` in `running`, this interrupts the current turn
    // to steer the agent immediately; the remaining queue keeps its order behind it.
    promoteQueued: assign(({ context, event }) => {
      if (event.type !== "SEND_NOW") return {}
      const picked = context.queued[event.index]
      if (picked === undefined) return {}
      const rest = context.queued.filter((_, i) => i !== event.index)
      return { queued: [picked, ...rest] }
    }),
    clearQueue: assign(() => ({ queued: [] })),
    // Pop the head of the queue into a fresh turn — the same shape `appendTurns`
    // produces for a live SEND, so `running` streams it exactly as a normal turn.
    dequeueTurn: assign(({ context }) => {
      const [next, ...rest] = context.queued
      if (next === undefined) return {}
      const now = new Date().toISOString()
      const id = stamp()
      return {
        queued: rest,
        pendingText: next.text,
        pendingImages: next.images,
        agentTarget: next.target,
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        resumePlanId: null,
        adversarialBrief: null,
        executePlanId: null,
        executePlanMode: null,
        runStartedAt: Date.now(),
        lastOutcome: null,
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, next.text, now, next.images, messageSourceFor(next.target)),
          assistantMessage(`a_local_${id}`, now, messageSourceFor(next.target))
        ]
      }
    }),
    foldEvent: assign(({ context, event }) => {
      if (event.type !== "STREAM_EVENT") return {}
      const e = event.event
      // The harness has revealed that a task we already opened a tab for is
      // BACKGROUNDED. It lives in the session dock from here on, so retract the
      // tab rather than showing the same work twice — see `retractSubagent`.
      // `toolUseId` is the spawning tool_use id, i.e. exactly the tab's own id;
      // tasks with no tool_use (ambient/workflow) never opened one.
      if (e._tag === "BackgroundTaskStarted") {
        return e.toolUseId === null ? {} : { subagents: retractSubagent(context.subagents, e.toolUseId) }
      }
      // Sub-agent-scoped events drive the watch-only tabs, not the main turn.
      if (isSubagentEvent(e)) {
        return { subagents: applySubagentEvent(context.subagents, e) }
      }
      // This is the latest context size, not a high-water mark. Compaction can
      // legitimately make it smaller during a run.
      if (e._tag === "Usage") {
        return { tokens: e.tokens }
      }
      // A compaction reseeds the harness, so the working set restarts from the
      // primer. Reset the reading immediately rather than waiting for the next
      // `Usage`: leaving the old number up means the meter sits pinned at full
      // through the very turn that fixed it, which reads as the feature not
      // working. It also folds into the transcript, so the marker renders.
      if (e._tag === "ContextCompacted") {
        return {
          tokens: 0,
          messages: patchLast(context.messages, (last) => applyStreamEvent(last, e))
        }
      }
      // A `PlanUpdated` addresses a plan by id, and that plan part lives in the
      // message of the turn it was PROPOSED in — which, once execution runs on
      // into later turns, is not the last message. Folding it with `patchLast`
      // targets a message holding no plan, so every cross-turn progress tick is
      // silently dropped. Address the plan's own message instead.
      if (e._tag === "PlanUpdated") {
        return {
          messages: context.messages.map((m) =>
            m.parts.some((p) => p._tag === "Plan" && p.plan.id === e.plan.id)
              ? applyStreamEvent(m, e)
              : m
          )
        }
      }
      const messages = patchLast(context.messages, (last) => applyStreamEvent(last, e))
      // A finished/failed turn KEEPS its sub-agents (their tabs stay readable) —
      // any still marked "working" (e.g. an interrupted run, or a sub-agent whose
      // `task_notification` never arrived) settle to "done" so no tab shows a live
      // spinner. The spinner is driven by the message's `streaming` flag, NOT by
      // `status`, so the rolling message has to settle too — flipping the status
      // alone left the dots pulsing forever. The list resets when the next run
      // starts (`clearSubagents`). Keep a live context reading when one arrived;
      // Done's tokens are only a fallback for harnesses that report at turn end.
      const settled = context.subagents.map((s) =>
        s.status === "working"
          ? { ...s, status: "done" as const, message: settleStreaming(s.message) }
          : s
      )
      if (e._tag === "Done") {
        return {
          messages,
          subagents: settled,
          tokens: context.tokens > 0 ? context.tokens : e.tokens,
          runStartedAt: null,
          lastOutcome: "done" as const
        }
      }
      if (e._tag === "Failed") {
        return { messages, subagents: settled, runStartedAt: null, lastOutcome: "failed" as const }
      }
      // The harness reports its actual model on init — reflect it in the chip.
      return e._tag === "Started" && e.model ? { messages, model: e.model } : { messages }
    }),
    clearSubagents: assign(() => ({ subagents: [] as ReadonlyArray<Subagent> })),
    // Realtime Changes rail: when a tool that touched files lands mid-run, re-read
    // the worktree diff right away (fire-and-forget) so the rail reflects edits as
    // they happen, not only after the whole turn settles. `ToolEnd.diff` is the
    // harness's own signal that this tool changed files.
    liveRefreshDiff: ({ context, event, self }) => {
      if (event.type !== "STREAM_EVENT") return
      const e = event.event
      if (e._tag !== "ToolEnd" || e.status !== "success" || e.diff === null) return
      void rpc
        .sessionsDiff(context.session.id)
        .then((patch) => self.send({ type: "PATCH_UPDATED", patch }))
        .catch(() => {})
    },
    applyLivePatch: assign(({ event }) =>
      event.type === "PATCH_UPDATED" ? { patch: event.patch } : {}
    ),
    optimisticGate: assign(({ context, event }) => {
      if (event.type !== "DECIDE_GATE") return {}
      void rpc.agentDecideGate(context.session.id, event.gateId, event.decision)
      const status = gateStatusFor(event.decision)
      return { messages: context.messages.map((m) => setGateStatus(m, event.gateId, status)) }
    }),
    optimisticAnswer: assign(({ context, event }) => {
      if (event.type !== "ANSWER_QUESTION") return {}
      void rpc.agentAnswerQuestion(context.session.id, event.requestId, event.answers)
      return {
        messages: context.messages.map((m) => setQuestionAnswers(m, event.requestId, event.answers))
      }
    }),
    persistMode: assign(({ context, event }) => {
      if (event.type !== "SET_MODE") return {}
      void rpc.agentSetMode(context.session.id, event.mode)
      return isExecutionMode(event.mode)
        ? { mode: event.mode, executionMode: event.mode }
        : { mode: event.mode }
    }),
    persistReasoning: assign(({ context, event }) => {
      if (event.type !== "SET_REASONING") return {}
      void rpc.agentSetReasoning(context.session.id, event.reasoningEffort)
      return { reasoningEffort: event.reasoningEffort }
    }),
    // Plan mode (optimistic + fire-and-forget, like the gate/question actions).
    // The runner echoes a `PlanUpdated` so the authoritative state reconciles.
    optimisticPlanComment: assign(({ context, event }) => {
      if (event.type !== "COMMENT_PLAN_STEP") return {}
      void rpc.agentCommentPlanStep(context.session.id, event.planId, event.stepId, event.body)
      const comment: PlanComment = {
        id: `pc_local_${stamp()}`,
        stepId: event.stepId,
        body: event.body,
        author: "user",
        createdAt: new Date().toISOString(),
        routed: false
      }
      return { messages: context.messages.map((m) => addPlanComment(m, event.planId, comment)) }
    }),
    optimisticPlanRevise: assign(({ context, event }) => {
      if (event.type !== "REVISE_PLAN") return {}
      void rpc.agentRevisePlan(context.session.id, event.planId)
      return { messages: context.messages.map((m) => setPlanStatus(m, event.planId, "revising")) }
    }),
    /**
     * Start executing an approved Gigaplan.
     *
     * Unlike `startResumePlan`, this does NOT prompt one harness with the plan
     * embedded — it hands the plan to the executor, which runs each step on the
     * harness that step was assigned. That is the entire point of the mode, and
     * until this ran the round's per-step assignment was decoration.
     */
    beginPlanExecution: assign(({ context, event }) => {
      if (event.type !== "APPROVE_PLAN" && event.type !== "RESUME_PLAN") return {}
      const now = new Date().toISOString()
      const id = stamp()
      const executionMode =
        event.type === "APPROVE_PLAN"
          ? (event.executionMode ?? context.executionMode)
          : context.executionMode
      return {
        executePlanId: event.planId,
        executePlanMode: executionMode,
        agentTarget: "session" as const,
        resumePlanId: null,
        adversarialBrief: null,
        mode: executionMode,
        executionMode,
        pendingText: "",
        pendingImages: [],
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        runStartedAt: Date.now(),
        lastOutcome: null,
        // The same two turns every other run kind appends, and for the same
        // reason: `applyStreamEvent` folds into the LAST message, so without an
        // assistant turn to land in, every step's output would be dropped.
        messages: [
          ...context.messages.map((m) => setPlanStatus(m, event.planId, "approved")),
          userMessage(`u_local_${id}`, "Approved — run the plan.", now),
          assistantMessage(`a_local_${id}`, now)
        ]
      }
    }),
    optimisticPlanApprove: assign(({ context, event }) => {
      if (event.type !== "APPROVE_PLAN") return {}
      const executionMode = event.executionMode ?? context.executionMode
      void rpc.agentApprovePlan(context.session.id, event.planId, event.executionMode)
      return {
        mode: executionMode,
        executionMode,
        messages: context.messages.map((m) => setPlanStatus(m, event.planId, "approved"))
      }
    }),
    /**
     * Apply a harness/model pick. Picking a model under another provider's
     * heading switches harness, which has consequences beyond the chip:
     *  - `resumeId` is dropped (main does the authoritative write) — the new
     *    harness starts a fresh thread, so the transcript stays on screen but the
     *    agent won't recall earlier turns;
     *  - `plan` mode degrades to `ask` on a harness that can't hold it
     *    (`supportsPlanMode`) — cursor and starbase;
     *  - skills are per-harness, so the `/` menu is refetched.
     */
    persistHarness: assign(({ context, event, self }) => {
      if (event.type !== "SET_HARNESS") return {}
      const switched = event.cli !== context.cli
      void rpc.agentSetHarness(context.session.id, event.cli, event.model)
      if (!switched) return { model: event.model }

      void rpc
        .skillsList(context.session.id)
        .then((skills) => self.send({ type: "SKILLS_LOADED", skills }))
        .catch(() => {})

      const mode = context.mode === "plan" && !supportsPlanMode(event.cli) ? "ask" : context.mode
      return {
        cli: event.cli,
        model: event.model,
        // Mirror main's write so the UI doesn't lie until the next load.
        session: { ...context.session, cli: event.cli, resumeId: undefined },
        mode,
        executionMode: isExecutionMode(mode) ? mode : context.executionMode,
        // Empty until the refetch lands — better a bare `/` menu than one
        // offering the old harness's skills.
        skills: []
      }
    }),
    applySkills: assign(({ event }) => (event.type === "SKILLS_LOADED" ? { skills: event.skills } : {})),
    /**
     * Fetch the model catalogue OUT OF BAND, not as part of `loadConversation`.
     * It reaches `DiscoveryService` and probes the Codex CLI for its models —
     * hundreds of ms to seconds. `loading` has no event handlers, so anything the
     * operator does before it settles (typing a message, Shift+Tab) is silently
     * dropped; gating the transcript on a CLI probe would widen that hole from
     * imperceptible to seconds. The chip just fills itself in a beat later.
     */
    /**
     * Ask whether adversarial planning is offerable. Fire-and-forget on entry,
     * like the catalogue: a failure leaves `planReadiness` null, which renders
     * the entry disabled — the safe direction, since offering a round we cannot
     * run is worse than not offering one we could.
     */
    loadReadiness: ({ self }) => {
      void rpc
        .planReadiness()
        .then((readiness) => self.send({ type: "READINESS_LOADED", readiness }))
        .catch(() => {})
    },
    applyReadiness: assign(({ event }) =>
      event.type === "READINESS_LOADED" ? { planReadiness: event.readiness } : {}
    ),
    /**
     * Start an adversarial planning round. The brief rides on the context and
     * `agentStream` redirects on it, so the round reuses the whole running-state
     * machinery — stop, streaming, sub-agent tabs — rather than duplicating it.
     */
    beginAdversarial: assign(({ context, event }) => {
      if (event.type !== "HANDOFF_PLAN") return {}
      // Empty is an intentional sentinel: main derives the brief and screenshots
      // from the durable Gigaplan intake transcript.
      // Main owns the persisted Create/Update wording from the durable
      // transcript. This local turn only gives streamed events somewhere to
      // land, so keep it neutral rather than guessing from optimistic state.
      const label = "Hand off this Gigaplan conversation to planning."
      const now = new Date().toISOString()
      const id = stamp()
      return {
        adversarialBrief: "",
        agentTarget: "session" as const,
        pendingText: "",
        pendingImages: [],
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        resumePlanId: null,
        executePlanId: null,
        executePlanMode: null,
        runStartedAt: Date.now(),
        lastOutcome: null,
        // The same two turns a normal send appends, and for the same reason:
        // `applyStreamEvent` folds into the LAST message, so without an
        // assistant turn to land in, the round's plan — and every event before
        // it — would be silently dropped.
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, label, now),
          assistantMessage(`a_local_${id}`, now)
        ]
      }
    }),
    loadCatalog: ({ self }) => {
      void rpc
        .modelsCatalog()
        .then((catalog) => self.send({ type: "CATALOG_LOADED", catalog }))
        .catch(() => {})
    },

    /**
     * The `/` menu's contents, fetched out of band for the same reason as the
     * catalogue above: `Skills.list` asks the HARNESS what commands it has,
     * which means spawning it — seconds, in the worst case. Awaiting it inside
     * `loadConversation` held the machine in `loading`, where SEND isn't
     * handled, so a prompt typed on open was silently dropped and the composer
     * did nothing at all.
     */
    loadSkills: ({ context, self }) => {
      void rpc
        .skillsList(context.session.id)
        .then((skills) => self.send({ type: "SKILLS_LOADED", skills }))
        .catch(() => {})
    },
    applyCatalog: assign(({ event }) =>
      event.type === "CATALOG_LOADED" ? { catalog: event.catalog } : {}
    ),
    /** Fold one reviewer event into its tab + the PR button's phase/timer. */
    applyReview: assign(({ context, event }) => {
      if (event.type !== "REVIEW_EVENT") return {}
      const e = event.event
      const phase = nextReviewPhase(context.reviewPhase, e)
      const settled = phase === "done" || phase === "error"
      return {
        reviewer: applyReviewEvent(context.reviewer, e),
        reviewPhase: phase,
        // Timed from `Started` (the run actually beginning), not from the click:
        // a watcher that attaches mid-run replays from the buffer, and anchoring
        // on attach would restart its clock at zero and under-report the age.
        // Cleared once settled so the button drops back to "Review again".
        reviewStartedAt: settled
          ? null
          : e._tag === "Started"
            ? Date.now()
            : (context.reviewStartedAt ?? Date.now())
      }
    }),
    /**
     * Record the SETTLED lifecycle status, so a session the operator hasn't opened
     * this run still reports whether it's idle or blocked on them (the sidebar
     * falls back to this when there's no live activity).
     *
     * Only ever a settled status — never "thinking"/"running". A run lives in the
     * main process and dies with the app, so persisting a busy status would leave
     * the session reading "thinking" forever after a restart, for a run that no
     * longer exists. Entering `awaitingInput` from `loading` also repairs any
     * status already stale from an earlier crash.
     */
    persistSettledStatus: assign(({ context }) => {
      // A failed transcript load also lands in `awaitingInput`, but with an empty
      // `messages` — which derives "idle" and would ERASE a truthful persisted
      // "needs-input" for a session genuinely blocked on the operator. Only a
      // transcript we actually read can be trusted to repair the status.
      if (!context.loaded) return {}
      // At the "idle" phase `activityOf` only ever reports a blocked-on-the-
      // operator activity (or nothing) — so the settled status falls straight out
      // of it, and a busy status is unrepresentable rather than merely avoided.
      const activity = activityOf(context.messages, "idle")
      const status: SettledSessionStatus = activity ? "needs-input" : "idle"
      if (status === context.persistedStatus) return {}
      // The machine writes this on its own, far from App.tsx — announce the
      // returned record so `appMachine`'s session list (the sidebar's fallback)
      // doesn't keep serving the pre-write status until the next restart.
      void rpc
        .sessionsSetStatus(context.session.id, status)
        .then(publishSessionUpdate)
        .catch(() => {
          /* best-effort: a failed status write must never break the turn */
        })
      return { persistedStatus: status }
    }),
    /**
     * Close out the turn the operator just halted.
     *
     * We can't wait for the runner's own terminal event: STOP leaves `running`
     * immediately, and `STREAM_EVENT` is only handled there — so that event
     * arrives to a machine that has stopped listening. Without this the turn
     * would spin forever (until a reload, where `settleLoaded` cleans it up).
     * Folding the SAME note the runner persists keeps the live view and a
     * reloaded transcript in agreement.
     */
    settleStoppedRun: assign(({ context }) => ({
      messages: patchLast(context.messages, (last) =>
        applyStreamEvent(last, { _tag: "Failed", message: STOPPED_NOTE })
      ),
      runStartedAt: null,
      // The OPERATOR stopped this run. Recording it as `failed` would notify
      // them that their own deliberate action went wrong.
      lastOutcome: null
    }))
  }
}).createMachine({
  id: "conversation",
  initial: "loading",
  // Kick the (slow, out-of-band) model catalogue + `/` menu fetches off once, at
  // start. Both probe a CLI, so neither may gate the transcript — see below.
  entry: ["loadCatalog", "loadSkills", "loadReadiness"],
  // Watch the reviewer for the machine's whole life — a review is not part of a
  // turn, so it can start, run and finish in any state.
  invoke: { src: "reviewStream", input: ({ context }) => ({ sessionId: context.session.id }) },
  // All three can land in any state — they race nothing. SKILLS_LOADED belongs
  // here for the same reason CATALOG_LOADED does: now that the `/` menu is
  // fetched out of band, its reply can arrive while the transcript is still
  // loading, and a per-state handler would drop it on the floor.
  on: {
    CATALOG_LOADED: { actions: "applyCatalog" },
    READINESS_LOADED: { actions: "applyReadiness" },
    SKILLS_LOADED: { actions: "applySkills" },
    REVIEW_EVENT: { actions: "applyReview" },
    SET_REASONING: { actions: "persistReasoning" }
  },
  context: ({ input }) => ({
    session: input.session,
    messages: [],
    mode: input.session.mode ?? "accept-edits",
    executionMode:
      input.session.mode && isExecutionMode(input.session.mode)
        ? input.session.mode
        : "accept-edits",
    skills: [],
    files: [],
    cli: input.session.cli,
    model: input.session.model ?? defaultModel(input.session.cli),
    catalog: [],
    patch: "",
    pendingText: "",
    pendingImages: [],
    agentTarget: "session",
    reasoningEffort: input.session.reasoningEffort,
    queued: [],
    subagents: [],
    resumePlanId: null,
    adversarialBrief: null,
    executePlanId: null,
    executePlanMode: null,
    planReadiness: null,
    // Rehydrate the last measured working set immediately. ContextManager owns
    // the trigger/phase snapshot, but the view reads this live field for the
    // meter's numerator; starting at zero hid the whole component after every
    // app restart until Codex happened to emit another Usage event.
    tokens: input.session.contextTokens ?? 0,
    runStartedAt: null,
    lastOutcome: null,
    persistedStatus: input.session.status,
    loaded: false,
    reviewer: null,
    reviewPhase: "starting",
    reviewStartedAt: null
  }),
  states: {
    loading: {
      /**
       * The composer and its chips are on screen and interactive while this
       * runs, and `loadConversation` is not instant — it asks the harness for
       * its command list, which means spawning it. Without these, a model or
       * mode picked in that window is silently swallowed: the menu closes, the
       * chip snaps back, nothing happens.
       *
       * Safe here because `onDone` below assigns only transcript state
       * (messages/skills/files/patch) and never `cli`/`model`/`mode` — so a
       * choice made mid-load survives the transition rather than being clobbered.
       */
      on: {
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" },
        // The composer is enabled from the first paint, so a prompt can be sent
        // before the transcript lands — and a dropped one is invisible: the box
        // clears and the operator believes they sent it. Hold it and run it the
        // moment the load settles, exactly as a send during a run is held.
        SEND: { actions: "enqueue" }
      },
      invoke: {
        src: "loadConversation",
        input: ({ context }) => ({ session: context.session }),
        // A prompt sent while loading starts its turn as soon as the transcript
        // settles; otherwise we go idle. The transcript is applied either way.
        onDone: [
          {
            guard: "hasQueued",
            target: "running",
            actions: [
              assign(({ event }) => ({
                messages: event.output.transcript,
                files: event.output.files,
                patch: event.output.patch,
                loaded: true
              })),
              "dequeueTurn"
            ]
          },
          {
            target: "awaitingInput",
            actions: assign(({ event }) => ({
              messages: event.output.transcript,
              files: event.output.files,
              patch: event.output.patch,
              loaded: true
            }))
          }
        ],
        // `loaded` stays false — the empty `messages` here says nothing about the
        // session, so the status write is skipped rather than clobbering it. A
        // prompt held through a FAILED load still runs: losing the transcript is
        // no reason to also lose what the operator just typed.
        onError: [
          { guard: "hasQueued", target: "running", actions: "dequeueTurn" },
          { target: "awaitingInput" }
        ]
      }
    },
    awaitingInput: {
      // Nothing is running here — this is the one place the session's persisted
      // status can be recorded truthfully.
      entry: "persistSettledStatus",
      on: {
        // Gigaplan sends continue its orchestrator intake thread. The separate
        // handoff below is the only path that spends on an adversarial round.
        SEND: { target: "running", actions: "appendTurns" },
        // Approving a finished Gigaplan runs it per-step; anything else
        // re-drives a stale plan on the session's own harness. Both arrive here
        // rather than in `running` because neither has a live run to resume:
        // the round ended, or the app was restarted.
        // Two arms, never zero: a single guarded transition meant a click that
        // failed the guard was swallowed with nothing on screen to explain it.
        APPROVE_PLAN: [
          { guard: "planExecutesPerStep", target: "running", actions: "beginPlanExecution" },
          { target: "running", actions: "startResumePlan" }
        ],
        RESUME_PLAN: [
          { guard: "planExecutesPerStep", target: "running", actions: "beginPlanExecution" },
          { target: "running", actions: "startResumePlan" }
        ],
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" },
        // Start an adversarial planning round. Guarded on readiness rather than
        // trusted from the UI: the entry is disabled without two vendors, but a
        // stale readiness or a keyboard path must not start a round that the
        // service would only refuse.
        HANDOFF_PLAN: {
          guard: "canPlanAdversarially",
          target: "running",
          actions: "beginAdversarial"
        },
        // Re-read the worktree diff on demand (e.g. after a revert from the rail).
        REFRESH_DIFF: { target: "refreshingDiff" }
      }
    },
    running: {
      invoke: {
        src: "agentStream",
        input: ({ context }) => ({
          sessionId: context.session.id,
          text: context.pendingText,
          images: context.pendingImages,
          resumePlanId: context.resumePlanId,
          adversarialBrief: context.adversarialBrief,
          executePlanId: context.executePlanId,
          executePlanMode: context.executePlanMode,
          agentTarget: context.agentTarget,
          reasoningEffort: context.reasoningEffort
        })
      },
      on: {
        STREAM_EVENT: [
          { guard: "isTerminal", target: "refreshingDiff", actions: "foldEvent" },
          { actions: ["foldEvent", "liveRefreshDiff"] }
        ],
        // A live diff read resolved — reflect it in the Changes rail.
        PATCH_UPDATED: { actions: "applyLivePatch" },
        // Sent mid-run: queue it (processed once this turn + its diff refresh settle).
        SEND: { actions: "enqueue" },
        UNQUEUE: { actions: "removeQueued" },
        // "Send now": interrupt the current turn and run the picked message next,
        // so the operator can steer mid-stream. Promote it to the head, then go
        // through `stopping` so the halt has landed before the next turn starts;
        // refreshingDiff dequeues it (the rest of the queue follows).
        SEND_NOW: {
          target: "stopping",
          actions: ["promoteQueued", "settleStoppedRun"]
        },
        DECIDE_GATE: { actions: "optimisticGate" },
        ANSWER_QUESTION: { actions: "optimisticAnswer" },
        COMMENT_PLAN_STEP: { actions: "optimisticPlanComment" },
        REVISE_PLAN: { actions: "optimisticPlanRevise" },
        APPROVE_PLAN: { actions: "optimisticPlanApprove" },
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" },
        // Stopping abandons the queue too — the operator asked the agent to halt.
        // Live sub-agent tabs go with it (no completion events will arrive).
        STOP: {
          target: "stopping",
          actions: ["settleStoppedRun", "clearQueue", "clearSubagents"]
        }
      }
    },
    /**
     * Waiting for a halt to actually land, before anything else may start a run.
     *
     * This state exists for one reason: the old code fired `agentStop` and
     * transitioned onward in the same breath, so the interrupt could arrive
     * after the next turn had already been forked and kill that instead. The
     * operator saw their new message answered with "Stopped.".
     *
     * Every exit leads to `refreshingDiff`, including the failure and timeout
     * arms — a stop that errors or hangs must never strand the machine in a
     * state with no composer.
     */
    stopping: {
      invoke: {
        src: "stopAgent",
        input: ({ context }) => ({ sessionId: context.session.id }),
        onDone: { target: "refreshingDiff" },
        // A failed stop still means we are no longer streaming: the turn was
        // already settled by `settleStoppedRun` on the way in.
        onError: { target: "refreshingDiff" }
      },
      after: { [STOP_SETTLE_CAP]: { target: "refreshingDiff" } },
      on: {
        // Keep accepting sends — they run once the diff settles, as elsewhere.
        SEND: { actions: "enqueue" },
        UNQUEUE: { actions: "removeQueued" },
        SEND_NOW: { actions: "promoteQueued" },
        // The run is already being halted; a second STOP only clears the queue.
        STOP: { actions: ["clearQueue", "clearSubagents"] },
        PATCH_UPDATED: { actions: "applyLivePatch" },
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" }
      }
    },
    // After a turn ends, re-read the worktree diff so the Changes rail reflects
    // whatever the agent actually edited.
    refreshingDiff: {
      invoke: {
        src: "refreshDiff",
        input: ({ context }) => ({ session: context.session }),
        // A queued message starts its turn as soon as the diff settles; otherwise
        // we return to idle. The diff is applied either way.
        onDone: [
          {
            guard: "hasQueued",
            target: "running",
            actions: [assign(({ event }) => ({ patch: event.output })), "dequeueTurn"]
          },
          { target: "awaitingInput", actions: assign(({ event }) => ({ patch: event.output })) }
        ],
        onError: [
          { guard: "hasQueued", target: "running", actions: "dequeueTurn" },
          { target: "awaitingInput" }
        ]
      },
      on: {
        // Still accept queued sends while the diff refreshes (a brief window).
        SEND: { actions: "enqueue" },
        UNQUEUE: { actions: "removeQueued" },
        // The turn already ended — just jump the picked message to the head so the
        // pending dequeue (on refresh settle) runs it next.
        SEND_NOW: { actions: "promoteQueued" },
        // A late live diff read may still resolve here — apply it (the authoritative
        // refresh's onDone runs last, so it wins).
        PATCH_UPDATED: { actions: "applyLivePatch" },
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" }
      }
    }
  }
})
