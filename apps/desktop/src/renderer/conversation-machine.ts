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
import type { GateDecision, Message, PermissionMode, Session, Skill, StreamEvent } from "@starbase/core"
import { applyStreamEvent, assistantMessage, setGateStatus, userMessage } from "@starbase/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"

export interface ConversationContext {
  readonly session: Session
  readonly messages: ReadonlyArray<Message>
  readonly mode: PermissionMode
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  /** The worktree's current unified diff, for the Changes rail. */
  readonly patch: string
  readonly pendingText: string
}

type ConversationEvent =
  | { type: "SEND"; text: string }
  | { type: "STREAM_EVENT"; event: StreamEvent }
  | { type: "DECIDE_GATE"; gateId: string; decision: GateDecision }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "STOP" }

interface LoadedData {
  readonly transcript: ReadonlyArray<Message>
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  readonly patch: string
}

/** Load the persisted transcript, the harness skills, the worktree files + diff. */
const loadConversation = fromPromise<LoadedData, { session: Session }>(async ({ input }) => {
  const [transcript, skills, files, patch] = await Promise.all([
    rpc.sessionsTranscript(input.session.id),
    rpc.skillsList(input.session.id),
    input.session.worktreePath
      ? rpc.workspaceFiles(input.session.worktreePath)
      : Promise.resolve([] as ReadonlyArray<string>),
    rpc.sessionsDiff(input.session.id)
  ])
  return { transcript, skills, files, patch }
})

/** Re-read the worktree diff after a turn completes (edits may have landed). */
const refreshDiff = fromPromise<string, { session: Session }>(({ input }) =>
  rpc.sessionsDiff(input.session.id)
)

/** Subscribe to the agent's event stream, forwarding each event into the machine. */
const agentStream = fromCallback<ConversationEvent, { sessionId: string; text: string }>(
  ({ sendBack, input }) => {
    const cancel = rpc.agentRun(input.sessionId, input.text, (event) => {
      sendBack({ type: "STREAM_EVENT", event })
    })
    return cancel
  }
)

const patchLast = (
  messages: ReadonlyArray<Message>,
  fn: (last: Message) => Message
): ReadonlyArray<Message> =>
  messages.length === 0 ? messages : [...messages.slice(0, -1), fn(messages[messages.length - 1]!)]

const gateStatusFor = (decision: GateDecision) =>
  decision === "deny" ? "rejected" : decision === "always" ? "always" : "approved"

const stamp = () => Date.now().toString(36)

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as { session: Session }
  },
  actors: { loadConversation, agentStream, refreshDiff },
  guards: {
    isTerminal: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      (event.event._tag === "Done" || event.event._tag === "Failed")
  },
  actions: {
    appendTurns: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const now = new Date().toISOString()
      const id = stamp()
      return {
        pendingText: event.text,
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, event.text, now),
          assistantMessage(`a_local_${id}`, now)
        ]
      }
    }),
    foldEvent: assign(({ context, event }) => {
      if (event.type !== "STREAM_EVENT") return {}
      return { messages: patchLast(context.messages, (last) => applyStreamEvent(last, event.event)) }
    }),
    optimisticGate: assign(({ context, event }) => {
      if (event.type !== "DECIDE_GATE") return {}
      void rpc.agentDecideGate(context.session.id, event.gateId, event.decision)
      const status = gateStatusFor(event.decision)
      return { messages: context.messages.map((m) => setGateStatus(m, event.gateId, status)) }
    }),
    persistMode: assign(({ context, event }) => {
      if (event.type !== "SET_MODE") return {}
      void rpc.agentSetMode(context.session.id, event.mode)
      return { mode: event.mode }
    }),
    callStop: ({ context }) => {
      void rpc.agentStop(context.session.id)
    }
  }
}).createMachine({
  id: "conversation",
  initial: "loading",
  context: ({ input }) => ({
    session: input.session,
    messages: [],
    mode: input.session.mode ?? "accept-edits",
    skills: [],
    files: [],
    patch: "",
    pendingText: ""
  }),
  states: {
    loading: {
      invoke: {
        src: "loadConversation",
        input: ({ context }) => ({ session: context.session }),
        onDone: {
          target: "awaitingInput",
          actions: assign(({ event }) => ({
            messages: event.output.transcript,
            skills: event.output.skills,
            files: event.output.files,
            patch: event.output.patch
          }))
        },
        onError: { target: "awaitingInput" }
      }
    },
    awaitingInput: {
      on: {
        SEND: { target: "running", actions: "appendTurns" },
        SET_MODE: { actions: "persistMode" }
      }
    },
    running: {
      invoke: {
        src: "agentStream",
        input: ({ context }) => ({ sessionId: context.session.id, text: context.pendingText })
      },
      on: {
        STREAM_EVENT: [
          { guard: "isTerminal", target: "refreshingDiff", actions: "foldEvent" },
          { actions: "foldEvent" }
        ],
        DECIDE_GATE: { actions: "optimisticGate" },
        SET_MODE: { actions: "persistMode" },
        STOP: { target: "refreshingDiff", actions: "callStop" }
      }
    },
    // After a turn ends, re-read the worktree diff so the Changes rail reflects
    // whatever the agent actually edited.
    refreshingDiff: {
      invoke: {
        src: "refreshDiff",
        input: ({ context }) => ({ session: context.session }),
        onDone: { target: "awaitingInput", actions: assign(({ event }) => ({ patch: event.output })) },
        onError: { target: "awaitingInput" }
      },
      on: {
        SET_MODE: { actions: "persistMode" }
      }
    }
  }
})
