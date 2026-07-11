import { Button } from "../components/button.js"
import { DiffView } from "../diff/diff-view.js"
import type { DiffRow } from "../diff/parse.js"

/** Right-hand review rail: virtualized diff + accept/reject actions. */
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
        <div className="flex-1" />
        <span className="text-[14px] text-dim">⌄</span>
      </div>

      {/* Virtualized — handles tens of thousands of lines. */}
      <div className="min-h-0 flex-1">
        <DiffView rows={rows} patch={patch} />
      </div>

      <div className="flex flex-none gap-2 border-t border-hairline px-3.5 py-[11px]">
        <Button variant="secondary" size="sm" className="flex-1 justify-center py-[7px]">
          Reject
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1 justify-center bg-green py-[7px] text-editor hover:bg-green/90"
        >
          Accept all
        </Button>
      </div>
    </div>
  )
}
