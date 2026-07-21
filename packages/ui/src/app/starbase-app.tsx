import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import type {
  ContextConfig,
  ContextSnapshot,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GhStatus,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  DiffStat,
  IssueSummary,
  McpServer,
  McpServerStatus,
  ModelOption,
  OpencodeProviderInfo,
  PrState,
  PrSummary,
  ProviderConfig,
  ProviderModels,
  HarnessBilling,
  ProvidersConfig,
  Repo,
  Session,
  SessionActivity,
  Usage,
  User
} from "@starbase/core"
import type { DockSide } from "./terminal-panel.js"
import { AppShell } from "./app-shell.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { UsageModal } from "../composites/usage-modal.js"
import { SettingsView } from "../composites/settings-view.js"
import { type ConversationPaneCtx, SessionConversation } from "../screens/session-conversation.js"
import { ARCHIVED_GROUP_KEY } from "./session-sidebar.js"
import { useSplitLayout } from "./use-split-layout.js"
import { MAX_PANES } from "./split-layout.js"
import { matchSplitShortcut } from "./split-shortcuts.js"
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
  /** The signed-in user, shown in the sidebar footer account menu. */
  user?: User
  /** Sign out of the app (from the account menu). */
  onSignOut?: () => void
  /** Repos discovered under the workspace, for the New Session picker. */
  repos?: ReadonlyArray<Repo>
  /** Absolute paths of starred repos — surfaced first in the picker + sidebar. */
  starredRepos?: ReadonlyArray<string>
  /** Toggle a repo's starred state (by absolute path); persists upstream. */
  onToggleStar?: (repoPath: string) => void | Promise<void>
  /**
   * Absolute paths of repos collapsed in the sidebar; the sentinel
   * `"__archived__"` collapses the Archived group.
   */
  collapsedRepos?: ReadonlyArray<string>
  /** Toggle a repo's collapsed state (by absolute path or the archived sentinel). */
  onToggleCollapsed?: (repoPath: string) => void | Promise<void>
  /** Preselect this repo (by path) when the New Session dialog opens. */
  defaultRepoPath?: string | null
  /** GitHub CLI status for the harnesses strip. */
  ghStatus?: GhStatus
  /** What each session's agent is doing right now ("Running npm test"), keyed by id. */
  liveActivity?: Record<string, SessionActivity>
  /** Live linked-PR state per session id, badged onto sidebar rows. */
  prStates?: Record<string, PrState>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Provider usage snapshot for the Usage & limits modal. */
  usage?: Usage | null
  /** Fetch fresh usage (called when the modal opens); may be async. */
  onLoadUsage?: () => Promise<void> | void
  /** Persisted GitHub integration preferences (for the settings modal). */
  githubConfig?: GithubConfig | null
  /** Persist GitHub preferences; presence wires the GitHub settings entry point. */
  onSaveGithubConfig?: (config: GithubConfig) => Promise<void> | void
  /** Auto-compaction levers, persisted to `WorkspaceConfig.context`. */
  contextConfig?: ContextConfig | null
  onSaveContextConfig?: (config: ContextConfig) => Promise<void> | void
  /** Live per-session context readings, so the budget can be set against reality. */
  contextSessions?: ReadonlyArray<{
    id: string
    title: string
    cli: CliKind
    snapshot: ContextSnapshot
  }>
  /** Persisted git preferences (for the settings modal's Git section). */
  gitConfig?: GitConfig | null
  /** Persist git preferences (the "share checked-out branches" lever). */
  onSaveGitConfig?: (config: GitConfig) => Promise<void> | void
  /** Desktop-notification prefs; absent means the defaults, not "off". */
  notificationsConfig?: NotificationsConfig | null
  onSaveNotificationsConfig?: (config: NotificationsConfig) => Promise<void> | void
  /** Whether plan mode runs its read-only commands unattended; absent means on. */
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => Promise<void> | void
  /** Re-run `gh auth status` (the settings "Recheck" button); may be async. */
  onRecheckGh?: () => Promise<void> | void
  /** Persisted per-CLI provider defaults (Settings · Providers view). */
  providersConfig?: ProvidersConfig | null
  /** Persist one CLI's provider defaults; presence wires the Settings gear. */
  onSaveProvider?: (cli: CliKind, config: ProviderConfig) => Promise<void> | void
  /** Every installed harness + its models, for Gigaplan's orchestrator picker. */
  modelCatalog?: ReadonlyArray<ProviderModels>
  /** The configured orchestrator harness+model, or null for the default. */
  orchestrator?: { readonly cli: CliKind; readonly model: string } | null
  onSaveOrchestrator?: (cli: CliKind, model: string) => void
  /** Why Gigaplan can't run on this host, when it can't. */
  gigaplanUnavailableReason?: string | null
  /** What each installed harness is charged to. */
  billing?: ReadonlyArray<HarnessBilling>
  /** Load the selectable models for a CLI (Settings · Providers). */
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  /** opencode's resolved providers + credential origins (Settings · Providers). */
  loadOpencodeProviders?: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  /** Store an API key in opencode's own credential file. */
  onSetOpencodeAuth?: (providerId: string, key: string) => Promise<boolean>
  /** MCP servers the given harness will load (Settings → MCP servers; user scope). */
  loadMcpServers?: (cli: CliKind) => Promise<ReadonlyArray<McpServer>>
  /** Live probe of those servers; `refresh` bypasses the cache. */
  loadMcpStatus?: (cli: CliKind, refresh: boolean) => Promise<ReadonlyArray<McpServerStatus>>
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Issue tab — the rich linked-issue view. */
  renderIssue?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the per-session terminal dock (desktop app's live TerminalDock). */
  renderTerminalDock?: (session: Session) => ReactNode
  /** Which edge the terminal dock attaches to (drives the content column's flow). */
  terminalDockSide?: DockSide
  /** Render the embedded browser-preview dock (desktop app's BrowserPreviewView). */
  renderBrowserDock?: (session: Session | null) => ReactNode
  /** Which edge the browser dock attaches to. */
  browserDockSide?: DockSide
  /** Toggle the browser-preview pane (adds a control to the tab bar). */
  onToggleBrowser?: () => void
  /** Whether the browser-preview pane is currently open. */
  browserActive?: boolean
  activeSessionId?: string | null
  /**
   * Select a session from OUTSIDE the shell — a notification click, a deep link.
   * Bump this to a new value to jump there; the shell owns the selection
   * otherwise, so a plain prop would fight the operator's own clicks. Ignored
   * when null.
   */
  selectSessionRequest?: { readonly sessionId: string; readonly nonce: number } | null
  /**
   * Notified whenever the set of ON-SCREEN sessions changes. A set rather than a
   * single id because the grid shows several at once, and the desktop suppresses
   * notifications for anything the operator can already see.
   */
  onVisibleSessionsChange?: (sessionIds: ReadonlySet<string>) => void
  patch?: string
  /**
   * Render the live conversation for the active session. Called with the active
   * session, the `view` to show (transcript or Plan Review — both driven by the
   * same machine), and a ctx to open the Plan Review tab. Mounted keyed by
   * session id. Absent in stories → the seeded fallback renders.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** Load branch names for a repo (New Session base picker). */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Create a session (forks a real worktree) and return it. */
  onCreateSession?: (input: CreateSessionInput) => Promise<Session>
  /** Manually rename a session (double-click its sidebar title) — pins the name. */
  onRenameSession?: (id: string, title: string) => void
  /** Archive an active session from the sidebar quick-actions (undoable). */
  onArchiveSession?: (id: string) => void
  /** Restore an archived session from the sidebar quick-actions. */
  onRestoreSession?: (id: string) => void
  /** Permanently delete a session from the sidebar quick-actions (confirms first). */
  onDeleteSession?: (id: string) => void
  /**
   * List open PRs for a repo (the New Session "From PR" picker). Presence wires
   * the `Blank | From PR` toggle; absent (e.g. GitHub not connected) hides it.
   */
  loadPrs?: (repoPath: string, opts: { mine: boolean; search: string }) => Promise<ReadonlyArray<PrSummary>>
  /** Create a session from an existing PR (checks out its head branch) and return it. */
  onCreateSessionFromPr?: (input: CreateSessionFromPrInput) => Promise<Session>
  /**
   * List open issues for a repo. Presence (with `onCreateSessionFromIssue`) wires
   * the "From issue" mode; absent (GitHub not connected) hides it.
   */
  loadIssues?: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ) => Promise<ReadonlyArray<IssueSummary>>
  /** Create a session from a GitHub issue (forks a fresh branch, links it) and return it. */
  onCreateSessionFromIssue?: (input: CreateSessionFromIssueInput) => Promise<Session>
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
  user,
  onSignOut,
  repos = [],
  starredRepos = [],
  onToggleStar,
  collapsedRepos = [],
  onToggleCollapsed,
  defaultRepoPath,
  ghStatus,
  liveActivity,
  prStates,
  liveDiff,
  usage,
  onLoadUsage,
  githubConfig,
  onSaveGithubConfig,
  contextConfig,
  onSaveContextConfig,
  contextSessions,
  gitConfig,
  onSaveGitConfig,
  notificationsConfig,
  onSaveNotificationsConfig,
  planAutoRun,
  onSavePlanAutoRun,
  onRecheckGh,
  providersConfig,
  onSaveProvider,
  modelCatalog,
  orchestrator,
  onSaveOrchestrator,
  gigaplanUnavailableReason,
  billing,
  loadModels,
  loadOpencodeProviders,
  onSetOpencodeAuth,
  loadMcpServers,
  loadMcpStatus,
  renderPullRequest,
  renderReview,
  renderCode,
  renderIssue,
  renderTerminalDock,
  terminalDockSide,
  renderBrowserDock,
  browserDockSide,
  onToggleBrowser,
  browserActive,
  activeSessionId,
  selectSessionRequest,
  onVisibleSessionsChange,
  patch = SEED_PATCH,
  renderConversation,
  planSessions,
  loadBranches = noBranches,
  onCreateSession,
  onRenameSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  loadPrs,
  onCreateSessionFromPr,
  loadIssues,
  onCreateSessionFromIssue,
  version
}: StarbaseAppProps) {
  // The split replaces what used to be a single `selected` useState. The focused
  // pane's session IS the old "selected" — every existing call site below still
  // reads `selected` / calls `setSelected` and behaves as it always did when the
  // group has one pane.
  const split = useSplitLayout(sessions, activeSessionId ?? sessions[0]?.id ?? null)
  const selected = split.activeSessionId
  const setSelected = split.selectSession
  const group = split.group
  const [newOpen, setNewOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageLoading, setUsageLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ghRechecking, setGhRechecking] = useState(false)

  // An outside request to jump to a session (notification click). Keyed on the
  // NONCE, not the id: clicking two notifications for the same session must
  // still land there the second time, and depending on the id alone would fight
  // the operator every time they navigated away from it themselves.
  const requestNonce = selectSessionRequest?.nonce
  const requestId = selectSessionRequest?.sessionId
  useEffect(() => {
    if (requestId === undefined) return
    setSelected(requestId)
    // Jumping to a session means SHOWING it — a notification that lands the
    // operator behind the Settings dialog has not done its job.
    setSettingsOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce is the trigger
  }, [requestNonce])

  // Publish the selection so the notifier can tell whether a session is the one
  // already on screen (see `active-session.ts` in the desktop renderer).
  useEffect(() => {
    onVisibleSessionsChange?.(split.visibleSessionIds)
  }, [split.visibleSessionIds, onVisibleSessionsChange])

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

  // Same path→name translation for collapsed repos; the archived sentinel is
  // passed through untranslated (it is not a repo).
  const collapsedRepoNames = useMemo(() => {
    const paths = new Set(collapsedRepos)
    const names = new Set(repos.filter((r) => paths.has(r.path)).map((r) => r.name))
    if (paths.has(ARCHIVED_GROUP_KEY)) names.add(ARCHIVED_GROUP_KEY)
    return names
  }, [repos, collapsedRepos])
  const toggleCollapsedByName = useCallback(
    (repoName: string) => {
      if (repoName === ARCHIVED_GROUP_KEY) return onToggleCollapsed?.(ARCHIVED_GROUP_KEY)
      const repo = repos.find((r) => r.name === repoName)
      if (repo) return onToggleCollapsed?.(repo.path)
    },
    [repos, onToggleCollapsed]
  )

  const active = sessions.find((s) => s.id === selected) ?? null
  // `renderConversation` is passed straight down now. It used to be wrapped in a
  // closure that baked in the single active session; each SessionPane calls it
  // with its OWN session, which is what lets the grid render several at once.
  //
  // The empty state is for an empty WORKSPACE, never merely an empty pane. A
  // split always has a session in every pane — closing the last one is what
  // leaves no group at all, and that is the only thing the first-launch screen
  // should answer to.
  const showEmpty = Boolean(renderConversation) && group === null

  // Which pane each ON-SCREEN session sits in, for the sidebar's numbered badges.
  // Only the active group is badged: those are the panes the numbers refer to,
  // and the ⌃⇧1..4 shortcuts below address exactly the same set.
  const paneBySession = useMemo(() => {
    const map = new Map<string, number>()
    group?.panes.forEach((p, i) => map.set(p.sessionId, i))
    return map
  }, [group])

  /** Merge a session into the active group at `at` — a drop, or ⌃⇧=. */
  const splitActiveWith = useCallback(
    (sessionId: string, at: number) => {
      if (group) split.splitInto(group.id, sessionId, at)
    },
    [group, split]
  )

  /**
   * Add a pane holding the first session not already on screen.
   *
   * Arc splits with a new tab; the nearest thing here is a session you have but
   * aren't looking at, which beats opening a pane onto nothing.
   *
   * ONE definition for the two ways to ask — ⌃⇧= and the ghost panel on the
   * right edge. They had a copy each, so a change of policy (most-recently-
   * active rather than first, say) would have had to be made twice to be made
   * at all, and the two controls would have quietly started doing different
   * things.
   *
   * Reports whether it added, because the keyboard path needs to know: a chord
   * that could not act should fall through rather than be swallowed.
   */
  const addNextSessionAsPane = useCallback((): boolean => {
    if (!group || group.panes.length >= MAX_PANES) return false
    const next = sessions.find((s) => !s.archived && !split.visibleSessionIds.has(s.id))
    if (!next) return false
    splitActiveWith(next.id, group.panes.length)
    return true
  }, [group, sessions, split, splitActiveWith])

  // ⌘N opens New Session; the rest is Arc's split map. Which chord means what is
  // `matchSplitShortcut`'s job — a pure function, and its own unit test, because
  // the first version of this map compared `e.key` against unshifted characters
  // and so could never fire for ⌃⇧1..4 or ⌃⇧[ / ⌃⇧] (Shift makes those "!" and
  // "{"). What is left here is only the part that needs the app's state: whether
  // the thing the chord asked for is possible right now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = matchSplitShortcut(e)
      if (shortcut === null) return

      switch (shortcut.type) {
        case "new-session": {
          if (!onCreateSession) return
          e.preventDefault()
          setNewOpen(true)
          return
        }
        // Swallow the chord only if it actually added a pane — at the cap, or
        // with every session already on screen, ⌃⇧= has nothing to do and
        // shouldn't pretend otherwise.
        case "add-pane": {
          if (addNextSessionAsPane()) e.preventDefault()
          return
        }
        // Out-of-range is a no-op rather than a clamp: ⌃⇧4 in a two-pane split
        // means "the fourth pane", and there isn't one.
        case "focus-pane": {
          if (!group || shortcut.index >= group.panes.length) return
          e.preventDefault()
          split.focusPane(group.id, shortcut.index)
          return
        }
        // Stops at the ends (the reducer refuses to wrap): wrapping from the
        // last pane to the first reads as a jump, and in a two-pane split it
        // makes the two keys indistinguishable.
        case "focus-neighbour": {
          if (!group) return
          e.preventDefault()
          split.focusNeighbour(shortcut.direction)
          return
        }
        case "move-pane": {
          if (!group) return
          e.preventDefault()
          split.moveFocused(shortcut.direction)
          return
        }
        // The session keeps running; this closes the VIEW of it.
        case "close-pane": {
          if (!group || group.panes.length <= 1) return
          e.preventDefault()
          split.closeFocused()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCreateSession, group, split, addNextSessionAsPane])

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

  const handleCreateFromIssue = useCallback(
    async (input: CreateSessionFromIssueInput) => {
      if (!onCreateSessionFromIssue) return
      const session = await onCreateSessionFromIssue(input)
      setSelected(session.id)
    },
    [onCreateSessionFromIssue]
  )

  return (
    // No layout picker in the title bar any more: the shape of the split is a
    // consequence of what you dragged where, not a mode you pick up front.
    <AppShell title="Starbase">
      <SessionConversation
        sessions={sessions}
        clis={clis}
        activeSessionId={selected}
        onSelectSession={setSelected}
        group={group}
        splitGroups={split.workspace.groups}
        activeGroupId={split.workspace.activeGroupId}
        onFocusPane={(index) => group && split.focusPane(group.id, index)}
        onFocusGroupPane={(groupId, index) => {
          // A sidebar segment belongs to a group that may not be on screen, so
          // showing it is part of focusing it.
          split.activateGroup(groupId)
          split.focusPane(groupId, index)
        }}
        onSplitWith={splitActiveWith}
        onSplitGroupWith={split.splitInto}
        onReplacePane={(index, sessionId) => {
          // One reducer, not close-then-insert: group ids derive from the
          // leftmost pane, so closing pane 0 re-ids the group and the second
          // call would look up an id that no longer exists.
          if (!group) return
          if (group.panes.length === 1) return setSelected(sessionId)
          split.replacePane(group.id, index, sessionId)
        }}
        onClosePane={(index) => group && split.closePane(group.id, index)}
        onCloseGroupPane={split.closePane}
        onMovePane={(index, direction) => group && split.movePane(group.id, index, direction)}
        onSeparateAll={split.separateAll}
        onResizePane={(index, delta) => group && split.resizePane(group.id, index, delta)}
        onAddSplit={() => {
          addNextSessionAsPane()
        }}
        slotBySession={paneBySession}
        onRenameSession={onRenameSession}
        onArchiveSession={onArchiveSession}
        onRestoreSession={onRestoreSession}
        onDeleteSession={onDeleteSession}
        renderConversation={renderConversation}
        planSessions={planSessions}
        showEmpty={showEmpty}
        patch={patch}
        liveActivity={liveActivity}
        prStates={prStates}
        liveDiff={liveDiff}
        onNewSession={onCreateSession ? () => setNewOpen(true) : undefined}
        user={user}
        onSignOut={onSignOut}
        onOpenUsage={onLoadUsage ? openUsage : undefined}
        onOpenSettings={onSaveProvider ? () => setSettingsOpen(true) : undefined}
        settingsView={
          settingsOpen && onSaveProvider ? (
            <SettingsView
              clis={clis}
              providers={providersConfig}
              onSaveProvider={onSaveProvider}
              catalog={modelCatalog}
              orchestrator={orchestrator}
              onSaveOrchestrator={onSaveOrchestrator}
              gigaplanUnavailableReason={gigaplanUnavailableReason}
              billing={billing}
              loadModels={loadModels ?? (async () => [])}
              loadOpencodeProviders={loadOpencodeProviders}
              onSetOpencodeAuth={onSetOpencodeAuth}
              loadMcpServers={loadMcpServers}
              loadMcpStatus={loadMcpStatus}
              ghStatus={ghStatus ?? GH_UNAVAILABLE}
              github={githubConfig}
              git={gitConfig}
              rechecking={ghRechecking}
              onRecheck={onRecheckGh ? handleRecheckGh : undefined}
              context={contextConfig}
              onSaveContext={onSaveContextConfig}
              contextSessions={contextSessions}
              onSaveGithub={onSaveGithubConfig}
              onSaveGit={onSaveGitConfig}
              notifications={notificationsConfig}
              onSaveNotifications={onSaveNotificationsConfig}
              planAutoRun={planAutoRun}
              onSavePlanAutoRun={onSavePlanAutoRun}
              onClose={() => setSettingsOpen(false)}
            />
          ) : undefined
        }
        ghConnected={ghConnected}
        starredRepoNames={starredRepoNames}
        onToggleStar={onToggleStar ? toggleStarByName : undefined}
        collapsedRepoNames={collapsedRepoNames}
        onToggleCollapsed={onToggleCollapsed ? toggleCollapsedByName : undefined}
        renderPullRequest={renderPullRequest}
        renderReview={renderReview}
        renderCode={renderCode}
        renderIssue={renderIssue}
        renderTerminalDock={renderTerminalDock}
        terminalDockSide={terminalDockSide}
        renderBrowserDock={renderBrowserDock}
        browserDockSide={browserDockSide}
        onToggleBrowser={onToggleBrowser}
        browserActive={browserActive}
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
          loadIssues={loadIssues}
          onCreateFromIssue={onCreateSessionFromIssue ? handleCreateFromIssue : undefined}
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
