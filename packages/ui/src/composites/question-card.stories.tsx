import type { Meta, StoryObj } from "@storybook/react-vite"
import type { QuestionRequest } from "@starbase/core"
import { QuestionCard } from "./question-card.js"

const meta: Meta = { title: "AskUserQuestion" }
export default meta
type Story = StoryObj

const request: QuestionRequest = {
  id: "q1",
  questions: [
    {
      question: "Which token strategy should the store use?",
      header: "Strategy",
      multiSelect: false,
      options: [
        { label: "Rotating refresh tokens", description: "New refresh token on every use — most secure." },
        { label: "Sliding session", description: "Extend expiry on activity, single long-lived token." },
        { label: "Short-lived access + refresh", description: "15-min access, 7-day refresh. The common default." }
      ]
    },
    {
      question: "Which surfaces should adopt the new store?",
      header: "Surfaces",
      multiSelect: true,
      options: [
        { label: "HTTP middleware", description: "Express session guard on the API." },
        { label: "WebSocket handshake", description: "Auth on the realtime channel." },
        { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
      ]
    }
  ]
}

/** The docked question card — walk single- then multi-select, or type an Other answer. */
export const Docked: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-8">
      <QuestionCard request={request} onSubmit={(a) => console.log("answers", a)} />
    </div>
  )
}
