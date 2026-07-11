import { DiffView } from "../diff/diff-view.js"
import type { DiffRow } from "../diff/parse.js"

/**
 * Right-hand review rail: the virtualized worktree diff. There are no
 * accept/reject controls — the agent's edits are already applied to the worktree
 * (and auto-accepted under Accept-edits/Auto), so this is a live view of what's
 * on disk, reverted through git if needed.
 */
export function DiffPanel({
  rows,
  patch,
  added,
  removed
}: {
  rows?: ReadonlyArray<DiffRow>
  patch?: string
  added: number
  removed: number
}) {
  return (
    <div className="flex w-[392px] flex-none flex-col border-l border-hairline bg-panel">
      <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[15px]">
        <span className="text-[12px] font-semibold text-text-bright">Changes</span>
        <span className="font-mono text-[10px] text-green">+{added}</span>
        <span className="font-mono text-[10px] text-red">−{removed}</span>
      </div>

      {/* Virtualized — handles tens of thousands of lines. */}
      <div className="min-h-0 flex-1">
        <DiffView rows={rows} patch={patch} />
      </div>
    </div>
  )
}
