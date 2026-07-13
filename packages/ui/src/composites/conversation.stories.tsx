import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Attachment, Message } from "@starbase/core"
import { SEED_CONVERSATION } from "../seed.js"
import { CodeChip } from "../components/code-chip.js"
import { DiffPeek } from "../components/diff-peek.js"
import { FileIcon } from "../components/file-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { Composer } from "./composer.js"
import { MessageTurn } from "./message-turn.js"
import { ModeSwitch } from "./mode-switch.js"
import { ToolCall } from "./tool-call.js"

const meta: Meta = { title: "Conversation/Overview" }
export default meta
type Story = StoryObj

/** A tiny inline PNG so the attachment stories render without external assets. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const img = (name: string): Attachment => ({ id: name, name, mediaType: "image/png", data: PNG })

/** A user turn that attached two screenshots as context, plus a line of text. */
const USER_TURN_WITH_IMAGES: Message = {
  id: "u_img",
  role: "user",
  streaming: false,
  createdAt: "2026-07-13T10:00:00.000Z",
  parts: [
    { _tag: "Image", attachment: img("login-500.png") },
    { _tag: "Image", attachment: img("stacktrace.png") },
    { _tag: "Text", text: "Here's the failing screen and the stack trace — the token refresh 500s." }
  ]
}

export const Transcript: Story = {
  render: () => (
    <div className="flex w-[640px] flex-col gap-6 bg-editor p-6">
      {SEED_CONVERSATION.map((m) => (
        <MessageTurn key={m.id} message={m} />
      ))}
    </div>
  )
}

export const ToolWithDiffPeek: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <ToolCall status="success" name="Edit" filePath="src/routes/billing.ts" target="src/routes/billing.ts" meta="+7 −0">
        <DiffPeek preview={"61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"} />
      </ToolCall>
    </div>
  )
}

export const Modes: Story = {
  render: () => (
    <div className="flex flex-col gap-3 bg-editor p-6">
      <ModeSwitch mode="ask" />
      <ModeSwitch mode="accept-edits" />
      <ModeSwitch mode="auto" paused />
    </div>
  )
}

export const Gates: Story = {
  render: () => (
    <div className="flex w-[560px] flex-col gap-3 bg-editor p-6">
      <ApprovalGate
        kind="command"
        title="Approval needed · run a command"
        detail="Not in your allowlist. Agents never run shell commands until you allow."
        command="npm test -- billing"
        allowLabel="npm test"
        status="pending"
      />
      <ApprovalGate
        kind="edit"
        title="Approval needed · edit refresh.ts"
        detail="Review the change above, then approve to write it to disk."
        status="approved"
      />
    </div>
  )
}

export const Chips: Story = {
  render: () => (
    <div className="flex items-center gap-2 bg-editor p-6">
      <FileIcon path="src/app.tsx" />
      <CodeChip path="src/routes/billing.ts" line={61} />
      <CodeChip path="README.md" onRemove={() => {}} />
    </div>
  )
}

export const ComposerWithMenus: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <Composer
        skills={[
          { name: "/plan", description: "Draft a plan before editing", source: "command" },
          { name: "/deploy", description: "Ship the app to production", source: "skill" }
        ]}
        files={["src/routes/billing.ts", "README.md"]}
        mode="accept-edits"
        model="opus"
        models={[
          { id: "opus", label: "opus" },
          { id: "sonnet", label: "sonnet" }
        ]}
      />
    </div>
  )
}

/**
 * A user turn that attached images as context — the thumbnails render as a row
 * above the text (the transcript side of image attachments).
 */
export const MessageWithImages: Story = {
  render: () => (
    <div className="w-[640px] bg-editor p-6">
      <MessageTurn message={USER_TURN_WITH_IMAGES} />
    </div>
  )
}

/**
 * The composer while the agent is busy: sends are queued rather than blocked, so
 * the button reads "Queue" and the hint invites attaching an image.
 */
export const ComposerBusy: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <Composer
        busy
        mode="accept-edits"
        model="sonnet"
        models={[{ id: "sonnet", label: "sonnet" }]}
      />
    </div>
  )
}
