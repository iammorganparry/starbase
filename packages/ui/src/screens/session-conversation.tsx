import { type ReactNode, useState } from "react"
import type { CliInfo, GhStatus, Session } from "@starbase/core"
import { SessionSidebar } from "../app/session-sidebar.js"
import { TabBar, type TabKey } from "../app/tab-bar.js"
import { ConversationView } from "../app/conversation-view.js"
import { TerminalPanel } from "../app/terminal-panel.js"
import { SEED_CONVERSATION } from "../seed.js"
import { EmptyConversation } from "./empty-conversation.js"
import { StubScreen } from "./stub-screen.js"

export interface SessionConversationProps {
  sessions: ReadonlyArray<Session>
  clis: ReadonlyArray<CliInfo>
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  /**
   * The live conversation pane (the renderer's session-keyed
   * `ConversationView`). Falls back to a static seeded transcript when absent
   * (stories / standalone).
   */
  conversationPane?: ReactNode
  /**
   * Show the empty state instead of a transcript — the real app sets this when
   * no session is active (first launch), so the seeded demo never renders.
   */
  showEmpty?: boolean
  /** Unified-diff patch for the Changes rail. */
  patch: string
  /** GitHub CLI status for the harnesses strip. */
  ghStatus?: GhStatus
  /** Open the New Session dialog. */
  onNewSession?: () => void
  /** App version, shown in the sidebar footer. */
  version?: string
}

/** Screen 01 — the primary session workspace. */
export function SessionConversation(props: SessionConversationProps) {
  const [tab, setTab] = useState<TabKey>("conversation")
  const active = props.sessions.find((s) => s.id === props.activeSessionId) ?? null

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar
        sessions={props.sessions}
        clis={props.clis}
        activeSessionId={props.activeSessionId}
        onSelect={props.onSelectSession}
        ghStatus={props.ghStatus}
        onNewSession={props.onNewSession}
        version={props.version}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        <TabBar
          active={tab}
          onChange={setTab}
          prNumber={active?.prNumber ?? null}
          status={active?.status === "thinking" ? { label: "Thinking", tone: "yellow" } : undefined}
          cost={active ? `${Math.round(active.tokens / 1000)}k · $${active.costUsd.toFixed(2)}` : undefined}
        />

        {props.showEmpty ? (
          <EmptyConversation
            clis={props.clis}
            version={props.version}
            onNewSession={props.onNewSession}
          />
        ) : tab === "conversation" ? (
          <>
            <div className="flex min-h-0 flex-1">
              {props.conversationPane ?? (
                <ConversationView messages={SEED_CONVERSATION} mode="accept-edits" patch={props.patch} />
              )}
            </div>
            <TerminalPanel />
          </>
        ) : (
          <StubScreen tab={tab} />
        )}
      </div>
    </div>
  )
}
