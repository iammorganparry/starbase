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
import { useMachine } from "@xstate/react"
import { CircleDot, GitBranch, GitPullRequest, Sparkles, Star } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
  /** Discovered CLIs — only `available` ones are selectable harnesses. */
  clis: ReadonlyArray<CliInfo>
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
 * A star toggle rendered inside a Radix `Select.Item`. It swallows the pointer
 * and click events so tapping the star toggles the pin without selecting the
 * repo (which would close the dropdown).
 */
function StarToggle({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      aria-label={starred ? "Unstar repo" : "Star repo"}
      aria-pressed={starred}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      // Radix `Select.Item` commits its selection on pointer *up*, so stopping
      // pointerdown + click alone still lets the tap select the repo and close
      // the dropdown — swallow pointerup (and keyboard activation) too.
      onPointerUp={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          e.stopPropagation()
          onToggle()
        }
      }}
      className={cn(
        "size-5 rounded hover:bg-surface",
        starred && "text-yellow hover:text-yellow"
      )}
    >
      <Star size={13} className={starred ? "fill-current" : undefined} />
    </Button>
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
  loadBranches,
  onCreate,
  loadPrs,
  onCreateFromPr,
  loadIssues,
  onCreateFromIssue
}: NewSessionDialogProps) {
  const availableClis = React.useMemo(() => clis.filter((c) => c.available), [clis])
  const canFromPr = Boolean(loadPrs && onCreateFromPr)
  const canFromIssue = Boolean(loadIssues && onCreateFromIssue)

  // Partition repos into starred (surfaced first) and the rest, preserving the
  // incoming (alphabetical) order within each group.
  const starredSet = React.useMemo(() => new Set(starredRepos), [starredRepos])
  const starredList = React.useMemo(
    () => repos.filter((r) => starredSet.has(r.path)),
    [repos, starredSet]
  )
  const otherList = React.useMemo(
    () => repos.filter((r) => !starredSet.has(r.path)),
    [repos, starredSet]
  )

  // The machine reads live deps through a stable getter so changing props never
  // tear down and rebuild it mid-edit.
  const deps: NewSessionDeps = {
    repos,
    defaultRepoPath,
    availableClis,
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

  const submitting = state.matches({ submission: "submitting" })
  const loadingBranches = state.matches({ branchLoad: "loading" })
  const loadingPrs = state.matches({ prLoad: "loading" }) || state.matches({ prLoad: "debouncing" })
  const loadingIssues =
    state.matches({ issueLoad: "loading" }) || state.matches({ issueLoad: "debouncing" })
  const canCreate = state.can({ type: "SUBMIT" })
  const canAdvance = state.can({ type: "ADVANCE" })
  // In the issue picker (list step) the primary button advances to the prefill
  // step ("Start on #N"); everywhere else it submits.
  const isIssueList = mode === "issue" && issueStep === "list"
  const isIssueDetail = mode === "issue" && issueStep === "detail"

  // Seed / reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) send({ type: "OPEN" })
  }, [open, send])

  const renderRepoItem = (r: Repo) => (
    <SelectItem
      key={r.path}
      value={r.path}
      className="font-mono"
      trailing={
        onToggleStar ? (
          <StarToggle starred={starredSet.has(r.path)} onToggle={() => void onToggleStar(r.path)} />
        ) : undefined
      }
    >
      {r.name}
    </SelectItem>
  )

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
              <Select value={repoPath} onValueChange={(v) => send({ type: "SET_REPO", repoPath: v })}>
                <SelectTrigger className="font-mono">
                  <SelectValue placeholder="No repositories" />
                </SelectTrigger>
                <SelectContent>
                  {starredList.length > 0 ? (
                    <>
                      <SelectGroup>
                        <SelectLabel>Starred</SelectLabel>
                        {starredList.map(renderRepoItem)}
                      </SelectGroup>
                      {otherList.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>All repos</SelectLabel>
                          {otherList.map(renderRepoItem)}
                        </SelectGroup>
                      )}
                    </>
                  ) : (
                    repos.map(renderRepoItem)
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* No title field — the agent auto-names each session from the work. */}

            {/* Harness */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Harness</Eyebrow>
              <Select
                value={cli}
                onValueChange={(v) => send({ type: "SET_CLI", cli: v as CliKind })}
                disabled={availableClis.length === 0}
              >
                <SelectTrigger>
                  {/* SelectValue mirrors the chosen item (logo + label), so the
                      trigger needs no separate icon. */}
                  <SelectValue placeholder="No harness available" />
                </SelectTrigger>
                <SelectContent>
                  {availableClis.map((c) => (
                    <SelectItem key={c.kind} value={c.kind}>
                      <span className="flex items-center gap-2">
                        <ProviderIcon cli={c.kind} className="text-text-bright" />
                        {c.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
              variant="secondary"
              size="sm"
              onClick={() => send({ type: "BACK" })}
              disabled={submitting}
            >
              Back
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
          )}
          {isIssueList ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => send({ type: "ADVANCE" })}
              disabled={!canAdvance}
            >
              {selectedIssue ? `Start on #${selectedIssue.number}` : "Select an issue"}
            </Button>
          ) : (
            <Button
              type="submit"
              form="new-session-form"
              variant="primary"
              size="sm"
              disabled={!canCreate}
            >
              {submitting ? "Creating…" : isIssueDetail ? "Create session" : "Create"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
