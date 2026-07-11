import { useMachine } from "@xstate/react"
import type { CreateSessionInput } from "@starbase/core"
import { SetupScreen, StarbaseApp } from "@starbase/ui"
import { appMachine } from "./app-machine.js"
import { rpc } from "./rpc-client.js"

/**
 * Thin view over `appMachine`. All fetching/transitions live in the machine
 * (see app-machine.ts); this component only renders the current state and sends
 * events. Session creation stays a Promise (so the shell can select the new
 * session) but still feeds the machine via `SESSION_CREATED`.
 */
export function App() {
  const [state, send] = useMachine(appMachine)
  const { clis, ghStatus, repos, reposDir, sessions } = state.context

  const createSession = async (input: CreateSessionInput) => {
    const session = await rpc.sessionsCreate(input)
    send({ type: "SESSION_CREATED", session })
    return session
  }

  if (state.matches("loading") || state.matches("starting")) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas font-mono text-[13px] text-muted-foreground">
        Starting Starbase…
      </div>
    )
  }

  if (state.matches("failure")) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-8">
        <div className="max-w-md rounded-lg border border-red/50 bg-sunken px-4 py-3 font-mono text-[13px] text-red">
          Failed to load: {state.context.error}
        </div>
      </div>
    )
  }

  if (state.matches("setup")) {
    return (
      <SetupScreen
        clis={clis}
        ghStatus={ghStatus}
        repos={repos}
        reposDir={reposDir}
        busy={state.matches({ setup: "choosing" })}
        onChooseDir={() => send({ type: "CHOOSE" })}
        onContinue={() => send({ type: "CONTINUE" })}
      />
    )
  }

  return (
    <StarbaseApp
      clis={clis}
      sessions={sessions}
      repos={repos}
      ghStatus={ghStatus}
      loadBranches={rpc.workspaceBranches}
      onCreateSession={createSession}
    />
  )
}
