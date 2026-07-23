import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMachine } from "@xstate/react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  ContextConfig,
  VsCodeTheme,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GhStatus,
  GigaplanRoutingConfig,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  ProviderConfig,
  Session,
  SessionActivity,
  User
} from "@starbase/core"
import { DEFAULT_THEME_ID } from "@starbase/core"
import { ConfirmDialog, LoadingScreen, LoginScreen, SetupScreen, StarbaseApp, ThemeProvider } from "@starbase/ui"
import { appMachine } from "./app-machine.js"
import { authMachine } from "./auth-machine.js"
import { ConversationPane } from "./conversation-pane.js"
import { IssuePane } from "./issue-pane.js"
import { PullRequestPane } from "./pull-request-pane.js"
import { ReviewPane } from "./review-pane.js"
import { TerminalDockView } from "./terminal-dock-view.js"
import { useTerminalDock } from "./use-terminal-dock.js"
import { BrowserPreviewView } from "./browser-preview-view.js"
import { useBrowserPreview } from "./use-browser-preview.js"
import { useSessionActivities } from "./session-activity.js"
import { useSessionDiffs } from "./diff-presence.js"
import { usePlanSessions } from "./plan-presence.js"
import { disposeConversationActor } from "./conversation-registry.js"
import { clearDraft } from "./draft-store.js"
import { onSessionUpdate } from "./session-updates.js"
import { setVisibleSessionIds } from "./active-session.js"
import { prNotification } from "./notifier.js"
import { completedSessionIds } from "./pr-refresh.js"
import { issuesToCloseOnMerge, prsToNotify } from "./pr-sweep.js"
import { routeReviewToAgent } from "./auto-route.js"
import { reviewQueryKey } from "./review-routing.js"
import { newlyPlannedSessionIds } from "./retitle-triggers.js"
import { rpc } from "./rpc-client.js"
import { useTheme } from "./use-theme.js"

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
 *
 * Only mounted once signed in (see the `App` auth gate below), so none of its
 * queries/effects run behind the sign-in wall. Receives the signed-in `user` and
 * `onSignOut` to drive the sidebar account menu.
 */
function AuthedApp({ user, onSignOut }: { user?: User; onSignOut?: () => void }) {
  const [state, send] = useMachine(appMachine)
  const { clis, repos, reposDir, sessions } = state.context

  // The conversation machine persists a session's settled status by itself, with
  // no route back here. Fold those records into the list, or the sidebar keeps
  // rendering the pre-write status (its fallback when a session has no live
  // activity) until the next restart.
  useEffect(() => onSessionUpdate((session) => send({ type: "SESSION_UPDATED", session })), [send])

  // Clicking an OS notification focuses the window (main does that) and lands on
  // the session it was about. The nonce makes a repeat click on the SAME session
  // a fresh request — see `selectSessionRequest`.
  const [selectRequest, setSelectRequest] = useState<{
    sessionId: string
    nonce: number
  } | null>(null)
  useEffect(
    () =>
      window.starbase.onNotificationActivated(({ sessionId }) =>
        setSelectRequest((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }))
      ),
    []
  )
  // Keep the module-level cell the conversation registry reads in sync. It can't
  // use a hook: it outlives every component. See `active-session.ts`.
  const onVisibleSessionsChange = useCallback(
    (ids: ReadonlySet<string>) => setVisibleSessionIds(ids),
    []
  )

  const liveActivity = useSessionActivities()
  const liveDiff = useSessionDiffs()
  const planSessions = usePlanSessions()
  const termDock = useTerminalDock()
  const browserDock = useBrowserPreview()
  const qc = useQueryClient()

  // Renderer-side rpc reads, via react-query.
  const configQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  // Settings' Gigaplan pane needs both: the catalogue to choose an orchestrator
  // model from, and readiness to explain itself when the mode cannot run here.
  const catalogQuery = useQuery({ queryKey: ["models-catalog"], queryFn: () => rpc.modelsCatalog() })
  const readinessQuery = useQuery({ queryKey: ["plan-readiness"], queryFn: () => rpc.planReadiness() })
  const billingQuery = useQuery({ queryKey: ["billing-paths"], queryFn: () => rpc.billingPaths() })
  const ghStatusQuery = useQuery({ queryKey: ["gh-status"], queryFn: () => rpc.ghStatus() })
  const usageQuery = useQuery({ queryKey: ["usage"], queryFn: () => rpc.usageGet(), enabled: false })

  const githubConfig = configQuery.data?.github ?? null
  const gitConfig = configQuery.data?.git ?? null
  const notificationsConfig = configQuery.data?.notifications ?? null
  // Absent means on — plan mode's commands are read-only.
  const planAutoRun = configQuery.data?.planAutoRun ?? true
  // Absent means off — ADHD mode rewrites the voice of every session, so it is
  // opt-in rather than a default the operator has to discover and undo.
  const adhdMode = configQuery.data?.adhdMode ?? false
  const providersConfig = configQuery.data?.providers ?? null
  // Absent means "the first installed harness" — resolved downstream by
  // `newSessionCli`, so a fresh install creates sessions without a visit to
  // Settings.
  const defaultCli = configQuery.data?.defaultCli ?? null
  const contextConfig = configQuery.data?.context ?? null
  const starredRepos = configQuery.data?.starredRepos ?? []
  const collapsedRepos = configQuery.data?.collapsedRepos ?? []
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
  const saveNotificationsConfig = (config: NotificationsConfig) =>
    rpc.configSetNotifications(config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const savePlanAutoRun = (value: boolean) =>
    rpc.configSetPlanAutoRun(value).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const saveAdhdMode = (value: boolean) =>
    rpc.configSetAdhdMode(value).then((saved) => {
      qc.setQueryData(["config"], saved)
    })

  /**
   * Settings › Themes.
   *
   * The catalog comes from the SAME query key `useTheme` subscribes to, so a
   * write here — select, duplicate, delete, import — repaints the app through
   * the provider without this component knowing anything about CSS. Writes seed
   * the cache directly rather than invalidating: `Theme.save`/`duplicate` return
   * the affected summary, but only `Theme.list` knows the whole ordering, so the
   * catalog is refetched and the config patched in place.
   */
  const themeCatalog = useQuery({ queryKey: ["themes"], queryFn: () => rpc.themeList() })
  const refreshThemes = () => qc.invalidateQueries({ queryKey: ["themes"] })
  const themeSettings = {
    themes: themeCatalog.data?.themes ?? [],
    skipped: themeCatalog.data?.skipped ?? [],
    activeId: configQuery.data?.theme?.activeId ?? DEFAULT_THEME_ID,
    onSelect: (id: string) =>
      rpc.themeSetActive(id).then((saved) => {
        qc.setQueryData(["config"], saved)
      }),
    onDuplicate: (id: string, name?: string) =>
      rpc.themeDuplicate(id, name).then(async (copy) => {
        await refreshThemes()
        return copy
      }),
    onDelete: (id: string) => rpc.themeDelete(id).then(() => refreshThemes()).then(() => undefined),
    onImport: (json: string) =>
      rpc.themeImport(json).then(async (imported) => {
        await refreshThemes()
        return imported
      }),
    loadTheme: (id: string) => rpc.themeGet(id),
    onSave: (id: string, theme: VsCodeTheme) =>
      rpc.themeSave(id, theme).then(async (saved) => {
        // The editor debounces, so this fires per settled drag rather than per
        // frame. Refetching keeps the swatch preview in step with the picker.
        await refreshThemes()
        await qc.invalidateQueries({ queryKey: ["theme-source", id] })
        return saved
      }),
    onReveal: (path: string) => void rpc.themeReveal(path)
  }
  const saveDefaultCli = (cli: CliKind) =>
    rpc.configSetDefaultCli(cli).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const saveProvider = (cli: CliKind, config: ProviderConfig) =>
    rpc.configSetProvider(cli, config).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  const saveContextConfig = (config: ContextConfig) =>
    rpc.configSetContext(config).then((saved) => {
      qc.setQueryData(["config"], saved)
      // Every session's trigger point moves with the budget, so drop the cached
      // snapshots rather than leaving meters reading against the old one.
      void qc.invalidateQueries({ queryKey: ["context"] })
    })
  const saveOrchestrator = (cli: CliKind, model: string) => {
    void rpc.configSetOrchestrator(cli, model).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  }
  const saveGigaplanRouting = (routing: GigaplanRoutingConfig) => {
    void rpc.configSetGigaplanRouting(routing).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  }

  // Toggle a repo's starred state, persist the whole list, and update the cache.
  const toggleStar = (repoPath: string) => {
    const next = starredRepos.includes(repoPath)
      ? starredRepos.filter((p) => p !== repoPath)
      : [...starredRepos, repoPath]
    return rpc.configSetStarredRepos(next).then((saved) => {
      qc.setQueryData(["config"], saved)
    })
  }
  // Toggle a repo's collapsed state (path-keyed; "__archived__" collapses the
  // Archived group), persist the whole list, and update the cache.
  const toggleCollapsed = (repoPath: string) => {
    const next = collapsedRepos.includes(repoPath)
      ? collapsedRepos.filter((p) => p !== repoPath)
      : [...collapsedRepos, repoPath]
    return rpc.configSetCollapsedRepos(next).then((saved) => {
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
  const createSessionFromIssue = async (input: CreateSessionFromIssueInput) => {
    const session = await rpc.sessionsCreateFromIssue(input)
    void rememberLastRepo(input.repoPath)
    send({ type: "SESSION_CREATED", session })
    return session
  }
  const onPrLinked = (sessionId: string, prNumber: number) =>
    send({ type: "SESSION_PR_LINKED", sessionId, prNumber })

  const unlinkIssue = (sessionId: string) =>
    void rpc.sessionsUnlinkIssue(sessionId).then((session) => send({ type: "SESSION_UPDATED", session }))

  // The composer consumed the one-shot prompt: clear it (backend returns the
  // updated session) so re-opening the session never re-seeds the draft.
  const consumeInitialPrompt = (sessionId: string) =>
    void rpc
      .sessionsClearInitialPrompt(sessionId)
      .then((session) => send({ type: "SESSION_UPDATED", session }))

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
    // Same reasoning for the composer draft — it outlives the pane by design, so
    // nothing else would ever collect it (and it's persisted).
    clearDraft(sessionId)
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
  const prevLiveRef = useRef<Record<string, SessionActivity>>({})
  useEffect(() => {
    const prev = prevLiveRef.current
    prevLiveRef.current = liveActivity
    const completed = completedSessionIds(prev, liveActivity, sessions)
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
  }, [liveActivity, sessions, autoDetect, send, qc])

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

  // PR-state sweep: track each linked PR's merged/closed state and BADGE the row.
  //
  // This used to auto-archive the session the moment its PR merged. That was
  // wrong: a session holds a single `prNumber`, but one session routinely
  // outlives several PRs (open one, merge it, keep working off the same worktree
  // and open the next). Merging PR #204 therefore said nothing about whether the
  // WORK was done, and a live multi-PR session would silently vanish from the
  // sidebar mid-flight. Retiring a session is now always the operator's call —
  // the badge reports, it doesn't act.
  const sweepTargets = useMemo(
    () => sessions.filter((s) => s.prNumber != null && Boolean(s.worktreePath) && !s.archived),
    [sessions]
  )
  const prStates = useQueries({
    queries: sweepTargets.map((s) => ({
      queryKey: ["pr-state", s.id, s.prNumber] as const,
      queryFn: () => rpc.githubPrState(s.id),
      enabled: connected,
      staleTime: PR_STATE_STALE_MS,
      // Poll so a PR merged/closed on GitHub badges its session live instead of
      // only on a cold app relaunch (the query would otherwise never re-fetch).
      refetchInterval: ARCHIVE_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true
    })),
    combine: (results) =>
      Object.fromEntries(
        sweepTargets.flatMap((s, i) => {
          const state = results[i]?.data
          return state ? [[s.id, state] as const] : []
        })
      )
  })
  // The lifecycle half of the same poll, for the pure sweep functions below.
  //
  // Those two ask exactly one question — "has this PR resolved?" — and the CI
  // rollup would be noise in their signature and in their tests. Derived here
  // rather than fetched twice: one poll, two shapes.
  const prLifecycle = useMemo(
    () => Object.fromEntries(Object.entries(prStates).map(([id, pr]) => [id, pr.state] as const)),
    [prStates]
  )

  // Auto adversarial review (opt-in). Polls `Review.run` on the same cadence as
  // the archive sweep, which sounds expensive but isn't: the main process
  // short-circuits on an unchanged PR head, so a tick with no new commits costs
  // one `gh pr view` and spawns nothing. That server-side de-dupe is why this
  // needs no client-side "already reviewed this SHA" guard of its own — the
  // renderer can fire naively and stay correct.
  // Gated on `enabled` as well as the toggle itself: turning PR features off must
  // stop reviews too, and a config can carry autoAdversarialReview:true from
  // before the master switch was flipped off. A review costs real tokens, so it
  // fails closed.
  const autoReview =
    connected && (githubConfig?.enabled ?? false) && (githubConfig?.autoAdversarialReview ?? false)
  const reviewTargets = useMemo(
    () => (autoReview ? sweepTargets : []),
    [autoReview, sweepTargets]
  )
  const autoReviews = useQueries({
    queries: reviewTargets.map((s) => ({
      queryKey: ["auto-review", s.id, s.prNumber] as const,
      queryFn: () => rpc.reviewRun(s.id, false),
      staleTime: PR_STATE_STALE_MS,
      refetchInterval: ARCHIVE_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      // A reviewer that can't run (gh hiccup, harness missing) must never retry
      // in a loop or surface anywhere — the manual button remains the recourse.
      retry: false
    })),
    /**
     * Keyed off the review's OWN `sessionId`, never the query's position.
     *
     * This used to zip `reviewTargets[i]` with `results[i]`. That pairing is only
     * sound while both arrays stay the same length in the same order, and
     * `reviewTargets` derives from `sweepTargets`, which filters `!s.archived` —
     * so archiving ANY session shifts every later index by one and welds one
     * session's id onto another session's review. The observed damage: a session
     * was handed the findings from a different session's PR, which it published
     * into its cache AND routed to its agent, spending a real turn arguing about
     * a file that does not exist on its branch.
     *
     * The review carries the id it belongs to. Use it, and let a result with no
     * data drop out rather than shift everything behind it.
     */
    combine: (results) =>
      results.flatMap((r) => {
        const review = r?.data
        return review ? [{ id: review.sessionId, review }] : []
      })
  })
  // Publish auto-review results into the cache the PR tab reads, so findings
  // appear without the user having to click Review.
  useEffect(() => {
    for (const { id, review } of autoReviews) {
      qc.setQueryData(reviewQueryKey(id), review)
    }
  }, [autoReviews, qc])

  // Hand each new review's critical/major findings to that session's agent.
  //
  // Here rather than in `useAdversarialReview` because that hook only exists for
  // the session you're LOOKING at, and the whole point of the auto-review is that
  // it runs across every session on a timer — a background session's reviewer
  // finding a data-loss bug should reach its agent whether or not the tab is
  // open. `routeReviewToAgent` no-ops on an already-routed review (a stamp
  // persisted in main), so firing it on every tick is safe.
  useEffect(() => {
    for (const { id, review } of autoReviews) {
      const session = sessions.find((s) => s.id === id)
      if (session) void routeReviewToAgent(session, review, qc)
    }
  }, [autoReviews, sessions, qc])

  // Close-on-merge automation. Decoupled from archiving (which no longer happens
  // automatically): closing the linked ISSUE when its PR merges is a statement
  // about the issue, not about whether the session is finished, so it still fires
  // on merge. Once per session — the ref guards against the poll re-firing it on
  // every tick, since a merged PR stays merged forever.
  const closedIssuesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const id of issuesToCloseOnMerge(prLifecycle, sessions, closedIssuesRef.current)) {
      closedIssuesRef.current.add(id)
      void rpc.githubCloseIssue(id).catch(() => {})
    }
  }, [prLifecycle, sessions])

  // Tell the operator when a session's PR resolves on GitHub. Guarded by its own
  // ref for the same reason as the issue-closing sweep above: the poll re-runs
  // every minute and a merged PR stays merged, so without this it would announce
  // the same merge forever.
  const notifiedPrsRef = useRef<Set<string>>(new Set())
  // Whether the first poll of this launch has been absorbed. Everything it
  // reports is PRE-EXISTING — merged is permanent, but this ref is memory-only,
  // so without a baseline every launch would re-announce every already-merged
  // session in the sidebar. The first poll is recorded silently; only later
  // transitions are news. Same rule the transcript notifier applies to a
  // restored session.
  const prBaselineRef = useRef(false)
  useEffect(() => {
    // An empty first result is the "still loading" state, not a real baseline —
    // taking it would let the genuine first result through as an edge.
    const seeding = !prBaselineRef.current && Object.keys(prLifecycle).length > 0
    for (const { session, state: prState } of prsToNotify(
      prLifecycle,
      sweepTargets,
      notifiedPrsRef.current
    )) {
      notifiedPrsRef.current.add(session.id)
      if (seeding) continue
      const plan = prNotification(session.title, prState)
      void rpc
        .notifyShow({
          sessionId: session.id,
          kind: plan.kind,
          title: plan.title,
          body: plan.body,
          // A resolved PR is worth surfacing even while its session is open —
          // the merge happened on GitHub, not here, so there is nothing on
          // screen that already told them.
          isActiveSession: false
        })
        .catch(() => {})
    }
    if (seeding) prBaselineRef.current = true
  }, [prLifecycle, sweepTargets])

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
      selectSessionRequest={selectRequest}
      onVisibleSessionsChange={onVisibleSessionsChange}
      sessions={sessions}
      user={user}
      onSignOut={onSignOut}
      repos={repos}
      starredRepos={starredRepos}
      onToggleStar={toggleStar}
      collapsedRepos={collapsedRepos}
      onToggleCollapsed={toggleCollapsed}
      defaultRepoPath={lastRepoPath}
      ghStatus={ghStatus}
      liveActivity={liveActivity}
      prStates={prStates}
      liveDiff={liveDiff}
      usage={usage}
      onLoadUsage={loadUsage}
      githubConfig={githubConfig}
      onSaveGithubConfig={saveGithubConfig}
      gitConfig={gitConfig}
      onSaveGitConfig={saveGitConfig}
      notificationsConfig={notificationsConfig}
      onSaveNotificationsConfig={saveNotificationsConfig}
      planAutoRun={planAutoRun}
      onSavePlanAutoRun={savePlanAutoRun}
      adhdMode={adhdMode}
      onSaveAdhdMode={saveAdhdMode}
      themes={themeSettings}
      providersConfig={providersConfig}
      onSaveProvider={saveProvider}
      defaultCli={defaultCli}
      onSaveDefaultCli={saveDefaultCli}
      contextConfig={contextConfig}
      onSaveContextConfig={saveContextConfig}
      modelCatalog={catalogQuery.data ?? []}
      orchestrator={configQuery.data?.orchestrator ?? null}
      onSaveOrchestrator={saveOrchestrator}
      gigaplanRouting={configQuery.data?.gigaplanRouting ?? null}
      onSaveGigaplanRouting={saveGigaplanRouting}
      gigaplanUnavailableReason={readinessQuery.data?.ready === false ? readinessQuery.data.reason : null}
      billing={billingQuery.data ?? []}
      loadModels={rpc.modelsList}
      loadOpencodeProviders={rpc.opencodeListProviders}
      onSetOpencodeAuth={rpc.opencodeSetAuth}
      // Settings has no session, so MCP config resolves to user scope only.
      loadMcpServers={(cli) => rpc.mcpList(null, cli)}
      loadMcpStatus={(cli, refresh) => rpc.mcpStatus(null, cli, refresh)}
      onRecheckGh={recheckGh}
      loadBranches={rpc.workspaceBranches}
      onCreateSession={createSession}
      onRenameSession={renameSession}
      onArchiveSession={archiveSession}
      onRestoreSession={restoreSession}
      onDeleteSession={(id) => setPendingDelete(sessions.find((s) => s.id === id) ?? null)}
      loadPrs={connected ? rpc.githubListPrs : undefined}
      onCreateSessionFromPr={connected ? createSessionFromPr : undefined}
      loadIssues={connected ? rpc.githubListIssues : undefined}
      onCreateSessionFromIssue={connected ? createSessionFromIssue : undefined}
      planSessions={planSessions}
      renderConversation={(session: Session, view, ctx) => (
        <ConversationPane
          session={session}
          view={view}
          onOpenPlanReview={ctx.onOpenPlanReview}
          planStepId={ctx.planStepId}
          onPlanStepSelected={ctx.onPlanStepSelected}
          onRestore={restoreSession}
          onDelete={deleteSession}
          onInitialPromptConsumed={consumeInitialPrompt}
          paneFocused={ctx.paneFocused ?? true}
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
      renderIssue={(session) => <IssuePane session={session} onUnlink={unlinkIssue} />}
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
      browserDockSide={browserDock.side}
      browserActive={browserDock.visible}
      onToggleBrowser={browserDock.toggle}
      renderBrowserDock={(session) => (
        <BrowserPreviewView
          session={session}
          visible={browserDock.visible}
          onToggle={browserDock.toggle}
          side={browserDock.side}
          onSideChange={browserDock.setSide}
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

/** Map the auth machine's signed-out substate to the LoginScreen's visual state. */
function loginStateOf(matches: (value: object) => boolean): "default" | "loading" | "sent" | "error" {
  if (matches({ signedOut: "sending" }) || matches({ signedOut: "oauthPending" })) return "loading"
  if (matches({ signedOut: "magicLinkSent" })) return "sent"
  if (matches({ signedOut: "error" })) return "error"
  return "default"
}

/**
 * The auth gate. Drives the dedicated `authMachine` and renders the sign-in wall
 * until it reaches `signedIn`, at which point the real app (`AuthedApp`) mounts.
 * The `starbase://` deep-link callback arrives from the main process via the
 * preload bridge and re-validates the freshly-stored token.
 */
export function App() {
  const [authState, authSend] = useMachine(authMachine)

  /**
   * The theme is applied ABOVE the sign-in wall, not inside it.
   *
   * The loading splash and the login screen are the first things an operator
   * sees, and they are on screen for the longest at the moment the app has the
   * least state. Theming only the signed-in app would mean launching into a
   * dark login screen and having it turn light the instant auth resolved —
   * exactly the flash `boot-theme.ts` exists to prevent, just moved later.
   *
   * Sharing the `["config"]` query key with `AuthedApp` means React Query
   * dedupes this: it is the same in-flight request, not a second read.
   */
  const configQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const theme = useTheme(configQuery.data)

  useEffect(() => {
    const unsubscribe = window.starbase.onAuthComplete((payload) => {
      if (payload.ok) authSend({ type: "CALLBACK" })
    })
    return unsubscribe
  }, [authSend])

  return (
    <ThemeProvider
      tokens={theme.tokens}
      activeId={theme.activeId}
      catalog={theme.catalog}
      theme={theme.theme}
    >
      <AppContent authState={authState} authSend={authSend} />
    </ThemeProvider>
  )
}

function AppContent({
  authState,
  authSend
}: {
  authState: ReturnType<typeof useMachine<typeof authMachine>>[0]
  authSend: ReturnType<typeof useMachine<typeof authMachine>>[1]
}) {
  if (authState.matches("checking") || authState.matches("signingOut")) {
    return <LoadingScreen />
  }

  if (!authState.matches("signedIn")) {
    return (
      <LoginScreen
        state={loginStateOf((value) => authState.matches(value as never))}
        sentEmail={authState.context.sentEmail ?? undefined}
        errorMessage={authState.context.error ?? undefined}
        onGithub={() => authSend({ type: "OAUTH", provider: "github" })}
        onGoogle={() => authSend({ type: "OAUTH", provider: "google" })}
        onSendMagicLink={(email, name) => authSend({ type: "MAGIC_LINK", email, name })}
        onReset={() => authSend({ type: "RESET" })}
      />
    )
  }

  return (
    <AuthedApp
      user={authState.context.session?.user}
      onSignOut={() => authSend({ type: "SIGN_OUT" })}
    />
  )
}
