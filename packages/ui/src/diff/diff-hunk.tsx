import { cn } from "../lib/cn.js"
import { DiffStat } from "../components/diff-stat.js"

export interface HunkLine {
  type: "add" | "del" | "normal"
  ln: number
  content: string
}

/** A compact, non-virtualized single-file hunk (for cards & inline previews). */
export function DiffHunk({
  path,
  status = "M",
  added,
  removed,
  lines,
  className
}: {
  path: string
  status?: "M" | "A" | "D"
  added: number
  removed: number
  lines: ReadonlyArray<HunkLine>
  className?: string
}) {
  const statusColor = status === "A" ? "text-green" : status === "D" ? "text-red" : "text-yellow"
  return (
    <div className={cn("overflow-hidden rounded-md border border-line", className)}>
      <div className="flex items-center gap-2 bg-surface px-[11px] py-[7px] font-mono text-[11px] text-muted-foreground">
        <span className={statusColor}>{status}</span>
        {path}
        <div className="flex-1" />
        <DiffStat added={added} removed={removed} />
      </div>
      <div className="bg-editor font-mono text-[11px] leading-[1.85]">
        {lines.map((line, i) => {
          const bg = line.type === "add" ? "bg-green/[0.13]" : line.type === "del" ? "bg-red/[0.12]" : ""
          const fg = line.type === "add" ? "text-green" : line.type === "del" ? "text-red" : "text-muted-foreground"
          const gutter = line.type === "add" ? "text-[#4e6b45]" : line.type === "del" ? "text-[#6b4a4e]" : "text-line-strong"
          const sign = line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "
          return (
            <div key={i} className={cn("flex", bg)}>
              <span className={cn("w-8 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
                {line.ln}
              </span>
              <span className={cn("whitespace-pre", fg)}>
                {sign}
                {line.content}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
