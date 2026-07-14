import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CliInfo, Session } from "@starbase/core"
import { ComponentLibrary } from "./component-library.js"
import { LoginScreen } from "./login-screen.js"
import { StarbaseApp } from "../app/starbase-app.js"

const noop = () => {}

const meta: Meta = { title: "Screens", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const clis: ReadonlyArray<CliInfo> = [
  { kind: "claude", label: "Claude Code", binPath: "/usr/local/bin/claude", version: "1.0.0", available: true },
  { kind: "codex", label: "Codex CLI", binPath: null, version: null, available: false },
  { kind: "cursor", label: "Cursor Agent", binPath: "/usr/local/bin/cursor-agent", version: "0.4.2", available: true }
]

const sessions: ReadonlyArray<Session> = [
  { id: "s1", repo: "trigify/api", branch: "feat/oauth", title: "Refactor auth flow", status: "thinking", cli: "claude", diff: { added: 313, removed: 23 }, prNumber: 482, costUsd: 1.24, tokens: 218000, updatedAt: "2026-07-11T09:41:00Z" },
  { id: "s2", repo: "trigify/api", branch: "chore/deps", title: "Bump dependencies", status: "idle", cli: "claude", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0.12, tokens: 14200, updatedAt: "2026-07-11T08:12:00Z" },
  { id: "s3", repo: "trigify/web", branch: "main", title: "Fix flaky tests", status: "needs-input", cli: "codex", diff: { added: 47, removed: 9 }, prNumber: null, costUsd: 0.44, tokens: 61800, updatedAt: "2026-07-11T09:05:00Z" }
]

export const Library: Story = {
  render: () => <ComponentLibrary />
}

export const App: Story = {
  render: () => (
    <div className="h-screen w-full">
      <StarbaseApp clis={clis} sessions={sessions} />
    </div>
  )
}

const loginProps = {
  onGithub: noop,
  onGoogle: noop,
  onSendMagicLink: noop,
  onReset: noop
}

/** The sign-in wall, one story per state (matches Login.dc.html). */
export const Login: Story = {
  render: () => (
    <div className="h-screen w-full">
      <LoginScreen state="default" {...loginProps} />
    </div>
  )
}

export const LoginLoading: Story = {
  render: () => (
    <div className="h-screen w-full">
      <LoginScreen state="loading" {...loginProps} />
    </div>
  )
}

export const LoginSent: Story = {
  render: () => (
    <div className="h-screen w-full">
      <LoginScreen state="sent" sentEmail="founder@example.com" {...loginProps} />
    </div>
  )
}

export const LoginError: Story = {
  render: () => (
    <div className="h-screen w-full">
      <LoginScreen state="error" {...loginProps} />
    </div>
  )
}
