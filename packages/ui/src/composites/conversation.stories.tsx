import type { Meta, StoryObj } from "@storybook/react-vite"
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
        mode="accept edits"
      />
    </div>
  )
}
