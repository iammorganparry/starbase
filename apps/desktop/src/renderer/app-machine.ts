/**
 * The renderer's top-level state machine. Modelling the first-run/loading/ready
 * flow as an XState chart keeps every async transition (initial load, folder
 * pick + scan, session load) inside declarative `fromPromise` actors — no
 * data-fetching `useEffect`s, minimal `useState`.
 */
import type { CliInfo, GhStatus, Repo, Session } from "@starbase/core"
import { assign, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"

const GH_UNKNOWN: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

export interface AppContext {
  readonly clis: ReadonlyArray<CliInfo>
  readonly ghStatus: GhStatus
  readonly reposDir: string | null
  readonly repos: ReadonlyArray<Repo>
  readonly sessions: ReadonlyArray<Session>
  readonly error: string | null
}

interface InitialData {
  readonly configured: boolean
  readonly clis: ReadonlyArray<CliInfo>
  readonly ghStatus: GhStatus
  readonly repos: ReadonlyArray<Repo>
  readonly sessions: ReadonlyArray<Session>
}

/** Initial load: config + discovered CLIs + gh status decide setup vs. app. */
const initialLoad = fromPromise<InitialData>(async () => {
  const [config, clis, ghStatus] = await Promise.all([
    rpc.configGet(),
    rpc.discoveryList(),
    rpc.ghStatus()
  ])
  if (config?.reposDir) {
    const [repos, sessions] = await Promise.all([rpc.workspaceRepos(), rpc.sessionsList()])
    return { configured: true, clis, ghStatus, repos, sessions }
  }
  return { configured: false, clis, ghStatus, repos: [], sessions: [] }
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
      | { type: "RETRY" }
  },
  actors: { initialLoad, chooseDir, loadSessions }
}).createMachine({
  id: "app",
  initial: "loading",
  context: {
    clis: [],
    ghStatus: GH_UNKNOWN,
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
              ghStatus: event.output.ghStatus,
              repos: event.output.repos,
              sessions: event.output.sessions
            }))
          },
          {
            target: "setup",
            actions: assign(({ event }) => ({
              clis: event.output.clis,
              ghStatus: event.output.ghStatus
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
        }
      }
    },
    failure: {
      on: { RETRY: "loading" }
    }
  }
})
