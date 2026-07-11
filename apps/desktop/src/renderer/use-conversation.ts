/**
 * Thin view over `conversationMachine` — the deterministic conversation flow
 * lives in the chart (loading / awaitingInput / running), so this hook only maps
 * the current snapshot to props and events to sends. Mount it keyed by session id
 * (`<ConversationPane key={session.id} …/>`) so each session gets a fresh chart
 * with no session-sync `useEffect`. Keeps `@starbase/ui` purely presentational.
 */
import { useMemo } from "react"
import { useMachine } from "@xstate/react"
import type { GateDecision, Message, ModelOption, PermissionMode, Session, Skill } from "@starbase/core"
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
  readonly sendPrompt: (text: string) => void
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setModel: (model: string) => void
  readonly stop: () => void
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

  return {
    messages,
    mode,
    skills,
    files,
    model,
    models,
    patch,
    busy: state.matches("running"),
    paused,
    sendPrompt: (text) => send({ type: "SEND", text }),
    decideGate: (gateId, decision) => send({ type: "DECIDE_GATE", gateId, decision }),
    setMode: (m) => send({ type: "SET_MODE", mode: m }),
    setModel: (m) => send({ type: "SET_MODEL", model: m }),
    stop: () => send({ type: "STOP" })
  }
}
