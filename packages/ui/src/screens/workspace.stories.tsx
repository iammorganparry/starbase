import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CliInfo, GhStatus, Repo } from "@starbase/core"
import { SetupScreen } from "./setup-screen.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"

const meta: Meta = { title: "Workspace", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const clis: ReadonlyArray<CliInfo> = [
  { kind: "claude", label: "Claude Code", binPath: "/usr/local/bin/claude", version: "2.1.0", available: true },
  { kind: "codex", label: "Codex CLI", binPath: "/usr/local/bin/codex", version: "0.13.0", available: true },
  { kind: "cursor", label: "Cursor Agent", binPath: null, version: null, available: false }
]

const ghAuthed: GhStatus = {
  available: true,
  authenticated: true,
  login: "iammorganparry",
  host: "github.com",
  version: "2.68.1"
}

const ghMissing: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

const repos: ReadonlyArray<Repo> = [
  { name: "trigify-app", path: "/Users/m/repos/trigify-app", defaultBranch: "main", currentBranch: "main", remoteUrl: "git@github.com:trigify/trigify-app.git", githubSlug: "trigify/trigify-app" },
  { name: "gtm-grid", path: "/Users/m/repos/gtm-grid", defaultBranch: "main", currentBranch: "feat/scoring", remoteUrl: "git@github.com:trigify/gtm-grid.git", githubSlug: "trigify/gtm-grid" },
  { name: "athena", path: "/Users/m/repos/athena", defaultBranch: "main", currentBranch: "main", remoteUrl: null, githubSlug: null },
  { name: "eland", path: "/Users/m/repos/eland", defaultBranch: "master", currentBranch: "master", remoteUrl: "git@github.com:trigify/eland.git", githubSlug: "trigify/eland" }
]

/** First run — no directory chosen yet; harnesses + gh status shown. */
export const SetupFirstRun: Story = {
  render: () => (
    <SetupScreen clis={clis} ghStatus={ghAuthed} onChooseDir={() => {}} onContinue={() => {}} />
  )
}

/** First run when the GitHub CLI is not installed (non-blocking notice). */
export const SetupGhMissing: Story = {
  render: () => (
    <SetupScreen clis={clis} ghStatus={ghMissing} onChooseDir={() => {}} onContinue={() => {}} />
  )
}

/** After choosing a folder — scanned repos summary + Get started. */
export const SetupChosen: Story = {
  render: () => (
    <SetupScreen
      clis={clis}
      ghStatus={ghAuthed}
      reposDir="/Users/morganparry/repos"
      repos={repos}
      onChooseDir={() => {}}
      onContinue={() => {}}
    />
  )
}

const loadBranches = async (): Promise<ReadonlyArray<string>> => [
  "main",
  "develop",
  "feat/scoring",
  "chore/deps"
]

/** The ⌘N New Session dialog (shadcn Dialog + Select + Input). */
export const NewSession: Story = {
  render: () => (
    <div className="h-screen w-full bg-editor">
      <NewSessionDialog
        open
        onClose={() => {}}
        repos={repos}
        clis={clis}
        loadBranches={loadBranches}
        onCreate={async () => {}}
      />
    </div>
  )
}
