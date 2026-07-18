import type { ArchiveReason } from "@starbase/core"
import { GitMerge, RotateCcw, Trash2, XCircle } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"

export interface ArchivedBannerProps {
  reason: ArchiveReason
  prNumber: number | null
  /** The base branch the PR targeted (for "merged into main"). */
  base?: string | null
  onRestore?: () => void
  onDelete?: () => void
}

/**
 * The archived-session banner (design A1) shown atop a read-only session whose PR
 * was merged or closed. Explains the auto-archive and offers the two exits the
 * user has: restore it to keep iterating, or delete it for good.
 */
export function ArchivedBanner({ reason, prNumber, base, onRestore, onDelete }: ArchivedBannerProps) {
  const merged = reason === "merged"
  return (
    <div className="flex flex-none gap-3 border-b border-hairline bg-panel px-[30px] py-3.5">
      <span
        className={merged
          ? "flex size-[30px] flex-none items-center justify-center rounded-lg bg-purple/[0.14] text-purple"
          : "flex size-[30px] flex-none items-center justify-center rounded-lg bg-red/[0.12] text-red"}
      >
        {merged ? <GitMerge size={15} /> : <XCircle size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-pretty text-[13px] font-semibold text-text-bright">
            Pull request{" "}
            {prNumber !== null && (
              <span className={merged ? "font-mono text-purple" : "font-mono text-red"}>#{prNumber}</span>
            )}{" "}
            was {merged ? "merged" : "closed"}
            {base ? (
              <>
                {" "}
                {merged ? "into" : "on"} <span className="font-mono text-text">{base}</span>
              </>
            ) : null}
          </span>
          <Badge tone="neutral" size="xs">
            Stale
          </Badge>
        </div>
        <p className="mt-1 text-pretty text-[12px] leading-[1.5] text-muted-foreground">
          This session is archived and now read-only. Nothing is lost — restore it to keep iterating,
          or delete it for good.
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          {onRestore && (
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={onRestore}>
              <RotateCcw size={13} />
              Restore session
            </Button>
          )}
          <div className="flex-1" />
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-red hover:bg-red/10"
              onClick={onDelete}
            >
              <Trash2 size={13} />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
