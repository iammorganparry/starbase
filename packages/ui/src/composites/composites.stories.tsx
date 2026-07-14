import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CliInfo, GhStatus, ModelOption, ProvidersConfig } from "@starbase/core"
import { SettingsView } from "./settings-view.js"
import { ToolCall } from "./tool-call.js"
import { ThoughtBlock } from "./thought-block.js"
import { PhaseNode } from "./phase-node.js"
import { AgentCard } from "./agent-card.js"
import { ApprovalGate } from "./approval-gate.js"
import { SlashCommandRow } from "./slash-command-row.js"
import { McpServerRow } from "./mcp-server-row.js"
import { Composer } from "./composer.js"
import { Callout } from "../components/callout.js"
import { TerminalDock, type DockSide, type TerminalTab } from "../app/terminal-panel.js"
import { useState } from "react"

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
      <ApprovalGate
        kind="command"
        title="Approval needed · run a command"
        detail="Not in your allowlist. Agents never run shell commands until you allow."
        command="npm test -- billing"
        allowLabel="npm test"
        status="pending"
      />
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

const DEMO_CLIS: ReadonlyArray<CliInfo> = [
  { kind: "claude", label: "Claude Code", binPath: "/usr/local/bin/claude", version: "1.4.2", available: true },
  { kind: "codex", label: "Codex", binPath: "/usr/local/bin/codex", version: "0.9.0", available: true },
  { kind: "cursor", label: "Cursor Agent", binPath: null, version: null, available: false }
]

const DEMO_PROVIDERS: ProvidersConfig = {
  claude: { enabled: true, defaultMode: "plan", defaultModel: "sonnet", reasoningEffort: "think-hard" },
  codex: { enabled: true, defaultMode: "accept-edits", defaultModel: "gpt-5-codex" }
}

const DEMO_GH: GhStatus = {
  available: true,
  authenticated: true,
  login: "morganparry",
  host: "github.com",
  version: "2.55.0"
}

const DEMO_MODELS: Record<string, ReadonlyArray<ModelOption>> = {
  claude: [
    { id: "opus", label: "Opus 4.1" },
    { id: "sonnet", label: "Sonnet 4.5" },
    { id: "haiku", label: "Haiku 4.5" }
  ],
  codex: [{ id: "gpt-5-codex", label: "gpt-5-codex" }],
  cursor: []
}

const DEMO_TABS: ReadonlyArray<TerminalTab> = [
  { id: "t1", title: "zsh", status: "running" },
  { id: "t2", title: "node", status: "idle" },
  { id: "t3", title: "bash", status: "exited" }
]

/** Interactive dock: flip sides, toggle visibility, switch tabs — exercises the
 * chrome/state seams (the live PTY cell is faked with a static block). */
function TerminalDockDemo() {
  const [dock, setDock] = useState<DockSide>("bottom")
  const [visible, setVisible] = useState(true)
  const [activeId, setActiveId] = useState<string | null>("t1")
  return (
    <div className="relative flex h-[560px] w-[1100px] overflow-hidden rounded-lg border border-line bg-editor">
      <div className="flex-1 p-4 text-sm text-ink-dim">
        Session workspace · dock is {dock}, {visible ? "visible" : "hidden"}
        <button className="ml-3 rounded border border-line px-2 py-0.5" onClick={() => setVisible((v) => !v)}>
          toggle (⌃`)
        </button>
      </div>
      <TerminalDock
        dock={dock}
        onDockChange={setDock}
        visible={visible}
        onToggle={() => setVisible(false)}
        tabs={DEMO_TABS}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => {}}
        onClose={() => {}}
        cwdLabel="~/repos/starbase"
        lastExit={0}
        renderTerminal={(id) => (
          <div className="h-full w-full p-3 font-mono text-xs text-ink">
            $ terminal cell for {id}
          </div>
        )}
      />
    </div>
  )
}

export const Terminal: Story = {
  name: "Terminal Dock",
  render: () => <TerminalDockDemo />
}

export const Settings: Story = {
  name: "Settings · Providers (E10)",
  render: () => (
    <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
      <SettingsView
        clis={DEMO_CLIS}
        providers={DEMO_PROVIDERS}
        onSaveProvider={() => {}}
        loadModels={async (cli) => DEMO_MODELS[cli] ?? []}
        ghStatus={DEMO_GH}
        github={{ enabled: true, autoCreatePr: false, autoDetectPr: true }}
        git={{ shareCheckedOutBranches: true }}
        onSaveGithub={() => {}}
        onSaveGit={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}
