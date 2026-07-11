import { useEffect, useState } from "react"
import type { CliInfo, Session } from "@starbase/core"
import { StarbaseApp } from "@starbase/ui"
import { rpc } from "./rpc-client.js"

interface Data {
  readonly clis: ReadonlyArray<CliInfo>
  readonly sessions: ReadonlyArray<Session>
}

type State =
  | { readonly _tag: "loading" }
  | { readonly _tag: "error"; readonly message: string }
  | { readonly _tag: "ready"; readonly data: Data }

/** Fetch the initial payload (discovered CLIs + sessions) over Effect RPC. */
function useStarbaseData(): State {
  const [state, setState] = useState<State>({ _tag: "loading" })

  useEffect(() => {
    let cancelled = false
    Promise.all([rpc.discoveryList(), rpc.sessionsList()])
      .then(([clis, sessions]) => {
        if (!cancelled) setState({ _tag: "ready", data: { clis, sessions } })
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            _tag: "error",
            message: error instanceof Error ? error.message : String(error)
          })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

export function App() {
  const state = useStarbaseData()

  if (state._tag === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas font-mono text-[13px] text-muted-foreground">
        Discovering harnesses…
      </div>
    )
  }

  if (state._tag === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-8">
        <div className="max-w-md rounded-lg border border-red/50 bg-sunken px-4 py-3 font-mono text-[13px] text-red">
          Failed to load: {state.message}
        </div>
      </div>
    )
  }

  return <StarbaseApp clis={state.data.clis} sessions={state.data.sessions} />
}
