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
  Attachment,
  CliKind,
  GateDecision,
  Message,
  PermissionMode,
  PlanComment,
  ProviderModels,
  QuestionAnswer,
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
  userMessage
} from "@starbase/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"

export interface ConversationContext {
  readonly session: Session
  readonly messages: ReadonlyArray<Message>
  readonly mode: PermissionMode
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
  /** Tokens currently occupying the main agent's context window. */
  readonly tokens: number
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  readonly runStartedAt: number | null
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

/** A prompt held in the queue while the agent is busy (text + any attachments). */
export interface QueuedMessage {
  readonly text: string
  readonly images: ReadonlyArray<Attachment>
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
  | { type: "SKILLS_LOADED"; skills: ReadonlyArray<Skill> }
  | { type: "CATALOG_LOADED"; catalog: ReadonlyArray<ProviderModels> }
  | { type: "REVIEW_EVENT"; event: StreamEvent }
  | { type: "COMMENT_PLAN_STEP"; planId: string; stepId: string; body: string }
  | { type: "REVISE_PLAN"; planId: string }
  | { type: "APPROVE_PLAN"; planId: string }
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

/** Subscribe to the agent's event stream, forwarding each event into the machine. */
const agentStream = fromCallback<
  ConversationEvent,
  { sessionId: string; text: string; images: ReadonlyArray<Attachment>; resumePlanId: string | null }
>(({ sendBack, input }) => {
  const onEvent = (event: StreamEvent) => sendBack({ type: "STREAM_EVENT", event })
  // A stale-plan approval re-drives execution via `resumePlan` (which restores the
  // exec mode and prompts with the plan embedded); a normal turn uses `run`.
  const cancel = input.resumePlanId
    ? rpc.agentResumePlan(input.sessionId, input.resumePlanId, onEvent)
    : rpc.agentRun(input.sessionId, input.text, onEvent, input.images)
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
  actors: { loadConversation, agentStream, refreshDiff, reviewStream },
  guards: {
    isTerminal: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      (event.event._tag === "Done" || event.event._tag === "Failed"),
    hasQueued: ({ context }) => context.queued.length > 0
  },
  actions: {
    appendTurns: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const now = new Date().toISOString()
      const id = stamp()
      const images = event.images ?? []
      return {
        pendingText: event.text,
        pendingImages: images,
        // A fresh turn starts with no sub-agents (any from a prior turn are gone).
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        resumePlanId: null,
        // Reset the live analytics for the new run.
        tokens: 0,
        runStartedAt: Date.now(),
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, event.text, now, images),
          assistantMessage(`a_local_${id}`, now)
        ]
      }
    }),
    // Start a stale-plan re-drive: mark the plan approved, append a human-readable
    // turn, and flag the run so `agentStream` calls `resumePlan` (which restores
    // the exec mode + prompts the agent with the plan embedded).
    startResumePlan: assign(({ context, event }) => {
      if (event.type !== "RESUME_PLAN") return {}
      const now = new Date().toISOString()
      const id = stamp()
      return {
        resumePlanId: event.planId,
        pendingText: "",
        pendingImages: [],
        // A fresh run (the plan re-drive) starts with no sub-agents carried over.
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        tokens: 0,
        runStartedAt: Date.now(),
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
      return { queued: [...context.queued, { text, images }] }
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
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        resumePlanId: null,
        tokens: 0,
        runStartedAt: Date.now(),
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, next.text, now, next.images),
          assistantMessage(`a_local_${id}`, now)
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
          runStartedAt: null
        }
      }
      if (e._tag === "Failed") return { messages, subagents: settled, runStartedAt: null }
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
      return { mode: event.mode }
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
    optimisticPlanApprove: assign(({ context, event }) => {
      if (event.type !== "APPROVE_PLAN") return {}
      void rpc.agentApprovePlan(context.session.id, event.planId)
      return { messages: context.messages.map((m) => setPlanStatus(m, event.planId, "approved")) }
    }),
    /**
     * Apply a harness/model pick. Picking a model under another provider's
     * heading switches harness, which has consequences beyond the chip:
     *  - `resumeId` is dropped (main does the authoritative write) — the new
     *    harness starts a fresh thread, so the transcript stays on screen but the
     *    agent won't recall earlier turns;
     *  - `plan` mode is Claude-only, so it degrades to `ask` elsewhere;
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

      return {
        cli: event.cli,
        model: event.model,
        // Mirror main's write so the UI doesn't lie until the next load.
        session: { ...context.session, cli: event.cli, resumeId: undefined },
        mode: context.mode === "plan" && event.cli !== "claude" ? "ask" : context.mode,
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
    callStop: ({ context }) => {
      void rpc.agentStop(context.session.id)
    },
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
      runStartedAt: null
    }))
  }
}).createMachine({
  id: "conversation",
  initial: "loading",
  // Kick the (slow, out-of-band) model catalogue + `/` menu fetches off once, at
  // start. Both probe a CLI, so neither may gate the transcript — see below.
  entry: ["loadCatalog", "loadSkills"],
  // Watch the reviewer for the machine's whole life — a review is not part of a
  // turn, so it can start, run and finish in any state.
  invoke: { src: "reviewStream", input: ({ context }) => ({ sessionId: context.session.id }) },
  // All three can land in any state — they race nothing. SKILLS_LOADED belongs
  // here for the same reason CATALOG_LOADED does: now that the `/` menu is
  // fetched out of band, its reply can arrive while the transcript is still
  // loading, and a per-state handler would drop it on the floor.
  on: {
    CATALOG_LOADED: { actions: "applyCatalog" },
    SKILLS_LOADED: { actions: "applySkills" },
    REVIEW_EVENT: { actions: "applyReview" }
  },
  context: ({ input }) => ({
    session: input.session,
    messages: [],
    mode: input.session.mode ?? "accept-edits",
    skills: [],
    files: [],
    cli: input.session.cli,
    model: input.session.model ?? defaultModel(input.session.cli),
    catalog: [],
    patch: "",
    pendingText: "",
    pendingImages: [],
    queued: [],
    subagents: [],
    resumePlanId: null,
    tokens: 0,
    runStartedAt: null,
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
        SEND: { target: "running", actions: "appendTurns" },
        // Approve a stale plan (its original run is gone) → re-drive execution.
        RESUME_PLAN: { target: "running", actions: "startResumePlan" },
        SET_MODE: { actions: "persistMode" },
        SET_HARNESS: { actions: "persistHarness" },
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
          resumePlanId: context.resumePlanId
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
        // so the operator can steer mid-stream. Promote it to the head, stop the
        // run, and let refreshingDiff dequeue it (the rest of the queue follows).
        SEND_NOW: {
          target: "refreshingDiff",
          actions: ["promoteQueued", "callStop", "settleStoppedRun"]
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
          target: "refreshingDiff",
          actions: ["callStop", "settleStoppedRun", "clearQueue", "clearSubagents"]
        }
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
