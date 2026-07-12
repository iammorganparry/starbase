/**
 * Thin view over `conversationMachine` — the deterministic conversation flow
 * lives in the chart (loading / awaitingInput / running), so this hook only maps
 * the current snapshot to props and events to sends. Mount it keyed by session id
 * (`<ConversationPane key={session.id} …/>`) so each session gets a fresh chart
 * with no session-sync `useEffect`. Keeps `@starbase/ui` purely presentational.
 */
import { useMemo } from "react"
import { useMachine } from "@xstate/react"
import type {
  GateDecision,
  Message,
  ModelOption,
  PermissionMode,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Skill
} from "@starbase/core"
import { latestPlan, pendingPlan, pendingQuestion } from "@starbase/core"
import { conversationMachine } from "./conversation-machine.js"

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
  /** A pending AskUserQuestion group (the composer is replaced while set), or null. */
  readonly question: QuestionRequest | null
  readonly answerQuestion: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** The latest open plan (proposed / revising), for the Plan Review tab, or null. */
  readonly plan: Plan | null
  readonly commentPlanStep: (planId: string, stepId: string, body: string) => void
  readonly revisePlan: (planId: string) => void
  readonly approvePlan: (planId: string) => void
  /** Live status for the sidebar/tab bar, or null when idle (use persisted). */
  readonly status: SessionStatus | null
  readonly sendPrompt: (text: string) => void
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setModel: (model: string) => void
  readonly stop: () => void
  /** Re-read the worktree diff (e.g. after reverting from the Changes rail). */
  readonly refreshDiff: () => void
}

export function useConversation(session: Session): Conversation {
  const [state, send] = useMachine(conversationMachine, { input: { session } })
  const { messages, mode, skills, files, model, models, patch } = state.context

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
  const busy = state.matches("running")
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
    question,
    plan,
    commentPlanStep: (planId, stepId, body) => send({ type: "COMMENT_PLAN_STEP", planId, stepId, body }),
    revisePlan: (planId) => send({ type: "REVISE_PLAN", planId }),
    approvePlan: (planId) => send({ type: "APPROVE_PLAN", planId }),
    status,
    sendPrompt: (text) => send({ type: "SEND", text }),
    decideGate: (gateId, decision) => send({ type: "DECIDE_GATE", gateId, decision }),
    answerQuestion: (requestId, answers) => send({ type: "ANSWER_QUESTION", requestId, answers }),
    setMode: (m) => send({ type: "SET_MODE", mode: m }),
    setModel: (m) => send({ type: "SET_MODEL", model: m }),
    stop: () => send({ type: "STOP" }),
    refreshDiff: () => send({ type: "REFRESH_DIFF" })
  }
}
