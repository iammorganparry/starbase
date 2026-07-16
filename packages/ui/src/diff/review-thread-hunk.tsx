import { cn } from "../lib/cn.js"
import { parseDiffHunk } from "./parse-diff-hunk.js"

/**
 * The diff hunk an inline review thread is anchored to.
 *
 * A sibling of `DiffHunk` rather than a mode of it: GitHub's review threads show
 * BOTH gutters (old │ new) whereas `DiffHunk` shows a single `ln`, and widening
 * `HunkLine` for this one caller would churn every existing use. The colour
 * tokens are deliberately identical so the two read as one component.
 */
export function ReviewThreadHunk({ hunk, className }: { hunk: string; className?: string }) {
  const lines = parseDiffHunk(hunk)
  if (lines.length === 0) return null

  return (
    <div className={cn("overflow-x-auto bg-editor font-mono text-[11px] leading-[1.85]", className)}>
      {lines.map((line, i) => {
        const bg = line.type === "add" ? "bg-green/[0.13]" : line.type === "del" ? "bg-red/[0.12]" : ""
        const fg =
          line.type === "add" ? "text-green" : line.type === "del" ? "text-red" : "text-muted-foreground"
        const gutter =
          line.type === "add"
            ? "text-[#4e6b45]"
            : line.type === "del"
              ? "text-[#6b4a4e]"
              : "text-line-strong"
        const sign = line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "
        return (
          // Hunks are immutable and never reordered, so the index is a stable key.
          <div key={i} className={cn("flex", bg)}>
            <span className={cn("w-9 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
              {line.oldLn ?? ""}
            </span>
            <span className={cn("w-9 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
              {line.newLn ?? ""}
            </span>
            <span className={cn("whitespace-pre pr-3", fg)}>
              {sign}
              {line.content}
            </span>
          </div>
        )
      })}
    </div>
  )
}
