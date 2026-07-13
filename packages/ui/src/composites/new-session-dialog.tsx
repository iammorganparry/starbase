import * as React from "react"
import type {
  CliInfo,
  CliKind,
  CreateSessionFromPrInput,
  CreateSessionInput,
  PrSummary,
  Repo
} from "@starbase/core"
import { useMachine } from "@xstate/react"
import { Star } from "lucide-react"
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
import { Input } from "../components/input.js"
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
}

/** Lowercase, collapse non-alphanumeric runs to single dashes, trim dashes. */
function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * A star toggle rendered inside a Radix `Select.Item`. It swallows the pointer
 * and click events so tapping the star toggles the pin without selecting the
 * repo (which would close the dropdown).
 */
function StarToggle({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={starred ? "Unstar repo" : "Star repo"}
      aria-pressed={starred}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
        starred ? "text-yellow" : "text-muted-foreground hover:text-text"
      )}
    >
      <Star size={13} className={starred ? "fill-current" : undefined} />
    </button>
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
  onCreateFromPr
}: NewSessionDialogProps) {
  const availableClis = React.useMemo(() => clis.filter((c) => c.available), [clis])
  const canFromPr = Boolean(loadPrs && onCreateFromPr)

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
    onCreate,
    onCreateFromPr,
    onClose
  }
  const depsRef = React.useRef(deps)
  depsRef.current = deps
  const getDeps = React.useCallback(() => depsRef.current, [])

  const [state, send] = useMachine(newSessionMachine, { input: { getDeps } })
  const {
    mode,
    repoPath,
    title,
    cli,
    base,
    branches,
    search,
    mine,
    prs,
    selectedPr,
    error
  } = state.context

  const submitting = state.matches({ submission: "submitting" })
  const loadingBranches = state.matches({ branchLoad: "loading" })
  const loadingPrs = state.matches({ prLoad: "loading" }) || state.matches({ prLoad: "debouncing" })
  const canCreate = state.can({ type: "SUBMIT" })

  // Seed / reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) send({ type: "OPEN" })
  }, [open, send])

  const slug = title.trim() ? `starbase/${kebab(title)}` : ""

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
            {/* Mode toggle — only when the "from PR" flow is wired. */}
            {canFromPr && (
              <SegmentedControl<NewSessionMode>
                className="self-start"
                value={mode}
                onChange={(next) => send({ type: "SET_MODE", mode: next })}
                items={[
                  { value: "blank", label: "Blank" },
                  { value: "pr", label: "From PR" }
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

            {/* Title (blank mode only — a from-PR session's title is the PR title) */}
            {mode === "blank" && (
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Title</Eyebrow>
                <Input
                  value={title}
                  onChange={(e) => send({ type: "SET_TITLE", title: e.target.value })}
                  placeholder="Refactor auth refresh"
                  autoFocus
                />
                <span className="font-mono text-[10.5px] text-dim">{slug || "starbase/…"}</span>
              </div>
            )}

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

            {/* Base branch (blank mode) */}
            {mode === "blank" && (
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

            {error && <Callout tone="red">{error}</Callout>}
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-session-form"
            variant="primary"
            size="sm"
            disabled={!canCreate}
          >
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
