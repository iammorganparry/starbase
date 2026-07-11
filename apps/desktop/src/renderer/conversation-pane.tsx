/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView`. Mounted keyed by session id (see `StarbaseApp`), so each
 * session drives its own machine instance.
 */
import type { Session } from "@starbase/core"
import { ConversationView } from "@starbase/ui"
import { useConversation } from "./use-conversation.js"

export function ConversationPane({ session }: { session: Session }) {
  const convo = useConversation(session)
  return (
    <ConversationView
      messages={convo.messages}
      mode={convo.mode}
      cli={session.cli}
      skills={convo.skills}
      files={convo.files}
      patch={convo.patch}
      paused={convo.paused}
      model={convo.model}
      models={convo.models}
      onSetModel={convo.setModel}
      onSend={convo.sendPrompt}
      onDecideGate={convo.decideGate}
      onSetMode={convo.setMode}
    />
  )
}
