import { useState } from "react"
import type { CliInfo, Message, Session } from "@starbase/core"
import { AppShell } from "./app-shell.js"
import { SessionConversation } from "../screens/session-conversation.js"
import { SEED_CONVERSATION, SEED_PATCH } from "../seed.js"

export interface StarbaseAppProps {
  clis: ReadonlyArray<CliInfo>
  sessions: ReadonlyArray<Session>
  activeSessionId?: string | null
  messages?: ReadonlyArray<Message>
  patch?: string
}

/**
 * The product shell — the whole Starbase window, data-driven. The desktop
 * renderer feeds it `clis`/`sessions` fetched over Effect RPC.
 */
export function StarbaseApp({
  clis,
  sessions,
  activeSessionId,
  messages = SEED_CONVERSATION,
  patch = SEED_PATCH
}: StarbaseAppProps) {
  const [selected, setSelected] = useState<string | null>(
    activeSessionId ?? sessions[0]?.id ?? null
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
      />
    </AppShell>
  )
}
