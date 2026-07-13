import { useMemo, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Message, QuestionAnswer, QuestionRequest } from "@starbase/core"
import { pendingQuestion, setQuestionAnswers } from "@starbase/core"
import { ConversationView } from "../app/conversation-view.js"

/**
 * A realistic recreation of the agent asking a question mid-turn: the assistant
 * pauses, the `QuestionCard` docks in place of the composer, and answering it
 * resolves the question + resumes the transcript — exactly the live flow, so we
 * can iterate on the component and the answer round-trip without a real agent.
 */

const REQUEST: QuestionRequest = {
  id: "q_ask_1",
  questions: [
    {
      question: "Which token strategy should the store use?",
      header: "Strategy",
      multiSelect: false,
      options: [
        {
          label: "Rotating refresh",
          description: "A new refresh token on every use — most secure, needs replay handling.",
          preview: "refresh() -> { access, refresh }\nstore.rotate(refresh)  // old token revoked"
        },
        {
          label: "Sliding session",
          description: "Extend expiry on activity; a single long-lived token.",
          preview: "session.touch()  // bump expiry\n// one token, no rotation"
        },
        {
          label: "Short access + refresh",
          description: "15-min access, 7-day refresh. The common default.",
          preview: "access: 15m\nrefresh: 7d"
        }
      ]
    },
    {
      question: "Which surfaces should adopt the new store?",
      header: "Surfaces",
      multiSelect: true,
      options: [
        { label: "HTTP middleware", description: "The Express session guard on the API." },
        { label: "WebSocket handshake", description: "Auth on the realtime channel." },
        { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
      ]
    }
  ]
}

const now = "2026-07-12T10:00:00.000Z"

const initialMessages: ReadonlyArray<Message> = [
  { id: "u1", role: "user", streaming: false, createdAt: now, parts: [{ _tag: "Text", text: "Refactor the auth flow to a dedicated TokenStore." }] },
  {
    id: "a1",
    role: "assistant",
    streaming: false,
    createdAt: now,
    parts: [
      { _tag: "Thinking", text: "Before I plan this I need a couple of decisions from the operator.", seconds: 3, streaming: false },
      { _tag: "Text", text: "Before I put a plan together, I need a couple of decisions so it's actually useful." },
      // The interactive part lives in the transcript (as the real agent produces
      // it); while unanswered it docks in the composer, and once answered it
      // renders inline as a QuestionSummary — the record of what was picked.
      { _tag: "Question", request: REQUEST, answers: null }
    ]
  }
]

/** Answering the docked question records the picks on the Question part in place. */
function AskFlow() {
  const [messages, setMessages] = useState<ReadonlyArray<Message>>(initialMessages)
  const question = useMemo(() => pendingQuestion(messages), [messages])

  const onAnswerQuestion = (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => {
    setMessages((prev) => {
      const answered = prev.map((m) => setQuestionAnswers(m, requestId, answers))
      return [
        ...answered,
        {
          id: "a2",
          role: "assistant" as const,
          streaming: false,
          createdAt: now,
          parts: [{ _tag: "Text" as const, text: "Got it — mapping out the plan now." }]
        }
      ]
    })
  }

  return (
    <div className="flex h-[640px] w-full bg-editor">
      <ConversationView
        messages={messages}
        mode="plan"
        cli="claude"
        question={question}
        onAnswerQuestion={onAnswerQuestion}
        onSend={() => {}}
      />
    </div>
  )
}

const meta: Meta = { title: "AskUserQuestion/In Conversation" }
export default meta
type Story = StoryObj

export const DockedAndAnswerable: Story = { render: () => <AskFlow /> }
