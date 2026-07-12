import { type ReactNode, useCallback, useEffect, useState } from "react"
import type {
  CliInfo,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GhStatus,
  GithubConfig,
  PrSummary,
  Repo,
  Session,
  SessionStatus,
  Usage
} from "@starbase/core"
import { AppShell } from "./app-shell.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { UsageModal } from "../composites/usage-modal.js"
import { SettingsDialog } from "../composites/settings-dialog.js"
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
  /** Re-run `gh auth status` (the settings modal "Recheck" button); may be async. */
  onRecheckGh?: () => Promise<void> | void
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  activeSessionId?: string | null
  patch?: string
  /**
   * Render the live conversation for the active session. Called with the active
   * session and mounted keyed by its id, so each session drives a fresh
   * conversation machine. Absent in stories → the seeded fallback renders.
   */
  renderConversation?: (session: Session) => ReactNode
  /** Load branch names for a repo (New Session base picker). */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Create a session (forks a real worktree) and return it. */
  onCreateSession?: (input: CreateSessionInput) => Promise<Session>
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
  ghStatus,
  liveStatus,
  usage,
  onLoadUsage,
  githubConfig,
  onSaveGithubConfig,
  onRecheckGh,
  renderPullRequest,
  renderReview,
  activeSessionId,
  patch = SEED_PATCH,
  renderConversation,
  loadBranches = noBranches,
  onCreateSession,
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

  const active = sessions.find((s) => s.id === selected) ?? null
  // Key the pane by session id so each session drives a fresh conversation
  // machine (the deterministic per-session reset — no session-sync effect).
  const conversationPane =
    active && renderConversation ? (
      <div key={active.id} className="flex min-w-0 flex-1">
        {renderConversation(active)}
      </div>
    ) : undefined
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
        conversationPane={conversationPane}
        showEmpty={showEmpty}
        patch={patch}
        liveStatus={liveStatus}
        onNewSession={onCreateSession ? () => setNewOpen(true) : undefined}
        onOpenUsage={onLoadUsage ? openUsage : undefined}
        onOpenSettings={onSaveGithubConfig ? () => setSettingsOpen(true) : undefined}
        ghConnected={ghConnected}
        renderPullRequest={renderPullRequest}
        renderReview={renderReview}
        version={version}
      />
      {onCreateSession && (
        <NewSessionDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          repos={repos}
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
      {onSaveGithubConfig && (
        <SettingsDialog
          open={settingsOpen}
          ghStatus={ghStatus ?? GH_UNAVAILABLE}
          github={githubConfig}
          rechecking={ghRechecking}
          onRecheck={onRecheckGh ? handleRecheckGh : undefined}
          onSaveGithub={onSaveGithubConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </AppShell>
  )
}
