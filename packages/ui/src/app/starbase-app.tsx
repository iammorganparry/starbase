import { useCallback, useEffect, useState } from "react"
import type {
  CliInfo,
  CreateSessionInput,
  GhStatus,
  Message,
  Repo,
  Session
} from "@starbase/core"
import { AppShell } from "./app-shell.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { SessionConversation } from "../screens/session-conversation.js"
import { SEED_CONVERSATION, SEED_PATCH } from "../seed.js"

export interface StarbaseAppProps {
  clis: ReadonlyArray<CliInfo>
  sessions: ReadonlyArray<Session>
  /** Repos discovered under the workspace, for the New Session picker. */
  repos?: ReadonlyArray<Repo>
  /** GitHub CLI status for the harnesses strip. */
  ghStatus?: GhStatus
  activeSessionId?: string | null
  messages?: ReadonlyArray<Message>
  patch?: string
  /** Load branch names for a repo (New Session base picker). */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Create a session (forks a real worktree) and return it. */
  onCreateSession?: (input: CreateSessionInput) => Promise<Session>
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
  activeSessionId,
  messages = SEED_CONVERSATION,
  patch = SEED_PATCH,
  loadBranches = noBranches,
  onCreateSession,
  version
}: StarbaseAppProps) {
  const [selected, setSelected] = useState<string | null>(
    activeSessionId ?? sessions[0]?.id ?? null
  )
  const [newOpen, setNewOpen] = useState(false)

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

  return (
    <AppShell title="Starbase">
      <SessionConversation
        sessions={sessions}
        clis={clis}
        activeSessionId={selected}
        onSelectSession={setSelected}
        messages={messages}
        patch={patch}
        ghStatus={ghStatus}
        onNewSession={onCreateSession ? () => setNewOpen(true) : undefined}
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
        />
      )}
    </AppShell>
  )
}
