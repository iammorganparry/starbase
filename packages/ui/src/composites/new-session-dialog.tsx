import * as React from "react"
import type { CliInfo, CliKind, CreateSessionInput, Repo } from "@starbase/core"
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
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"
import { StatusDot } from "../components/status-dot.js"

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
  /** Repos to choose from (already scanned). */
  repos: ReadonlyArray<Repo>
  /** Discovered CLIs — only `available` ones are selectable harnesses. */
  clis: ReadonlyArray<CliInfo>
  /** Load the branches for a repo (to populate the base-branch select). */
  loadBranches: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Submit — performs the real worktree creation upstream (throws on failure). */
  onCreate: (input: CreateSessionInput) => Promise<void>
}

/** Lowercase, collapse non-alphanumeric runs to single dashes, trim dashes. */
function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Preferred default base branch for a repo. */
function defaultBase(repo: Repo | undefined, branches: ReadonlyArray<string>): string {
  return repo?.currentBranch ?? repo?.defaultBranch ?? branches[0] ?? ""
}

/** The ⌘N "New Session" form, rendered inside the One Dark Dialog. */
export function NewSessionDialog({
  open,
  onClose,
  repos,
  clis,
  loadBranches,
  onCreate
}: NewSessionDialogProps) {
  const availableClis = React.useMemo(() => clis.filter((c) => c.available), [clis])

  const [repoPath, setRepoPath] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [cli, setCli] = React.useState<CliKind | "">("")
  const [base, setBase] = React.useState("")
  const [branches, setBranches] = React.useState<ReadonlyArray<string>>([])
  const [loadingBranches, setLoadingBranches] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const selectedRepo = React.useMemo(
    () => repos.find((r) => r.path === repoPath),
    [repos, repoPath]
  )

  // Guards against out-of-order branch loads when the repo changes quickly.
  const loadToken = React.useRef(0)

  const loadFor = React.useCallback(
    async (path: string) => {
      const token = ++loadToken.current
      setLoadingBranches(true)
      try {
        const list = await loadBranches(path)
        if (token !== loadToken.current) return
        setBranches(list)
        const repo = repos.find((r) => r.path === path)
        setBase(defaultBase(repo, list))
      } catch {
        if (token !== loadToken.current) return
        setBranches([])
        setBase("")
      } finally {
        if (token === loadToken.current) setLoadingBranches(false)
      }
    },
    [loadBranches, repos]
  )

  // Seed defaults whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    setTitle("")
    setCli(availableClis[0]?.kind ?? "")
    const first = repos[0]
    setRepoPath(first?.path ?? "")
    if (first) void loadFor(first.path)
    else {
      setBranches([])
      setBase("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onRepoChange = (path: string) => {
    setRepoPath(path)
    void loadFor(path)
  }

  const slug = title.trim() ? `starbase/${kebab(title)}` : ""
  const canCreate =
    !submitting && title.trim() !== "" && repoPath !== "" && cli !== "" && base !== ""

  const submit = async () => {
    // `canCreate` narrows `cli` to CliKind here (aliased-condition analysis).
    if (!canCreate || !selectedRepo) return
    setError(null)
    setSubmitting(true)
    try {
      await onCreate({
        repoPath: selectedRepo.path,
        repoName: selectedRepo.name,
        title: title.trim(),
        cli,
        baseBranch: base
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session.")
      setSubmitting(false)
    }
  }

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
              void submit()
            }}
            className="flex flex-col gap-4"
          >
            {/* Repo */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Repo</Eyebrow>
              <Select value={repoPath} onValueChange={onRepoChange}>
                <SelectTrigger className="font-mono">
                  <SelectValue placeholder="No repositories" />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((r) => (
                    <SelectItem key={r.path} value={r.path} className="font-mono">
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Title</Eyebrow>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Refactor auth refresh"
                autoFocus
              />
              <span className="font-mono text-[10.5px] text-dim">{slug || "starbase/…"}</span>
            </div>

            {/* Harness */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Harness</Eyebrow>
              <Select
                value={cli}
                onValueChange={(v) => setCli(v as CliKind)}
                disabled={availableClis.length === 0}
              >
                <SelectTrigger>
                  <span className="flex items-center gap-2">
                    <StatusDot tone="bg-green" size={7} glow={false} />
                    <SelectValue placeholder="No harness available" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {availableClis.map((c) => (
                    <SelectItem key={c.kind} value={c.kind}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Base branch */}
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Base</Eyebrow>
              <Select
                value={base}
                // Ignore the spurious empty-value change Radix emits when the
                // programmatic default is applied as the select flips from
                // disabled → enabled on branch load; a real pick is never empty.
                onValueChange={(v) => v && setBase(v)}
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
