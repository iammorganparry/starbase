import * as React from "react"
import type {
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueSummary,
  PrSummary,
  Repo
} from "@starbase/core"
import { startableClis } from "@starbase/core"
import { useMachine } from "@xstate/react"
import { CircleDot, GitBranch, GitPullRequest, Sparkles } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Eyebrow } from "../components/eyebrow.js"
import { RepoPicker } from "./repo-picker.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"
import { SearchInput } from "../components/search-input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { Toggle } from "../components/toggle.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { PrPickerList } from "./pr-picker-list.js"
import { IssuePickerList, IssueLabelChip } from "./issue-picker-list.js"
import { newSessionMachine } from "./new-session-machine.js"
import type { NewSessionDeps, NewSessionMode } from "./new-session-machine.js"

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
  /** Repos to choose from (already scanned). */
  repos: ReadonlyArray<Repo>
  /** Absolute paths of starred repos — surfaced first, above "All repos". */
  starredRepos?: ReadonlyArray<string>
  /** Toggle a repo's starred state (by path); presence wires the row star button. */
  onToggleStar?: (repoPath: string) => void | Promise<void>
  /** Preselect this repo (by path) each time the dialog opens. */
  defaultRepoPath?: string | null
  /** Discovered CLIs — `startableClis` decides which of them can run a session. */
  clis: ReadonlyArray<CliInfo>
  /**
   * The harness new sessions run on (Settings · Providers). Absent, or naming an
   * uninstalled CLI, falls back to the first startable one.
   */
  defaultCli?: CliKind | null
  /** Load the branches for a repo (to populate the base-branch select). */
  loadBranches: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Submit — performs the real worktree creation upstream (throws on failure). */
  onCreate: (input: CreateSessionInput) => Promise<void>
  /**
   * List open PRs for a repo. Presence (with `onCreateFromPr`) wires the
   * `Blank | From PR` toggle; absent hides it (blank-only dialog).
   */
  loadPrs?: (repoPath: string, opts: { mine: boolean; search: string }) => Promise<ReadonlyArray<PrSummary>>
  /** Submit a "from PR" session (checks out the PR's head branch upstream). */
  onCreateFromPr?: (input: CreateSessionFromPrInput) => Promise<void>
  /**
   * List open issues for a repo. Presence (with `onCreateFromIssue`) wires the
   * "From issue" mode; absent hides it.
   */
  loadIssues?: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ) => Promise<ReadonlyArray<IssueSummary>>
  /** Submit a "from issue" session (forks a fresh branch + links the issue). */
  onCreateFromIssue?: (input: CreateSessionFromIssueInput) => Promise<void>
}

/** Cosmetic branch-slug preview (the real slug is computed server-side). */
function kebabTitle(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "issue"
  )
}

/** One automation row: a label + a right-aligned toggle (issue detail step). */
function AutomationRow({
  label,
  checked,
  onChange
}: {
  label: React.ReactNode
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 bg-sunken px-3.5 py-2.5">
      <span className="flex-1 text-[12.5px] text-text">{label}</span>
      <Toggle checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

/**
 * The ⌘N "New Session" form, rendered inside the One Dark Dialog. All form state
 * lives in `newSessionMachine` (edit / submit lifecycle + debounced branch & PR
 * loading); this component is a thin projection — it maps `context` to inputs
 * and dispatches events. A `Blank | From PR` toggle (when the PR flow is wired)
 * swaps the title/base fields for a searchable open-PR picker.
 */
export function NewSessionDialog({
  open,
  onClose,
  repos,
  starredRepos = [],
  onToggleStar,
  defaultRepoPath,
  clis,
  defaultCli,
  loadBranches,
  onCreate,
  loadPrs,
  onCreateFromPr,
  loadIssues,
  onCreateFromIssue
}: NewSessionDialogProps) {
  // `startableClis` drops `starbase` as well as the uninstalled: the
  // orchestrator drives harnesses, it is not one you can start a session on.
  const availableClis = React.useMemo(() => startableClis(clis), [clis])
  const canFromPr = Boolean(loadPrs && onCreateFromPr)
  const canFromIssue = Boolean(loadIssues && onCreateFromIssue)

  // The machine reads live deps through a stable getter so changing props never
  // tear down and rebuild it mid-edit.
  const deps: NewSessionDeps = {
    repos,
    defaultRepoPath,
    availableClis,
    defaultCli,
    loadBranches,
    loadPrs,
    loadIssues,
    onCreate,
    onCreateFromPr,
    onCreateFromIssue,
    onClose
  }
  const depsRef = React.useRef(deps)
  depsRef.current = deps
  const getDeps = React.useCallback(() => depsRef.current, [])

  const [state, send] = useMachine(newSessionMachine, { input: { getDeps } })
  const {
    mode,
    repoPath,
    cli,
    base,
    branches,
    search,
    mine,
    prs,
    selectedPr,
    issues,
    selectedIssue,
    issueStep,
    task,
    automations,
    error
  } = state.context

  /** Label for the resolved harness — the dialog reports it, never picks it. */
  const harnessLabel = availableClis.find((c) => c.kind === cli)?.label ?? cli

  const submitting = state.matches({ submission: "submitting" })
  const loadingBranches = state.matches({ branchLoad: "loading" })
  const loadingPrs = state.matches({ prLoad: "loading" }) || state.matches({ prLoad: "debouncing" })
  const loadingIssues =
    state.matches({ issueLoad: "loading" }) || state.matches({ issueLoad: "debouncing" })
  // Mirror the machine's `canSubmit` guard directly off context — robust against
  // any `state.can` timing quirk across the parallel regions, and cheap.
  const canCreate =
    repoPath !== "" &&
    cli !== "" &&
    (mode === "pr"
      ? selectedPr !== null
      : mode === "issue"
        ? issueStep === "detail" && selectedIssue !== null && base !== ""
        : base !== "")
  const canAdvance =
    mode === "issue" && issueStep === "list" && selectedIssue !== null
  // In the issue picker (list step) the primary button advances to the prefill
  // step ("Start on #N"); everywhere else it submits.
  const isIssueList = mode === "issue" && issueStep === "list"
  const isIssueDetail = mode === "issue" && issueStep === "detail"

  // Seed / reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) send({ type: "OPEN" })
  }, [open, send])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        onInteractOutside={(e) => submitting && e.preventDefault()}
        onEscapeKeyDown={(e) => submitting && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <form
            id="new-session-form"
            onSubmit={(e) => {
              e.preventDefault()
              send({ type: "SUBMIT" })
            }}
            className="flex flex-col gap-4"
          >
            {/* Mode toggle — shown when at least one GitHub flow is wired. */}
            {(canFromPr || canFromIssue) && (
              <SegmentedControl<NewSessionMode>
                className="self-start"
                value={mode}
                onChange={(next) => send({ type: "SET_MODE", mode: next })}
                items={[
                  {
                    value: "blank",
                    label: (
                      <span className="flex items-center gap-1.5">
                        <GitBranch size={14} />
                        New branch
                      </span>
                    )
                  },
                  ...(canFromPr
                    ? [
                        {
                          value: "pr" as NewSessionMode,
                          label: (
                            <span className="flex items-center gap-1.5">
                              <GitPullRequest size={14} />
                              From PR
                            </span>
                          )
                        }
                      ]
                    : []),
                  ...(canFromIssue
                    ? [
                        {
                          value: "issue" as NewSessionMode,
                          label: (
                            <span className="flex items-center gap-1.5">
                              <CircleDot size={14} />
                              From issue
                            </span>
                          )
                        }
                      ]
                    : [])
                ]}
              />
            )}

            {/* Repo */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Repo</Eyebrow>
              <RepoPicker
                repos={repos}
                value={repoPath}
                onChange={(v) => send({ type: "SET_REPO", repoPath: v })}
                starredRepos={starredRepos}
                onToggleStar={onToggleStar}
              />
            </div>

            {/* No title field — the agent auto-names each session from the work. */}

            {/*
              No harness picker. It asked the same question every time and got
              the same answer, so the choice moved to Settings · Providers and
              this only REPORTS the outcome. `starbase` is never offered there:
              the orchestrator is a per-turn mode on a session, not a harness to
              start one on.
            */}
            {availableClis.length === 0 ? (
              <Callout tone="yellow">
                No coding CLI found. Install Claude Code, Codex, Cursor or opencode, then
                reopen this dialog.
              </Callout>
            ) : (
              <span className="flex items-center gap-1.5 text-[10.5px] text-dim">
                Runs on
                <ProviderIcon cli={cli as CliKind} size={12} className="text-text-bright" />
                <span className="text-muted-foreground">{harnessLabel}</span>· change the
                default in Settings · Providers.
              </span>
            )}

            {/* Base branch (blank mode + the issue picker step). */}
            {(mode === "blank" || isIssueList) && (
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Base</Eyebrow>
                <Select
                  value={base}
                  // Ignore the spurious empty-value change Radix emits when the
                  // programmatic default is applied as the select flips from
                  // disabled → enabled on branch load; a real pick is never empty.
                  onValueChange={(v) => v && send({ type: "SET_BASE", base: v })}
                  disabled={loadingBranches || branches.length === 0}
                >
                  <SelectTrigger className="font-mono">
                    <SelectValue
                      placeholder={loadingBranches ? "Loading branches…" : "No branches"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b} value={b} className="font-mono">
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[10.5px] text-dim">
                  The new worktree forks from this branch.
                </span>
              </div>
            )}

            {/* Pull request picker (from-PR mode) */}
            {mode === "pr" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Eyebrow className="flex-1">Pull request</Eyebrow>
                  <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted-foreground">
                    Just mine
                    <Toggle
                      checked={mine}
                      onCheckedChange={(next) => send({ type: "SET_MINE", mine: next })}
                      aria-label="Only my pull requests"
                    />
                  </label>
                </div>
                <SearchInput
                  value={search}
                  onChange={(v) => send({ type: "SET_SEARCH", search: v })}
                  placeholder="Search open pull requests…"
                />
                <PrPickerList
                  prs={prs}
                  selected={selectedPr?.number ?? null}
                  onSelect={(pr) => send({ type: "SELECT_PR", pr })}
                  loading={loadingPrs}
                />
                <span className="text-[10.5px] text-dim">
                  The session checks out the PR&apos;s branch — the agent&apos;s commits update it.
                </span>
              </div>
            )}

            {/* Issue picker (from-issue mode · list step) */}
            {isIssueList && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Eyebrow className="flex-1">Open issue</Eyebrow>
                  <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted-foreground">
                    Just mine
                    <Toggle
                      checked={mine}
                      onCheckedChange={(next) => send({ type: "SET_MINE", mine: next })}
                      aria-label="Only issues assigned to me"
                    />
                  </label>
                </div>
                <SearchInput
                  value={search}
                  onChange={(v) => send({ type: "SET_SEARCH", search: v })}
                  placeholder="Search open issues…"
                />
                <IssuePickerList
                  issues={issues}
                  selected={selectedIssue?.number ?? null}
                  onSelect={(issue) => send({ type: "SELECT_ISSUE", issue })}
                  loading={loadingIssues}
                />
                <span className="text-[10.5px] text-dim">
                  Forks a fresh branch off the base — task &amp; labels prefill from the issue.
                </span>
              </div>
            )}

            {/* Issue detail (from-issue mode · prefill + automations step) */}
            {isIssueDetail && selectedIssue && (
              <div className="flex flex-col gap-4">
                {/* Issue header */}
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-md bg-green/15">
                    <CircleDot size={15} className="text-green" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-text-bright">
                      {selectedIssue.title}
                    </div>
                    <div className="font-mono text-[11px] text-dim">
                      {repos.find((r) => r.path === repoPath)?.name}{" "}
                      <span className="text-muted-foreground">#{selectedIssue.number}</span>
                    </div>
                  </div>
                </div>

                {/* Editable task */}
                <div className="flex flex-col gap-1.5">
                  <Eyebrow className="flex items-center gap-2">
                    Task
                    <span className="inline-flex items-center gap-1 rounded-[3px] bg-green/12 px-1.5 py-px text-[9px] font-semibold uppercase tracking-normal text-green">
                      <Sparkles size={10} />
                      from issue
                    </span>
                  </Eyebrow>
                  <textarea
                    value={task}
                    onChange={(e) => send({ type: "SET_TASK", task: e.target.value })}
                    rows={3}
                    className="w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 text-[13.5px] leading-[1.55] text-text outline-none transition-colors placeholder:text-dim focus:border-blue/50 focus:ring-2 focus:ring-ring/40"
                    placeholder="Describe the task for the agent…"
                  />
                </div>

                {/* Branch preview */}
                <div className="flex flex-col gap-1.5">
                  <Eyebrow>Branch</Eyebrow>
                  <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
                    <GitBranch size={14} className="flex-none text-cyan" />
                    <span className="flex-1 truncate font-mono text-[12.5px] text-text-bright">
                      starbase/{selectedIssue.number}-{kebabTitle(selectedIssue.title)}
                    </span>
                    <span className="font-mono text-[10px] text-dim">off {base || "base"}</span>
                  </div>
                </div>

                {/* Pulled labels + assignee */}
                {(selectedIssue.labels.length > 0 || selectedIssue.assignees.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Eyebrow>Pulled in</Eyebrow>
                    {selectedIssue.labels.slice(0, 5).map((l) => (
                      <IssueLabelChip key={l.name} name={l.name} color={l.color} />
                    ))}
                    {selectedIssue.assignees[0] && (
                      <span className="text-[11px] text-muted-foreground">
                        @{selectedIssue.assignees[0].login}
                      </span>
                    )}
                  </div>
                )}

                {/* Automations */}
                <div className="overflow-hidden rounded-md border border-line">
                  <AutomationRow
                    label={
                      <>
                        Post progress comments back to{" "}
                        <span className="font-mono text-[11px] text-text">#{selectedIssue.number}</span>
                      </>
                    }
                    checked={automations.progressComments}
                    onChange={(v) => send({ type: "SET_AUTOMATION", key: "progressComments", value: v })}
                  />
                  <div className="border-t border-hairline" />
                  <AutomationRow
                    label={
                      <>
                        Close the issue when the PR merges{" "}
                        <span className="font-mono text-[10.5px] text-dim">
                          (Closes #{selectedIssue.number})
                        </span>
                      </>
                    }
                    checked={automations.closeOnMerge}
                    onChange={(v) => send({ type: "SET_AUTOMATION", key: "closeOnMerge", value: v })}
                  />
                </div>
              </div>
            )}

            {error && <Callout tone="red">{error}</Callout>}
          </form>
        </DialogBody>

        <DialogFooter>
          {isIssueDetail ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => send({ type: "BACK" })}
              disabled={submitting}
            >
              Back
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
          )}
          {/* One always-`type=button` primary (dispatch via onClick, never a native
              submit) — so toggling the label/action across the issue list→detail
              step can't trigger a stray form submit mid-click. Enter-to-submit is
              still handled by the form's onSubmit. */}
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => send({ type: isIssueList ? "ADVANCE" : "SUBMIT" })}
            disabled={isIssueList ? !canAdvance : !canCreate}
          >
            {submitting
              ? "Creating…"
              : isIssueList
                ? selectedIssue
                  ? `Start on #${selectedIssue.number}`
                  : "Select an issue"
                : isIssueDetail
                  ? "Create session"
                  : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
