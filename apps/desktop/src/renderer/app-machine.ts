/**
 * The renderer's top-level state machine. Modelling the first-run/loading/ready
 * flow as an XState chart keeps every async transition (initial load, folder
 * pick + scan, session load) inside declarative `fromPromise` actors — no
 * data-fetching `useEffect`s, minimal `useState`.
 */
import type { CliInfo, Repo, Session } from "@starbase/core"
import { assign, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"

export interface AppContext {
  readonly clis: ReadonlyArray<CliInfo>
  readonly reposDir: string | null
  readonly repos: ReadonlyArray<Repo>
  readonly sessions: ReadonlyArray<Session>
  readonly error: string | null
}

interface InitialData {
  readonly configured: boolean
  readonly clis: ReadonlyArray<CliInfo>
  readonly repos: ReadonlyArray<Repo>
  readonly sessions: ReadonlyArray<Session>
}

/**
 * Initial load: config + discovered CLIs decide setup vs. app. `gh` status is a
 * react-query in the view (App.tsx), not part of the load gate.
 */
const initialLoad = fromPromise<InitialData>(async () => {
  const [config, clis] = await Promise.all([rpc.configGet(), rpc.discoveryList()])
  if (config?.reposDir) {
    const [repos, sessions] = await Promise.all([rpc.workspaceRepos(), rpc.sessionsList()])
    return { configured: true, clis, repos, sessions }
  }
  return { configured: false, clis, repos: [], sessions: [] }
})

/** Open the native picker, persist, and scan; null when the user cancels. */
const chooseDir = fromPromise<{ reposDir: string; repos: ReadonlyArray<Repo> } | null>(
  async () => {
    const config = await rpc.chooseReposDir()
    if (!config?.reposDir) return null
    const repos = await rpc.workspaceRepos()
    return { reposDir: config.reposDir, repos }
  }
)

/** Load the persisted session list before entering the app. */
const loadSessions = fromPromise<ReadonlyArray<Session>>(async () => rpc.sessionsList())

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as
      | { type: "CHOOSE" }
      | { type: "CONTINUE" }
      | { type: "SESSION_CREATED"; session: Session }
      | { type: "SESSION_PR_LINKED"; sessionId: string; prNumber: number }
      | { type: "SESSION_UPDATED"; session: Session }
      | { type: "SESSION_DELETED"; sessionId: string }
      | { type: "RETRY" }
  },
  actors: { initialLoad, chooseDir, loadSessions }
}).createMachine({
  id: "app",
  initial: "loading",
  context: {
    clis: [],
    reposDir: null,
    repos: [],
    sessions: [],
    error: null
  },
  states: {
    loading: {
      invoke: {
        src: "initialLoad",
        onDone: [
          {
            guard: ({ event }) => event.output.configured,
            target: "ready",
            actions: assign(({ event }) => ({
              clis: event.output.clis,
              repos: event.output.repos,
              sessions: event.output.sessions
            }))
          },
          {
            target: "setup",
            actions: assign(({ event }) => ({
              clis: event.output.clis
            }))
          }
        ],
        onError: {
          target: "failure",
          actions: assign(({ event }) => ({ error: messageOf(event.error) }))
        }
      }
    },
    setup: {
      initial: "idle",
      states: {
        idle: {
          on: {
            CHOOSE: "choosing",
            CONTINUE: {
              target: "#app.starting",
              guard: ({ context }) => context.reposDir !== null
            }
          }
        },
        choosing: {
          invoke: {
            src: "chooseDir",
            onDone: {
              target: "idle",
              actions: assign(({ event }) =>
                event.output
                  ? { reposDir: event.output.reposDir, repos: event.output.repos }
                  : {}
              )
            },
            onError: {
              target: "#app.failure",
              actions: assign(({ event }) => ({ error: messageOf(event.error) }))
            }
          }
        }
      }
    },
    starting: {
      invoke: {
        src: "loadSessions",
        onDone: {
          target: "ready",
          actions: assign(({ event }) => ({ sessions: event.output }))
        },
        onError: {
          target: "failure",
          actions: assign(({ event }) => ({ error: messageOf(event.error) }))
        }
      }
    },
    ready: {
      on: {
        SESSION_CREATED: {
          actions: assign(({ context, event }) => ({
            sessions: [event.session, ...context.sessions]
          }))
        },
        // A PR was created/detected for a session — reflect its number so the
        // sidebar badge and the Pull Request / Code Review tabs light up.
        SESSION_PR_LINKED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, prNumber: event.prNumber } : s
            )
          }))
        },
        // Replace a session with its updated record (archive / restore).
        SESSION_UPDATED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          }))
        },
        // Drop a permanently-deleted session from the list.
        SESSION_DELETED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.filter((s) => s.id !== event.sessionId)
          }))
        }
      }
    },
    failure: {
      on: { RETRY: "loading" }
    }
  }
})
