import { useEffect, useState } from "react"
import type { GhStatus, GitConfig, GithubConfig } from "@starbase/core"
import { Check, Copy, GitBranch, RefreshCw, Settings } from "lucide-react"
import { cn } from "../lib/cn.js"
import { GithubMark } from "../components/github-mark.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"

const DEFAULT_GITHUB: GithubConfig = { enabled: false, autoCreatePr: false, autoDetectPr: true }
const DEFAULT_GIT: GitConfig = { shareCheckedOutBranches: true }

const LOGIN_CMD = "gh auth login"

const sameGithub = (a: GithubConfig, b: GithubConfig): boolean =>
  a.enabled === b.enabled && a.autoCreatePr === b.autoCreatePr && a.autoDetectPr === b.autoDetectPr

const sameGit = (a: GitConfig, b: GitConfig): boolean =>
  a.shareCheckedOutBranches === b.shareCheckedOutBranches

/** One labelled toggle row (label + description on the left, switch on the right). */
function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">{label}</div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">{description}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

/**
 * The Settings view. Currently one section — the GitHub integration: read-only
 * `gh` connection status plus the PR preferences. `gh auth login` is interactive
 * and runs in the user's own terminal, so the section offers a copy-command +
 * Recheck rather than an in-app OAuth flow.
 */
export function SettingsDialog({
  open,
  ghStatus,
  github,
  git,
  rechecking = false,
  onRecheck,
  onSaveGithub,
  onSaveGit,
  onClose
}: {
  open: boolean
  ghStatus: GhStatus
  github?: GithubConfig | null
  git?: GitConfig | null
  /** A `gh auth status` recheck is in flight. */
  rechecking?: boolean
  onRecheck?: () => void
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
  onClose?: () => void
}) {
  const initial = github ?? DEFAULT_GITHUB
  const initialGit = git ?? DEFAULT_GIT
  const [draft, setDraft] = useState<GithubConfig>(initial)
  const [gitDraft, setGitDraft] = useState<GitConfig>(initialGit)
  const [copied, setCopied] = useState(false)

  // Re-seed the form from the persisted config each time the view opens.
  useEffect(() => {
    if (open) {
      setDraft(github ?? DEFAULT_GITHUB)
      setGitDraft(git ?? DEFAULT_GIT)
      setCopied(false)
    }
  }, [open, github, git])

  const connected = ghStatus.available && ghStatus.authenticated
  const githubDirty = !sameGithub(draft, initial)
  const gitDirty = !sameGit(gitDraft, initialGit)
  const dirty = githubDirty || gitDirty

  const save = () => {
    if (githubDirty) onSaveGithub?.(draft)
    if (gitDirty) onSaveGit?.(gitDraft)
    onClose?.()
  }

  const copyLogin = () => {
    void navigator.clipboard?.writeText(LOGIN_CMD).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <Settings size={16} className="text-muted-foreground" />
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 py-4">
          {/* GitHub section */}
          <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
            <GithubMark size={14} className="text-text-bright" />
            <span className="text-[13px] font-semibold text-text-bright">GitHub</span>
          </div>

          {/* Connection status */}
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
            <StatusDot
              tone={connected ? "bg-green" : ghStatus.available ? "bg-yellow" : "bg-line-strong"}
              size={8}
              glow={connected}
            />
            <div className="flex-1">
              <div className="text-[12.5px] font-medium text-text-body">
                {connected
                  ? `Connected as @${ghStatus.login ?? "user"}`
                  : ghStatus.available
                    ? "GitHub CLI not authenticated"
                    : "GitHub CLI not installed"}
              </div>
              {connected && ghStatus.host && (
                <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                  {ghStatus.host}
                  {ghStatus.version ? ` · gh ${ghStatus.version}` : ""}
                </div>
              )}
            </div>
            {onRecheck && (
              <Button variant="secondary" size="sm" onClick={onRecheck} disabled={rechecking}>
                <RefreshCw size={12} className={cn(rechecking && "animate-spin")} />
                Recheck
              </Button>
            )}
          </div>

          {/* Connect instructions when not authenticated */}
          {!connected && (
            <Callout tone="blue">
              {ghStatus.available ? (
                <>
                  Sign in from your terminal, then Recheck. Run:
                  <span className="mt-2 flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-canvas px-2 py-1 font-mono text-[11.5px] text-text">
                      {LOGIN_CMD}
                    </code>
                    <button
                      type="button"
                      onClick={copyLogin}
                      aria-label="Copy command"
                      className="flex size-6 items-center justify-center rounded-md border border-line text-muted-foreground transition-colors hover:bg-surface hover:text-text"
                    >
                      {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />}
                    </button>
                  </span>
                </>
              ) : (
                <>
                  Install the GitHub CLI (<span className="font-mono text-text">brew install gh</span>
                  ), then Recheck. Pull-request features need it.
                </>
              )}
            </Callout>
          )}

          {/* Preferences */}
          <div className="divide-y divide-hairline">
            <ToggleRow
              label="Enable pull-request features"
              description="Show the Pull Request & Code Review tabs and allow posting reviews to GitHub."
              checked={draft.enabled}
              onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />
            <ToggleRow
              label="Auto-detect pull requests"
              description="Link a PR automatically when one is already open on a session's branch."
              checked={draft.autoDetectPr}
              disabled={!draft.enabled}
              onChange={(autoDetectPr) => setDraft((d) => ({ ...d, autoDetectPr }))}
            />
            <ToggleRow
              label="Auto-create pull requests"
              description="Open a PR automatically once a session's branch has pushable commits."
              checked={draft.autoCreatePr}
              disabled={!draft.enabled}
              onChange={(autoCreatePr) => setDraft((d) => ({ ...d, autoCreatePr }))}
            />
          </div>

          {/* Git section */}
          <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
            <GitBranch size={14} className="text-text-bright" />
            <span className="text-[13px] font-semibold text-text-bright">Git</span>
          </div>
          <div className="divide-y divide-hairline">
            <ToggleRow
              label="Open PRs whose branch is checked out elsewhere"
              description="Start a session from a PR even when its branch is already checked out in another worktree (e.g. your main repo). The worktrees then share the branch."
              checked={gitDraft.shareCheckedOutBranches}
              onChange={(shareCheckedOutBranches) => setGitDraft({ shareCheckedOutBranches })}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
