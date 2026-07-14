import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import type {
  CliInfo,
  CliKind,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GhStatus,
  GitConfig,
  GithubConfig,
  ModelOption,
  PrSummary,
  ProviderConfig,
  ProvidersConfig,
  Repo,
  Session,
  SessionStatus,
  Usage
} from "@starbase/core"
import type { DockSide } from "./terminal-panel.js"
import { AppShell } from "./app-shell.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { UsageModal } from "../composites/usage-modal.js"
import { SettingsView } from "../composites/settings-view.js"
import { SessionConversation } from "../screens/session-conversation.js"
import { SEED_PATCH } from "../seed.js"

const GH_UNAVAILABLE: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

export interface StarbaseAppProps {
  clis: ReadonlyArray<CliInfo>
  sessions: ReadonlyArray<Session>
  /** Repos discovered under the workspace, for the New Session picker. */
  repos?: ReadonlyArray<Repo>
  /** Absolute paths of starred repos — surfaced first in the picker + sidebar. */
  starredRepos?: ReadonlyArray<string>
  /** Toggle a repo's starred state (by absolute path); persists upstream. */
  onToggleStar?: (repoPath: string) => void | Promise<void>
  /** Preselect this repo (by path) when the New Session dialog opens. */
  defaultRepoPath?: string | null
  /** GitHub CLI status for the harnesses strip. */
  ghStatus?: GhStatus
  /** Live per-session agent status (thinking / needs-input) while running. */
  liveStatus?: Record<string, SessionStatus>
  /** Provider usage snapshot for the Usage & limits modal. */
  usage?: Usage | null
  /** Fetch fresh usage (called when the modal opens); may be async. */
  onLoadUsage?: () => Promise<void> | void
  /** Persisted GitHub integration preferences (for the settings modal). */
  githubConfig?: GithubConfig | null
  /** Persist GitHub preferences; presence wires the GitHub settings entry point. */
  onSaveGithubConfig?: (config: GithubConfig) => Promise<void> | void
  /** Persisted git preferences (for the settings modal's Git section). */
  gitConfig?: GitConfig | null
  /** Persist git preferences (the "share checked-out branches" lever). */
  onSaveGitConfig?: (config: GitConfig) => Promise<void> | void
  /** Re-run `gh auth status` (the settings "Recheck" button); may be async. */
  onRecheckGh?: () => Promise<void> | void
  /** Persisted per-CLI provider defaults (Settings · Providers view). */
  providersConfig?: ProvidersConfig | null
  /** Persist one CLI's provider defaults; presence wires the Settings gear. */
  onSaveProvider?: (cli: CliKind, config: ProviderConfig) => Promise<void> | void
  /** Load the selectable models for a CLI (Settings · Providers). */
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the per-session terminal dock (desktop app's live TerminalDock). */
  renderTerminalDock?: (session: Session) => ReactNode
  /** Which edge the terminal dock attaches to (drives the content column's flow). */
  terminalDockSide?: DockSide
  activeSessionId?: string | null
  patch?: string
  /**
   * Render the live conversation for the active session. Called with the active
   * session, the `view` to show (transcript or Plan Review — both driven by the
   * same machine), and a ctx to open the Plan Review tab. Mounted keyed by
   * session id. Absent in stories → the seeded fallback renders.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan",
    ctx: { onOpenPlanReview: () => void }
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** Load branch names for a repo (New Session base picker). */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Create a session (forks a real worktree) and return it. */
  onCreateSession?: (input: CreateSessionInput) => Promise<Session>
  /** Manually rename a session (double-click its sidebar title) — pins the name. */
  onRenameSession?: (id: string, title: string) => void
  /**
   * List open PRs for a repo (the New Session "From PR" picker). Presence wires
   * the `Blank | From PR` toggle; absent (e.g. GitHub not connected) hides it.
   */
  loadPrs?: (repoPath: string, opts: { mine: boolean; search: string }) => Promise<ReadonlyArray<PrSummary>>
  /** Create a session from an existing PR (checks out its head branch) and return it. */
  onCreateSessionFromPr?: (input: CreateSessionFromPrInput) => Promise<Session>
  /** App version (from `__APP_VERSION__`), shown in the sidebar footer. */
  version?: string
}

const noBranches = async (): Promise<ReadonlyArray<string>> => []

/**
 * The product shell — the whole Starbase window, data-driven. The desktop
 * renderer feeds it discovered `clis`/`repos`/`ghStatus` and the session list
 * over Effect RPC, plus the callbacks that create real worktrees.
 */
export function StarbaseApp({
  clis,
  sessions,
  repos = [],
  starredRepos = [],
  onToggleStar,
  defaultRepoPath,
  ghStatus,
  liveStatus,
  usage,
  onLoadUsage,
  githubConfig,
  onSaveGithubConfig,
  gitConfig,
  onSaveGitConfig,
  onRecheckGh,
  providersConfig,
  onSaveProvider,
  loadModels,
  renderPullRequest,
  renderReview,
  renderCode,
  renderTerminalDock,
  terminalDockSide,
  activeSessionId,
  patch = SEED_PATCH,
  renderConversation,
  planSessions,
  loadBranches = noBranches,
  onCreateSession,
  onRenameSession,
  loadPrs,
  onCreateSessionFromPr,
  version
}: StarbaseAppProps) {
  const [selected, setSelected] = useState<string | null>(
    activeSessionId ?? sessions[0]?.id ?? null
  )
  const [newOpen, setNewOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageLoading, setUsageLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ghRechecking, setGhRechecking] = useState(false)

  const openUsage = useCallback(() => {
    setUsageOpen(true)
    const result = onLoadUsage?.()
    if (result && typeof (result as Promise<void>).then === "function") {
      setUsageLoading(true)
      void (result as Promise<void>).finally(() => setUsageLoading(false))
    }
  }, [onLoadUsage])

  const handleRecheckGh = useCallback(() => {
    const result = onRecheckGh?.()
    if (result && typeof (result as Promise<void>).then === "function") {
      setGhRechecking(true)
      void (result as Promise<void>).finally(() => setGhRechecking(false))
    }
  }, [onRecheckGh])

  const ghConnected = Boolean(ghStatus?.available && ghStatus?.authenticated)

  // The sidebar groups sessions by repo *name* (Session.repo === Repo.name), so
  // translate the path-keyed stars into the names those groups pin on.
  const starredRepoNames = useMemo(() => {
    const paths = new Set(starredRepos)
    return new Set(repos.filter((r) => paths.has(r.path)).map((r) => r.name))
  }, [repos, starredRepos])
  const toggleStarByName = useCallback(
    (repoName: string) => {
      const repo = repos.find((r) => r.name === repoName)
      if (repo) return onToggleStar?.(repo.path)
    },
    [repos, onToggleStar]
  )

  const active = sessions.find((s) => s.id === selected) ?? null
  // Key the pane by session id so each session drives a fresh conversation
  // machine (the deterministic per-session reset — no session-sync effect). The
  // same pane serves both the Conversation and Plan tabs (see SessionConversation).
  const renderConversationPane =
    active && renderConversation
      ? (view: "conversation" | "plan", ctx: { onOpenPlanReview: () => void }) => (
          <div key={active.id} className="flex min-h-0 min-w-0 flex-1">
            {renderConversation(active, view, ctx)}
          </div>
        )
      : undefined
  // In the real app (renderConversation wired) with nothing selected, show the
  // empty state rather than the Storybook-only seeded demo transcript.
  const showEmpty = Boolean(renderConversation) && active === null

  // ⌘N / Ctrl-N opens the New Session dialog (only when creation is wired).
  useEffect(() => {
    if (!onCreateSession) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault()
        setNewOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCreateSession])

  const handleCreate = useCallback(
    async (input: CreateSessionInput) => {
      if (!onCreateSession) return
      const session = await onCreateSession(input)
      setSelected(session.id)
    },
    [onCreateSession]
  )

  const handleCreateFromPr = useCallback(
    async (input: CreateSessionFromPrInput) => {
      if (!onCreateSessionFromPr) return
      const session = await onCreateSessionFromPr(input)
      setSelected(session.id)
    },
    [onCreateSessionFromPr]
  )

  return (
    <AppShell title="Starbase">
      <SessionConversation
        sessions={sessions}
        clis={clis}
        activeSessionId={selected}
        onSelectSession={setSelected}
        onRenameSession={onRenameSession}
        renderConversationPane={renderConversationPane}
        planSessions={planSessions}
        showEmpty={showEmpty}
        patch={patch}
        liveStatus={liveStatus}
        onNewSession={onCreateSession ? () => setNewOpen(true) : undefined}
        onOpenUsage={onLoadUsage ? openUsage : undefined}
        onOpenSettings={onSaveProvider ? () => setSettingsOpen(true) : undefined}
        settingsView={
          settingsOpen && onSaveProvider ? (
            <SettingsView
              clis={clis}
              providers={providersConfig}
              onSaveProvider={onSaveProvider}
              loadModels={loadModels ?? (async () => [])}
              ghStatus={ghStatus ?? GH_UNAVAILABLE}
              github={githubConfig}
              git={gitConfig}
              rechecking={ghRechecking}
              onRecheck={onRecheckGh ? handleRecheckGh : undefined}
              onSaveGithub={onSaveGithubConfig}
              onSaveGit={onSaveGitConfig}
              onClose={() => setSettingsOpen(false)}
            />
          ) : undefined
        }
        ghConnected={ghConnected}
        starredRepoNames={starredRepoNames}
        onToggleStar={onToggleStar ? toggleStarByName : undefined}
        renderPullRequest={renderPullRequest}
        renderReview={renderReview}
        renderCode={renderCode}
        renderTerminalDock={renderTerminalDock}
        terminalDockSide={terminalDockSide}
        version={version}
      />
      {onCreateSession && (
        <NewSessionDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          repos={repos}
          starredRepos={starredRepos}
          onToggleStar={onToggleStar}
          defaultRepoPath={defaultRepoPath}
          clis={clis}
          loadBranches={loadBranches}
          onCreate={handleCreate}
          loadPrs={loadPrs}
          onCreateFromPr={onCreateSessionFromPr ? handleCreateFromPr : undefined}
        />
      )}
      {onLoadUsage && (
        <UsageModal
          open={usageOpen}
          usage={usage}
          loading={usageLoading}
          onClose={() => setUsageOpen(false)}
        />
      )}
    </AppShell>
  )
}
