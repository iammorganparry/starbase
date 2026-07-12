import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CliInfo, GhStatus, PrSummary, Repo } from "@starbase/core"
import { SetupScreen } from "./setup-screen.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { PrPickerList } from "../composites/pr-picker-list.js"

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

const SAMPLE_PRS: ReadonlyArray<PrSummary> = [
  {
    number: 482,
    title: "Fix auth refresh race on cold start",
    headRefName: "chore/bump-version",
    baseRefName: "main",
    author: { login: "octocat", avatarUrl: null },
    state: "open",
    isDraft: false,
    additions: 313,
    deletions: 23,
    updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString()
  },
  {
    number: 471,
    title: "Add per-provider usage window to the Usage modal",
    headRefName: "feat/usage-window",
    baseRefName: "main",
    author: { login: "hubot", avatarUrl: null },
    state: "draft",
    isDraft: true,
    additions: 88,
    deletions: 4,
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString()
  }
]

/** The New Session dialog in "From PR" mode — searchable open-PR picker. */
export const NewSessionFromPr: Story = {
  render: () => (
    <div className="h-screen w-full bg-editor">
      <NewSessionDialog
        open
        onClose={() => {}}
        repos={repos}
        clis={clis}
        loadBranches={loadBranches}
        onCreate={async () => {}}
        loadPrs={async (_repoPath, { mine }) =>
          mine ? SAMPLE_PRS.filter((p) => p.author.login === "octocat") : SAMPLE_PRS
        }
        onCreateFromPr={async () => {}}
      />
    </div>
  )
}

/** The PR picker list in isolation — populated, empty, and loading. */
export const PrPicker: Story = {
  render: () => (
    <div className="flex gap-6 bg-editor p-8">
      <div className="w-[420px] rounded-lg border border-line bg-panel p-3">
        <PrPickerList prs={SAMPLE_PRS} selected={482} onSelect={() => {}} />
      </div>
      <div className="w-[420px] rounded-lg border border-line bg-panel p-3">
        <PrPickerList prs={[]} selected={null} onSelect={() => {}} />
      </div>
      <div className="w-[420px] rounded-lg border border-line bg-panel p-3">
        <PrPickerList prs={[]} selected={null} onSelect={() => {}} loading />
      </div>
    </div>
  )
}
