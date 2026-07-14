/**
 * Thin view over `conversationMachine` — the deterministic conversation flow
 * lives in the chart (loading / awaitingInput / running), so this hook only maps
 * the current snapshot to props and events to sends.
 *
 * The actor itself is NOT owned by this hook: it lives in `conversation-registry`
 * so it outlives the pane (mounted keyed by the active session). Switching
 * sessions therefore detaches the view without stopping the run — the background
 * agent keeps working. Attaching to an existing actor also means switching back
 * shows its up-to-date state with no reload.
 */
import { useMemo } from "react"
import { useSelector } from "@xstate/react"
import type {
  Attachment,
  GateDecision,
  Message,
  ModelOption,
  PermissionMode,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Skill,
  Subagent
} from "@starbase/core"
import { latestPlan, pendingPlan, pendingQuestion } from "@starbase/core"
import type { QueuedMessage } from "./conversation-machine.js"
import { getConversationActor } from "./conversation-registry.js"

export interface Conversation {
  readonly messages: ReadonlyArray<Message>
  readonly mode: PermissionMode
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  /** Current harness model id + the models it supports. */
  readonly model: string
  readonly models: ReadonlyArray<ModelOption>
  /** The worktree's current unified diff, for the Changes rail. */
  readonly patch: string
  /** The agent is producing a turn (or paused at a gate). */
  readonly busy: boolean
  /** The agent is paused awaiting a HITL decision. */
  readonly paused: boolean
  /** Messages queued while the agent was busy (sent FIFO once it frees up). */
  readonly queued: ReadonlyArray<QueuedMessage>
  /** Live sub-agents (harness `Task` spawns) for the current turn — watch-only tabs. */
  readonly subagents: ReadonlyArray<Subagent>
  /** Drop a queued message before it's sent (by index). */
  readonly unqueue: (index: number) => void
  /** Interrupt the current turn and run a queued message now (steer mid-stream). */
  readonly sendNow: (index: number) => void
  /** A pending AskUserQuestion group (the composer is replaced while set), or null. */
  readonly question: QuestionRequest | null
  readonly answerQuestion: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** The latest open plan (proposed / revising), for the Plan Review tab, or null. */
  readonly plan: Plan | null
  readonly commentPlanStep: (planId: string, stepId: string, body: string) => void
  readonly revisePlan: (planId: string) => void
  readonly approvePlan: (planId: string) => void
  readonly resumePlan: (planId: string) => void
  /** Live status for the sidebar/tab bar, or null when idle (use persisted). */
  readonly status: SessionStatus | null
  readonly sendPrompt: (text: string, images?: ReadonlyArray<Attachment>) => void
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setModel: (model: string) => void
  readonly stop: () => void
  /** Re-read the worktree diff (e.g. after reverting from the Changes rail). */
  readonly refreshDiff: () => void
}

export function useConversation(session: Session): Conversation {
  const actor = useMemo(() => getConversationActor(session), [session.id])
  const state = useSelector(actor, (s) => s)
  const send = actor.send
  const { messages, mode, skills, files, model, models, patch, queued, subagents } = state.context

  const paused = useMemo(() => {
    const last = messages[messages.length - 1]
    return (
      last?.role === "assistant" &&
      last.parts.some((p) => p._tag === "Gate" && p.gate.status === "pending")
    )
  }, [messages])

  const question = useMemo(() => pendingQuestion(messages), [messages])
  // `plan` (any status) drives the Plan Review view; `openPlan` (proposed/revising)
  // drives the actionable "needs-input" status.
  const plan = useMemo(() => latestPlan(messages), [messages])
  const openPlan = useMemo(() => pendingPlan(messages), [messages])
  // Busy through the diff refresh too, so the composer keeps queueing across the
  // brief gap between a turn ending and the next queued turn starting.
  const busy = state.matches("running") || state.matches("refreshingDiff")
  const status: SessionStatus | null =
    paused || question || openPlan ? "needs-input" : busy ? "thinking" : null

  return {
    messages,
    mode,
    skills,
    files,
    model,
    models,
    patch,
    busy,
    paused,
    queued,
    subagents,
    unqueue: (index) => send({ type: "UNQUEUE", index }),
    sendNow: (index) => send({ type: "SEND_NOW", index }),
    question,
    plan,
    commentPlanStep: (planId, stepId, body) => send({ type: "COMMENT_PLAN_STEP", planId, stepId, body }),
    revisePlan: (planId) => send({ type: "REVISE_PLAN", planId }),
    approvePlan: (planId) => send({ type: "APPROVE_PLAN", planId }),
    resumePlan: (planId) => send({ type: "RESUME_PLAN", planId }),
    status,
    sendPrompt: (text, images) => send({ type: "SEND", text, images }),
    decideGate: (gateId, decision) => send({ type: "DECIDE_GATE", gateId, decision }),
    answerQuestion: (requestId, answers) => send({ type: "ANSWER_QUESTION", requestId, answers }),
    setMode: (m) => send({ type: "SET_MODE", mode: m }),
    setModel: (m) => send({ type: "SET_MODEL", model: m }),
    stop: () => send({ type: "STOP" }),
    refreshDiff: () => send({ type: "REFRESH_DIFF" })
  }
}
