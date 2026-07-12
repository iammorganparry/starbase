import type { PrFileChange } from "@starbase/core"
import { Check } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"

/** A row in the Code Review file list — name, diff stat, comment count, viewed state. */
export function ReviewFileRow({
  file,
  active,
  onSelect,
  onToggleViewed
}: {
  file: PrFileChange
  active: boolean
  onSelect: () => void
  onToggleViewed: (viewed: boolean) => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-[9px] rounded-md border px-[9px] py-[7px] transition-colors",
        active
          ? "border-blue/[0.28] bg-surface"
          : "border-transparent hover:bg-surface/40",
        !active && file.viewed && "opacity-70"
      )}
    >
      <FileIcon path={file.path} size={13} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11.5px]",
          active ? "text-text-bright" : "text-text"
        )}
        title={file.path}
      >
        {name}
      </span>
      <DiffStat added={file.additions} removed={file.deletions} className="flex-none text-[9.5px]" />
      {file.commentCount > 0 && (
        <Badge tone="blue" size="xs" className="flex-none">
          {file.commentCount}
        </Badge>
      )}
      <button
        type="button"
        aria-label={file.viewed ? "Mark not viewed" : "Mark viewed"}
        onClick={(e) => {
          e.stopPropagation()
          onToggleViewed(!file.viewed)
        }}
        className={cn(
          "flex size-[15px] flex-none items-center justify-center rounded-[3px] border",
          file.viewed ? "border-green/60 text-green" : "border-line text-transparent hover:border-line-strong"
        )}
      >
        {file.viewed && <Check size={11} />}
      </button>
    </div>
  )
}
