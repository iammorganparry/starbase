import { useState } from "react"
import type { CliInfo, GhStatus, Message, Session } from "@starbase/core"
import { SessionSidebar } from "../app/session-sidebar.js"
import { TabBar, type TabKey } from "../app/tab-bar.js"
import { ConversationView } from "../app/conversation-view.js"
import { DiffPanel } from "../app/diff-panel.js"
import { TerminalPanel } from "../app/terminal-panel.js"
import { StubScreen } from "./stub-screen.js"

export interface SessionConversationProps {
  sessions: ReadonlyArray<Session>
  clis: ReadonlyArray<CliInfo>
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  messages: ReadonlyArray<Message>
  /** Unified-diff patch for the Changes rail. */
  patch: string
  /** GitHub CLI status for the harnesses strip. */
  ghStatus?: GhStatus
  /** Open the New Session dialog. */
  onNewSession?: () => void
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
      />

      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        <TabBar
          active={tab}
          onChange={setTab}
          status={active?.status === "thinking" ? { label: "Thinking", tone: "yellow" } : undefined}
          cost={active ? `${Math.round(active.tokens / 1000)}k · $${active.costUsd.toFixed(2)}` : undefined}
        />

        {tab === "conversation" ? (
          <>
            <div className="flex min-h-0 flex-1">
              <ConversationView messages={props.messages} />
              <DiffPanel patch={props.patch} added={21} removed={5} />
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
