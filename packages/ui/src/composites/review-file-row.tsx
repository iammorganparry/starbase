import type { PrFileChange } from "@starbase/core"
import { Check, MessageSquare } from "lucide-react"
import { cn } from "../lib/cn.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"

/**
 * A row in the Code Review file list — name, diff stat, feedback marker, viewed
 * state.
 *
 * `feedback` counts everything on this file worth looking at: adversarial
 * findings, your unsubmitted drafts, and unresolved PR threads. It replaces
 * `file.commentCount`, which every producer hardcoded to 0 — the badge it fed
 * could never render.
 */
export function ReviewFileRow({
  file,
  active,
  feedback = 0,
  onSelect,
  onToggleViewed
}: {
  file: PrFileChange
  active: boolean
  /** How many pieces of feedback sit on this file. 0 renders no marker. */
  feedback?: number
  onSelect: () => void
  onToggleViewed: (viewed: boolean) => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-[9px] rounded-md border px-[9px] py-[7px] transition-colors",
        active ? "border-blue/[0.28] bg-surface" : "border-transparent hover:bg-surface/40",
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
      {feedback > 0 && (
        // Icon + count rather than a bare number: at this size a lone digit
        // beside the +/− stat reads as another diff figure. The icon says what
        // kind of number it is before you've read it.
        <span
          className="flex flex-none items-center gap-[3px] text-blue"
          title={`${feedback} ${feedback === 1 ? "comment" : "comments"}`}
          aria-label={`${feedback} ${feedback === 1 ? "comment" : "comments"}`}
        >
          <MessageSquare size={11} strokeWidth={2.25} />
          <span className="font-mono text-[9.5px] tabular-nums leading-none">{feedback}</span>
        </span>
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
          file.viewed
            ? "border-green/60 text-green"
            : "border-line text-transparent hover:border-line-strong"
        )}
      >
        {file.viewed && <Check size={11} />}
      </button>
    </div>
  )
}
