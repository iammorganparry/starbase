import type { Meta, StoryObj } from "@storybook/react-vite"
import { ToolCall } from "./tool-call.js"
import { ThoughtBlock } from "./thought-block.js"
import { PhaseNode } from "./phase-node.js"
import { AgentCard } from "./agent-card.js"
import { ApprovalGate } from "./approval-gate.js"
import { SlashCommandRow } from "./slash-command-row.js"
import { McpServerRow } from "./mcp-server-row.js"
import { Composer } from "./composer.js"
import { Callout } from "../components/callout.js"

const meta: Meta = { title: "Molecules/Overview" }
export default meta
type Story = StoryObj

export const ToolCalls: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <ToolCall status="success" name="Read" target="billing.ts" meta="142" />
      <ToolCall status="running" name="Grep" target="TODO" />
      <ToolCall status="error" name="Bash" target="build" meta="exit 1" />
    </div>
  )
}

export const Thought: Story = {
  render: () => (
    <div className="w-80">
      <ThoughtBlock seconds={6} defaultOpen>
        Reasoning summary, dim &amp; collapsible.
      </ThoughtBlock>
    </div>
  )
}

export const Phases: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <PhaseNode index="02" title="Audit" state="active" hint="viewing" counts="5✓ 6● 1✗" />
      <PhaseNode index="03" title="Verify" state="pending" />
    </div>
  )
}

export const Agents: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <AgentCard file="billing.ts" state="working" tokens="31k" status="reading middleware…" />
      <AgentCard file="api-keys.ts" state="flagged" status="⚠ 2 findings" />
    </div>
  )
}

export const Callouts: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <Callout tone="yellow">Large workflow — 26 agents.</Callout>
      <Callout tone="green">Verified by a reviewer.</Callout>
    </div>
  )
}

export const Approval: Story = {
  render: () => (
    <div className="w-[456px]">
      <ApprovalGate command="npm test -- billing" />
    </div>
  )
}

export const Rows: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <SlashCommandRow name="review" description="Review the current diff" badge="built-in" active />
      <McpServerRow name="Linear" transport="stdio" meta="6 tools · project" />
    </div>
  )
}

export const ComposerStory: Story = {
  name: "Composer",
  render: () => (
    <div className="w-[456px]">
      <Composer />
    </div>
  )
}
