import { useMemo } from "react"
import type { PlanStep } from "@starbase/core"
import { FileDiff } from "lucide-react"
import { cn } from "../lib/cn.js"
import { DiffView } from "../diff/diff-view.js"

/**
 * Slice a full worktree unified diff down to the blocks that touch a given set of
 * files, so a plan step can show *its* actual changes. Matching is suffix-based
 * (`b/<path>`) so a step's repo-relative path matches the diff's `a/…`,`b/…`.
 */
const subPatchForFiles = (patch: string, paths: ReadonlyArray<string>): string => {
  if (patch.length === 0 || paths.length === 0) return ""
  const wanted = paths.map((p) => p.replace(/\\/g, "/"))
  const blocks: Array<string> = []
  let current: Array<string> | null = null
  const flush = () => {
    if (current) blocks.push(current.join("\n"))
    current = null
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  flush()
  const matches = (block: string): boolean =>
    wanted.some((p) => block.includes(` b/${p}`) || block.includes(`+++ b/${p}`) || block.endsWith(`/${p}`))
  return blocks.filter(matches).join("\n")
}

/**
 * The right rail of Plan Review: the *actual* file changes the agent has made for
 * the selected step (sliced from the session worktree's live diff). Empty until
 * execution touches one of the step's files — so a completed step shows its real
 * diff right beside its spec.
 */
export function PlanStepChanges({
  step,
  patch,
  className
}: {
  step: PlanStep
  patch: string
  className?: string
}) {
  const paths = useMemo(() => step.files.map((f) => f.path), [step.files])
  const sub = useMemo(() => subPatchForFiles(patch, paths), [patch, paths])
  const hasChanges = sub.trim().length > 0

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-panel", className)}>
      <div className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2.5">
        <FileDiff className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
          Changes in this step
        </span>
        {step.status === "done" && (
          <span className="ml-auto text-[10px] font-medium text-green">done</span>
        )}
      </div>
      {hasChanges ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffView patch={sub} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <FileDiff className="size-6 text-line-strong" />
          <p className="m-0 text-[12px] text-muted-foreground">
            {step.files.length === 0 ? "This step touches no files." : "No changes yet for this step."}
          </p>
          {step.files.length > 0 && (
            <p className="m-0 text-[11px] text-line-strong">Its diff appears here once the agent edits these files.</p>
          )}
        </div>
      )}
    </div>
  )
}
