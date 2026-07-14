import { useEffect, useMemo, useRef, useState } from "react"
import { useMachine } from "@xstate/react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  CliKind,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GhStatus,
  GitConfig,
  GithubConfig,
  ProviderConfig,
  Session,
  SessionStatus
} from "@starbase/core"
import { ConfirmDialog, LoadingScreen, SetupScreen, StarbaseApp } from "@starbase/ui"
import { appMachine } from "./app-machine.js"
import { ConversationPane } from "./conversation-pane.js"
import { PullRequestPane } from "./pull-request-pane.js"
import { ReviewPane } from "./review-pane.js"
import { TerminalDockView } from "./terminal-dock-view.js"
import { useTerminalDock } from "./use-terminal-dock.js"
import { useSessionStatuses } from "./session-status.js"
import { usePlanSessions } from "./plan-presence.js"
import { disposeConversationActor } from "./conversation-registry.js"
import { completedSessionIds } from "./pr-refresh.js"
import { newlyPlannedSessionIds } from "./retitle-triggers.js"
import { rpc } from "./rpc-client.js"

const GH_UNKNOWN: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

/** How often the archive sweep re-checks each linked PR's merged/closed state. */
const ARCHIVE_POLL_MS = 60_000

/** How long a fetched PR state stays fresh before the sweep will re-fetch it. */
const PR_STATE_STALE_MS = 5 * 60_000

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
  const planSessions = usePlanSessions()
  const termDock = useTerminalDock()
  const qc = useQueryClient()

  // Renderer-side rpc reads, via react-query.
  const configQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const ghStatusQuery = useQuery({ queryKey: ["gh-status"], queryFn: () => rpc.ghStatus() })
  const usageQuery = useQuery({ queryKey: ["usage"], queryFn: () => rpc.usageGet(), enabled: false })

  const githubConfig = configQuery.data?.github ?? null
  const gitConfig = configQuery.data?.git ?? null
  const providersConfig = configQuery.data?.providers ?? null
  const starredRepos = configQuery.data?.starredRepos ?? []
  const lastRepoPath = configQuery.data?.lastRepoPath ?? null
  const ghStatus = ghStatusQuery.data ?? GH_UNKNOWN
  const usage = usageQuery.data ?? null

  // The usage modal loads on open; the settings modal rechecks gh on demand.
  const loadUsage = () => usageQuery.refetch().then(() => undefined)
  const recheckGh = () => ghStatusQuery.refetch().then(() => undefined)
  const saveGithubConfig = (config: GithubConfig) =>
    rpc.configSetGithub(config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const saveGitConfig = (config: GitConfig) =>
    rpc.configSetGit(config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const saveProvider = (cli: CliKind, config: ProviderConfig) =>
    rpc.configSetProvider(cli, config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })

  // Toggle a repo's starred state, persist the whole list, and update the cache.
  const toggleStar = (repoPath: string) => {
    const next = starredRepos.includes(repoPath)
      ? starredRepos.filter((p) => p !== repoPath)
      : [...starredRepos, repoPath]
    return rpc.configSetStarredRepos(next).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  }
  // Remember the repo a session was created from so the dialog can preselect it.
  const rememberLastRepo = (repoPath: string) =>
    rpc.configSetLastRepoPath(repoPath).then((saved) => {
      qc.setQueryData(["config"], saved)
    })

  const createSession = async (input: CreateSessionInput) => {
    const session = await rpc.sessionsCreate(input)
    void rememberLastRepo(input.repoPath)
    send({ type: "SESSION_CREATED", session })
    return session
  }
  const createSessionFromPr = async (input: CreateSessionFromPrInput) => {
    const session = await rpc.sessionsCreateFromPr(input)
    void rememberLastRepo(input.repoPath)
    send({ type: "SESSION_CREATED", session })
    return session
  }
  const onPrLinked = (sessionId: string, prNumber: number) =>
    send({ type: "SESSION_PR_LINKED", sessionId, prNumber })

  const restoreSession = async (sessionId: string) => {
    const session = await rpc.sessionsRestore(sessionId)
    send({ type: "SESSION_UPDATED", session })
  }
  // Manual archive from the sidebar quick-actions. The store only models a
  // merged/closed reason, so a hand-archived session records "closed".
  const archiveSession = async (sessionId: string) => {
    const session = await rpc.sessionsArchive(sessionId, "closed")
    send({ type: "SESSION_UPDATED", session })
  }
  // Delete is destructive (removes the worktree) — confirm first. Holds the
  // session pending confirmation; the ConfirmDialog fires `deleteSession`.
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)
  const renameSession = (sessionId: string, title: string) => {
    void rpc.sessionsRename(sessionId, title).then((session) => send({ type: "SESSION_UPDATED", session }))
  }
  const deleteSession = async (sessionId: string) => {
    await rpc.sessionsDelete(sessionId)
    // Stop the persistent conversation actor for a deleted session (it's kept
    // running across session switches, so it won't be torn down by unmount).
    disposeConversationActor(sessionId)
    send({ type: "SESSION_DELETED", sessionId })
  }

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

  // When a session's live run COMPLETES (its live status goes present → absent),
  // do two independent things:
  //  1. Auto-retitle it (the agent may have started/shifted the work this turn) —
  //     runs regardless of GitHub; the RPC folds to a heuristic if there's no LLM.
  //  2. Re-check GitHub (the agent may have opened AND merged its own PR this run):
  //     the once-per-session detectedRef guard can't catch a mid-run PR, and the
  //     60s poll would lag — so re-detect the link + invalidate the cached pr-state.
  const prevLiveRef = useRef<Record<string, SessionStatus>>({})
  useEffect(() => {
    const prev = prevLiveRef.current
    prevLiveRef.current = liveStatus
    const completed = completedSessionIds(prev, liveStatus, sessions)
    for (const id of completed) {
      // Only auto-named sessions retitle; skip pinned/legacy ones (autoTitle not
      // explicitly true) to avoid a needless RPC. The handler guards too.
      if (sessions.find((s) => s.id === id)?.autoTitle !== true) continue
      // SESSION_UPDATED replaces the whole record; it re-reads the store at the end
      // so it converges with a concurrent SESSION_PR_LINKED regardless of order.
      void rpc
        .sessionsRetitle(id)
        .then((session) => send({ type: "SESSION_UPDATED", session }))
        .catch(() => {})
    }
    if (!autoDetect) return
    for (const id of completed) {
      void rpc.githubDetectPr(id).then((n) => {
        if (n != null) {
          detectedRef.current.add(id) // keep the once-per-session guard in sync
          send({ type: "SESSION_PR_LINKED", sessionId: id, prNumber: n })
        }
      })
      // Partial key (id only) — matches regardless of the linked PR number.
      void qc.invalidateQueries({ queryKey: ["pr-state", id] })
    }
  }, [liveStatus, sessions, autoDetect, send, qc])

  // Retitle a session as soon as it has a PLAN — a run that plans then executes
  // stays "present" (thinking/needs-input) throughout, so the on-completion
  // retitle above wouldn't fire until the whole thing finishes, leaving the
  // sidebar stuck on "Untitled" through a long build. A proposed plan is already
  // strong signal, so we retitle on the absent → present edge of plan presence.
  const prevPlanRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const prev = prevPlanRef.current
    prevPlanRef.current = planSessions
    for (const id of newlyPlannedSessionIds(prev, planSessions, sessions)) {
      void rpc
        .sessionsRetitle(id)
        .then((session) => send({ type: "SESSION_UPDATED", session }))
        .catch(() => {})
    }
  }, [planSessions, sessions, send])

  // Archive sweep: once a linked PR is merged or closed, auto-archive the session
  // so it drops into the sidebar's "Archived" group (read-only, kept). react-query
  // owns the per-session PR-state reads (cached + retried); `combine` distils them
  // to the sessions that need archiving, and a mutation performs the archive.
  const sweepTargets = useMemo(
    () => sessions.filter((s) => s.prNumber != null && Boolean(s.worktreePath) && !s.archived),
    [sessions]
  )
  const toArchive = useQueries({
    queries: sweepTargets.map((s) => ({
      queryKey: ["pr-state", s.id, s.prNumber] as const,
      queryFn: () => rpc.githubPrState(s.id),
      enabled: connected,
      staleTime: PR_STATE_STALE_MS,
      // Poll so a PR merged/closed on GitHub archives its session live instead of
      // only on a cold app relaunch (the query would otherwise never re-fetch).
      refetchInterval: ARCHIVE_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true
    })),
    combine: (results) =>
      sweepTargets.flatMap((s, i) => {
        const state = results[i]?.data
        return state === "merged" || state === "closed" ? [{ id: s.id, reason: state }] : []
      })
  })
  const archiveMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: "merged" | "closed" }) =>
      rpc.sessionsArchive(id, reason),
    onSuccess: (session) => send({ type: "SESSION_UPDATED", session })
  })
  // Fire the archive once per session (the ref guards against re-firing while the
  // SESSION_UPDATED that removes it from `sweepTargets` is still propagating).
  const archivedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const { id, reason } of toArchive) {
      if (archivedRef.current.has(id)) continue
      archivedRef.current.add(id)
      archiveMutation.mutate({ id, reason })
    }
  }, [toArchive, archiveMutation])

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
    <>
    <StarbaseApp
      clis={clis}
      sessions={sessions}
      repos={repos}
      starredRepos={starredRepos}
      onToggleStar={toggleStar}
      defaultRepoPath={lastRepoPath}
      ghStatus={ghStatus}
      liveStatus={liveStatus}
      usage={usage}
      onLoadUsage={loadUsage}
      githubConfig={githubConfig}
      onSaveGithubConfig={saveGithubConfig}
      gitConfig={gitConfig}
      onSaveGitConfig={saveGitConfig}
      providersConfig={providersConfig}
      onSaveProvider={saveProvider}
      loadModels={rpc.modelsList}
      onRecheckGh={recheckGh}
      loadBranches={rpc.workspaceBranches}
      onCreateSession={createSession}
      onRenameSession={renameSession}
      onArchiveSession={archiveSession}
      onRestoreSession={restoreSession}
      onDeleteSession={(id) => setPendingDelete(sessions.find((s) => s.id === id) ?? null)}
      loadPrs={connected ? rpc.githubListPrs : undefined}
      onCreateSessionFromPr={connected ? createSessionFromPr : undefined}
      planSessions={planSessions}
      renderConversation={(session: Session, view, ctx) => (
        <ConversationPane
          session={session}
          view={view}
          onOpenPlanReview={ctx.onOpenPlanReview}
          onRestore={restoreSession}
          onDelete={deleteSession}
        />
      )}
      renderPullRequest={(session, ctx) => (
        <PullRequestPane
          session={session}
          connected={connected}
          autoDetect={autoDetect}
          viewerLogin={ghStatus.login}
          onConnectGithub={ctx.onConnectGithub}
          onPrLinked={onPrLinked}
        />
      )}
      renderReview={(session, ctx) => (
        <ReviewPane session={session} connected={connected} onConnectGithub={ctx.onConnectGithub} />
      )}
      renderCode={(session, ctx) => (
        <ReviewPane session={session} connected={connected} onConnectGithub={ctx.onConnectGithub} />
      )}
      terminalDockSide={termDock.side}
      renderTerminalDock={(session) => (
        <TerminalDockView
          session={session}
          visible={termDock.visible}
          onToggle={termDock.toggle}
          side={termDock.side}
          onSideChange={termDock.setSide}
        />
      )}
      version={__APP_VERSION__}
    />
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => !open && setPendingDelete(null)}
      title="Delete session?"
      description={
        pendingDelete
          ? `“${pendingDelete.title}” and its isolated worktree will be permanently removed. This can't be undone.`
          : undefined
      }
      confirmLabel="Delete"
      tone="danger"
      onConfirm={() => {
        if (pendingDelete) void deleteSession(pendingDelete.id)
      }}
    />
    </>
  )
}
