import { useEffect, useRef } from "react"
import { useMachine } from "@xstate/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { CreateSessionInput, GhStatus, GithubConfig, Session } from "@starbase/core"
import { LoadingScreen, SetupScreen, StarbaseApp } from "@starbase/ui"
import { appMachine } from "./app-machine.js"
import { ConversationPane } from "./conversation-pane.js"
import { PullRequestPane } from "./pull-request-pane.js"
import { ReviewPane } from "./review-pane.js"
import { useSessionStatuses } from "./session-status.js"
import { rpc } from "./rpc-client.js"

const GH_UNKNOWN: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

/**
 * Thin view over `appMachine` (which drives the first-run/loading/session flow).
 * Everything else the shell needs is read through react-query — `gh` status,
 * the persisted config (GitHub prefs), and usage — so there are no ad-hoc
 * `useEffect` + `useState` fetches here; a mutation just updates the cache.
 */
export function App() {
  const [state, send] = useMachine(appMachine)
  const { clis, repos, reposDir, sessions } = state.context
  const liveStatus = useSessionStatuses()
  const qc = useQueryClient()

  // Renderer-side rpc reads, via react-query.
  const configQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const ghStatusQuery = useQuery({ queryKey: ["gh-status"], queryFn: () => rpc.ghStatus() })
  const usageQuery = useQuery({ queryKey: ["usage"], queryFn: () => rpc.usageGet(), enabled: false })

  const githubConfig = configQuery.data?.github ?? null
  const ghStatus = ghStatusQuery.data ?? GH_UNKNOWN
  const usage = usageQuery.data ?? null

  // The usage modal loads on open; the settings modal rechecks gh on demand.
  const loadUsage = () => usageQuery.refetch().then(() => undefined)
  const recheckGh = () => ghStatusQuery.refetch().then(() => undefined)
  const saveGithubConfig = (config: GithubConfig) =>
    rpc.configSetGithub(config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })

  const createSession = async (input: CreateSessionInput) => {
    const session = await rpc.sessionsCreate(input)
    send({ type: "SESSION_CREATED", session })
    return session
  }
  const onPrLinked = (sessionId: string, prNumber: number) =>
    send({ type: "SESSION_PR_LINKED", sessionId, prNumber })

  const connected = ghStatus.available && ghStatus.authenticated
  const autoDetect = connected && (githubConfig?.autoDetectPr ?? true)

  // Opportunistically link PRs already open on a session's branch, so the sidebar
  // badge + PR/Code Review tabs light up without opening the PR tab first. Runs
  // once per session id (guarded), best-effort, only when GitHub auto-detect is on.
  const detectedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!autoDetect) return
    for (const s of sessions) {
      if (s.prNumber != null || !s.worktreePath || detectedRef.current.has(s.id)) continue
      detectedRef.current.add(s.id)
      void rpc.githubDetectPr(s.id).then((n) => {
        if (n != null) send({ type: "SESSION_PR_LINKED", sessionId: s.id, prNumber: n })
      })
    }
  }, [autoDetect, sessions, send])

  if (state.matches("loading") || state.matches("starting")) {
    return <LoadingScreen />
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
        onRecheckGh={recheckGh}
      />
    )
  }

  return (
    <StarbaseApp
      clis={clis}
      sessions={sessions}
      repos={repos}
      ghStatus={ghStatus}
      liveStatus={liveStatus}
      usage={usage}
      onLoadUsage={loadUsage}
      githubConfig={githubConfig}
      onSaveGithubConfig={saveGithubConfig}
      onRecheckGh={recheckGh}
      loadBranches={rpc.workspaceBranches}
      onCreateSession={createSession}
      renderConversation={(session: Session) => <ConversationPane session={session} />}
      renderPullRequest={(session, ctx) => (
        <PullRequestPane
          session={session}
          connected={connected}
          autoDetect={autoDetect}
          onConnectGithub={ctx.onConnectGithub}
          onPrLinked={onPrLinked}
        />
      )}
      renderReview={(session, ctx) => (
        <ReviewPane session={session} connected={connected} onConnectGithub={ctx.onConnectGithub} />
      )}
      version={__APP_VERSION__}
    />
  )
}
