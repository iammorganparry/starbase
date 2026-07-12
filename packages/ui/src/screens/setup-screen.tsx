import type { CliInfo, GhStatus, Repo } from "@starbase/core"
import { ArrowRight, FolderSearch, GitBranch, RefreshCw } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"

export interface SetupScreenProps {
  /** Discovered coding CLIs (for a reassuring "harnesses ready" summary). */
  clis: ReadonlyArray<CliInfo>
  /** GitHub CLI status. */
  ghStatus: GhStatus
  /** Repos found after a directory is chosen (empty/absent before selection). */
  repos?: ReadonlyArray<Repo>
  /** True while a directory choice is being processed / repos are scanning. */
  busy?: boolean
  /** Invoked when the user clicks "Choose repos folder" — opens native dialog upstream. Resolves with the chosen dir path or null if cancelled. */
  onChooseDir: () => void
  /** Invoked when the user clicks "Get started" (only enabled once a reposDir is chosen). */
  onContinue: () => void
  /** The currently chosen repos directory path, or null before selection. */
  reposDir?: string | null
  /** Re-run `gh auth status` after the user signs in from their terminal. */
  onRecheckGh?: () => void
  /** A `gh` recheck is in flight. */
  recheckingGh?: boolean
}

/** First-run welcome. Points Starbase at the folder that holds your git repos. */
export function SetupScreen({
  clis,
  ghStatus,
  repos = [],
  busy = false,
  onChooseDir,
  onContinue,
  reposDir = null,
  onRecheckGh,
  recheckingGh = false
}: SetupScreenProps) {
  const chosen = reposDir !== null
  const shownRepos = repos.slice(0, 6)
  const overflow = repos.length - shownRepos.length

  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-auto bg-editor px-6 py-10">
      <div className="flex w-full max-w-[520px] flex-col gap-6">
        {/* Brand */}
        <div className="flex size-12 items-center justify-center rounded-xl bg-blue font-mono text-[22px] leading-none text-editor">
          ✦
        </div>

        {/* Header */}
        <div className="flex flex-col gap-2.5">
          <Eyebrow>Welcome</Eyebrow>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
            Set up your workspace
          </h1>
          <p className="text-[13px] leading-[1.6] text-muted-foreground">
            Starbase needs the folder that holds your git repos — the one with{" "}
            <span className="font-mono text-text">~/repos</span> and friends inside it. Sessions run
            in isolated worktrees forked from those repos.
          </p>
        </div>

        {/* Choose / chosen path */}
        {!chosen ? (
          <div className="flex flex-col gap-5">
            <Button variant="primary" onClick={onChooseDir} disabled={busy} className="self-start">
              {busy ? (
                <>
                  <Spinner size={13} />
                  Scanning…
                </>
              ) : (
                <>
                  <FolderSearch size={14} />
                  Choose repos folder
                </>
              )}
            </Button>

            {/* Harnesses */}
            <div className="flex flex-col gap-2.5">
              <span className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground">
                HARNESSES
              </span>
              <div className="flex flex-wrap gap-1.5">
                {clis.length === 0 && <span className="text-[11px] text-dim">Scanning…</span>}
                {clis.map((cli) => (
                  <span
                    key={cli.kind}
                    title={
                      cli.available
                        ? `${cli.binPath ?? ""}${cli.version ? ` · ${cli.version}` : ""}`
                        : "Not installed"
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[10.5px]",
                      cli.available
                        ? "border-green/30 bg-green/10 text-text"
                        : "border-line bg-white/[0.03] text-dim opacity-60"
                    )}
                  >
                    <StatusDot
                      tone={cli.available ? "bg-green" : "bg-line-strong"}
                      size={6}
                      glow={false}
                    />
                    {cli.label}
                  </span>
                ))}
                {/* GitHub CLI status chip */}
                <GhChip gh={ghStatus} />
              </div>
            </div>

            {!ghStatus.available && (
              <Callout tone="blue">
                <span className="font-mono text-text">gh</span> isn't installed — that's fine.
                It's optional, and only needed later for pull-request features.
              </Callout>
            )}

            {ghStatus.available && !ghStatus.authenticated && (
              <Callout tone="blue">
                <div className="flex flex-col gap-2">
                  <span>
                    Sign in to GitHub for pull-request features — run{" "}
                    <span className="font-mono text-text">gh auth login</span> in your terminal, then
                    recheck. (Optional; you can do this later.)
                  </span>
                  {onRecheckGh && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onRecheckGh}
                      disabled={recheckingGh}
                      className="self-start"
                    >
                      <RefreshCw size={12} className={cn(recheckingGh && "animate-spin")} />
                      Recheck
                    </Button>
                  )}
                </div>
              </Callout>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Chosen path */}
            <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5">
              <FolderSearch size={14} className="flex-none text-blue" />
              <span className="truncate font-mono text-[12px] text-text-body">{reposDir}</span>
            </div>

            {/* Summary + repo chips */}
            <div className="flex flex-col gap-2.5">
              <span className="text-[12.5px] text-muted-foreground">
                Found{" "}
                <span className="font-semibold text-text-bright">{repos.length}</span>{" "}
                {repos.length === 1 ? "repository" : "repositories"}
              </span>
              {shownRepos.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {shownRepos.map((repo) => (
                    <span
                      key={repo.path}
                      title={repo.path}
                      className="flex items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-2 py-[3px] font-mono text-[10.5px] text-text"
                    >
                      <GitBranch size={11} className="text-cyan" />
                      {repo.name}
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span className="flex items-center rounded-md px-2 py-[3px] font-mono text-[10.5px] text-dim">
                      +{overflow} more
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <Button variant="primary" onClick={onContinue}>
                Get started
                <ArrowRight size={14} />
              </Button>
              <Button variant="ghost" onClick={onChooseDir} disabled={busy}>
                {busy ? "Scanning…" : "Choose a different folder"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** GitHub CLI status chip — green when authenticated, muted otherwise. */
function GhChip({ gh }: { gh: GhStatus }) {
  if (!gh.available) {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-2 py-[3px] font-mono text-[10.5px] text-dim opacity-60">
        <StatusDot tone="bg-line-strong" size={6} glow={false} />
        gh not installed
      </span>
    )
  }
  const authed = gh.authenticated
  return (
    <span
      title={gh.host ?? undefined}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[10.5px]",
        authed
          ? "border-green/30 bg-green/10 text-text"
          : "border-line bg-white/[0.03] text-dim"
      )}
    >
      <StatusDot tone={authed ? "bg-green" : "bg-line-strong"} size={6} glow={false} />
      {authed ? `GitHub CLI · @${gh.login ?? "user"}` : "GitHub CLI · not connected"}
    </span>
  )
}
