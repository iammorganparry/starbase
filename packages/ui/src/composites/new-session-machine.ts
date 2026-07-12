import type {
  CliInfo,
  CliKind,
  CreateSessionFromPrInput,
  CreateSessionInput,
  PrSummary,
  Repo
} from "@starbase/core"
import { assign, fromPromise, raise, setup } from "xstate"

/** Which flavour of session the dialog is composing. */
export type NewSessionMode = "blank" | "pr"

/** How long typing in the PR search box settles before a fetch fires. */
const SEARCH_DEBOUNCE_MS = 250

/**
 * The live dependencies the machine reaches through — repos/clis to seed
 * defaults, the async loaders, and the create callbacks. Held behind a getter
 * (`NewSessionInput.getDeps`) so the machine always sees the component's latest
 * props without being torn down and rebuilt on every render.
 */
export interface NewSessionDeps {
  repos: ReadonlyArray<Repo>
  availableClis: ReadonlyArray<CliInfo>
  loadBranches: (repoPath: string) => Promise<ReadonlyArray<string>>
  loadPrs?: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ) => Promise<ReadonlyArray<PrSummary>>
  onCreate: (input: CreateSessionInput) => Promise<void>
  onCreateFromPr?: (input: CreateSessionFromPrInput) => Promise<void>
  onClose: () => void
}

export interface NewSessionInput {
  getDeps: () => NewSessionDeps
}

export interface NewSessionContext {
  getDeps: () => NewSessionDeps
  mode: NewSessionMode
  repoPath: string
  title: string
  cli: CliKind | ""
  base: string
  branches: ReadonlyArray<string>
  search: string
  mine: boolean
  prs: ReadonlyArray<PrSummary>
  selectedPr: PrSummary | null
  error: string | null
}

export type NewSessionEvent =
  | { type: "OPEN" }
  | { type: "SET_MODE"; mode: NewSessionMode }
  | { type: "SET_REPO"; repoPath: string }
  | { type: "SET_TITLE"; title: string }
  | { type: "SET_CLI"; cli: CliKind }
  | { type: "SET_BASE"; base: string }
  | { type: "SET_SEARCH"; search: string }
  | { type: "SET_MINE"; mine: boolean }
  | { type: "SELECT_PR"; pr: PrSummary }
  | { type: "SUBMIT" }
  | { type: "LOAD_BRANCHES" }
  | { type: "RELOAD_PRS" }

const repoFor = (ctx: NewSessionContext): Repo | undefined =>
  ctx.getDeps().repos.find((r) => r.path === ctx.repoPath)

/** Preferred default base branch for a repo (current → default → first → none). */
const defaultBase = (repo: Repo | undefined, branches: ReadonlyArray<string>): string =>
  repo?.currentBranch ?? repo?.defaultBranch ?? branches[0] ?? ""

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

/**
 * The New Session dialog's form state, modelled as a machine. Three concurrent
 * regions: `submission` (edit → submit → done), `branchLoad`, and `prLoad`
 * (which debounces via an `after` delay). Field edits assign into context and
 * `raise` the relevant reload; guards keep PR loading inert outside "From PR"
 * mode. The component stays a thin projection of `context` + `state.matches`.
 */
export const newSessionMachine = setup({
  types: {
    context: {} as NewSessionContext,
    events: {} as NewSessionEvent,
    input: {} as NewSessionInput
  },
  delays: { search: SEARCH_DEBOUNCE_MS },
  guards: {
    inPrMode: ({ context }) => context.mode === "pr",
    canSubmit: ({ context }) =>
      context.repoPath !== "" &&
      context.cli !== "" &&
      (context.mode === "pr"
        ? context.selectedPr !== null
        : context.title.trim() !== "" && context.base !== "")
  },
  actors: {
    loadBranches: fromPromise(
      ({ input }: { input: { fn: NewSessionDeps["loadBranches"]; repoPath: string } }) =>
        input.repoPath ? input.fn(input.repoPath) : Promise.resolve([])
    ),
    loadPrs: fromPromise(
      ({
        input
      }: {
        input: { fn: NewSessionDeps["loadPrs"]; repoPath: string; mine: boolean; search: string }
      }) =>
        input.fn && input.repoPath
          ? input.fn(input.repoPath, { mine: input.mine, search: input.search })
          : Promise.resolve([])
    ),
    submit: fromPromise(({ input }: { input: { run: () => Promise<void> } }) => input.run())
  },
  actions: {
    /** Reset the form to first-open defaults, seeded from live deps. */
    seed: assign(({ context }) => {
      const deps = context.getDeps()
      const first = deps.repos[0]
      return {
        mode: "blank" as NewSessionMode,
        repoPath: first?.path ?? "",
        title: "",
        cli: deps.availableClis[0]?.kind ?? ("" as CliKind | ""),
        base: "",
        branches: [] as ReadonlyArray<string>,
        search: "",
        mine: false,
        prs: [] as ReadonlyArray<PrSummary>,
        selectedPr: null,
        error: null
      }
    }),
    applyBranches: assign(({ context, event }) => {
      const branches = (event as unknown as { output: ReadonlyArray<string> }).output
      return { branches, base: defaultBase(repoFor(context), branches) }
    }),
    clearBranches: assign({ branches: [], base: "" }),
    applyPrs: assign({
      prs: ({ event }) => (event as unknown as { output: ReadonlyArray<PrSummary> }).output
    }),
    clearPrs: assign({ prs: [] }),
    setError: assign({
      error: ({ event }) =>
        errorText((event as unknown as { error: unknown }).error, "Failed to create session.")
    })
  }
}).createMachine({
  id: "newSession",
  context: ({ input }) => ({
    getDeps: input.getDeps,
    mode: "blank",
    repoPath: "",
    title: "",
    cli: "",
    base: "",
    branches: [],
    search: "",
    mine: false,
    prs: [],
    selectedPr: null,
    error: null
  }),
  type: "parallel",
  states: {
    submission: {
      initial: "editing",
      states: {
        editing: {
          on: { SUBMIT: { target: "submitting", guard: "canSubmit", actions: assign({ error: null }) } }
        },
        submitting: {
          invoke: {
            src: "submit",
            input: ({ context }) => ({
              run: () => {
                const deps = context.getDeps()
                const repo = repoFor(context)
                if (!repo) return Promise.reject(new Error("No repository selected."))
                if (context.mode === "pr") {
                  if (!context.selectedPr || !deps.onCreateFromPr || context.cli === "") {
                    return Promise.reject(new Error("Select a pull request and harness."))
                  }
                  return deps.onCreateFromPr({
                    repoPath: repo.path,
                    repoName: repo.name,
                    cli: context.cli,
                    pr: {
                      number: context.selectedPr.number,
                      title: context.selectedPr.title,
                      headRefName: context.selectedPr.headRefName,
                      baseRefName: context.selectedPr.baseRefName
                    }
                  })
                }
                if (context.cli === "") return Promise.reject(new Error("Select a harness."))
                return deps.onCreate({
                  repoPath: repo.path,
                  repoName: repo.name,
                  title: context.title.trim(),
                  cli: context.cli,
                  baseBranch: context.base
                })
              }
            }),
            onDone: { target: "done" },
            onError: { target: "editing", actions: "setError" }
          }
        },
        done: { entry: ({ context }) => context.getDeps().onClose() }
      }
    },
    branchLoad: {
      initial: "idle",
      on: { LOAD_BRANCHES: ".loading" },
      states: {
        idle: {},
        loading: {
          invoke: {
            src: "loadBranches",
            input: ({ context }) => ({ fn: context.getDeps().loadBranches, repoPath: context.repoPath }),
            onDone: { target: "idle", actions: "applyBranches" },
            onError: { target: "idle", actions: "clearBranches" }
          }
        }
      }
    },
    prLoad: {
      initial: "idle",
      on: { RELOAD_PRS: { target: ".debouncing", guard: "inPrMode" } },
      states: {
        idle: {},
        // Debounce typing: a fresh RELOAD_PRS re-enters and restarts the timer.
        debouncing: { after: { search: "loading" } },
        loading: {
          invoke: {
            src: "loadPrs",
            input: ({ context }) => ({
              fn: context.getDeps().loadPrs,
              repoPath: context.repoPath,
              mine: context.mine,
              search: context.search
            }),
            onDone: { target: "idle", actions: "applyPrs" },
            onError: { target: "idle", actions: "clearPrs" }
          }
        }
      }
    }
  },
  on: {
    OPEN: {
      target: ".submission.editing",
      actions: ["seed", raise({ type: "LOAD_BRANCHES" })]
    },
    SET_MODE: {
      actions: [assign({ mode: ({ event }) => event.mode, error: null }), raise({ type: "RELOAD_PRS" })]
    },
    SET_REPO: {
      actions: [
        assign({ repoPath: ({ event }) => event.repoPath, base: "", selectedPr: null }),
        raise({ type: "LOAD_BRANCHES" }),
        raise({ type: "RELOAD_PRS" })
      ]
    },
    SET_TITLE: { actions: assign({ title: ({ event }) => event.title }) },
    SET_CLI: { actions: assign({ cli: ({ event }) => event.cli }) },
    SET_BASE: { actions: assign({ base: ({ event }) => event.base }) },
    SET_SEARCH: {
      actions: [assign({ search: ({ event }) => event.search }), raise({ type: "RELOAD_PRS" })]
    },
    SET_MINE: {
      actions: [assign({ mine: ({ event }) => event.mine }), raise({ type: "RELOAD_PRS" })]
    },
    SELECT_PR: { actions: assign({ selectedPr: ({ event }) => event.pr }) }
  }
})
