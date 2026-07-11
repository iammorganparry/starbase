import { useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "../lib/cn.js"
import type { DiffRow } from "./parse.js"
import { parseUnifiedDiff } from "./parse.js"

const ROW_HEIGHT = { file: 34, hunk: 26, line: 21 } as const

const statusColor: Record<string, string> = {
  modified: "text-yellow",
  added: "text-green",
  deleted: "text-red",
  renamed: "text-blue"
}
const statusLetter: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R"
}

export interface DiffViewProps {
  /** Pre-parsed rows, or provide `patch`. */
  rows?: ReadonlyArray<DiffRow>
  /** Raw unified-diff string (parsed internally). */
  patch?: string
  className?: string
  /** Extra overscan for smoother fast scrolling over huge diffs. */
  overscan?: number
}

/**
 * A virtualized unified-diff viewer. Only the visible rows are mounted, so it
 * renders diffs with tens of thousands of lines without jank — the scroll
 * container is the sole source of layout, rows are absolutely positioned.
 */
export function DiffView({ rows, patch, className, overscan = 24 }: DiffViewProps) {
  const parsed = useMemo<ReadonlyArray<DiffRow>>(
    () => rows ?? (patch ? parseUnifiedDiff(patch) : []),
    [rows, patch]
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: parsed.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ROW_HEIGHT[parsed[i]!.kind],
    overscan
  })

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto bg-editor font-mono text-[11px] leading-[1.85]", className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = parsed[item.index]!
          return (
            <div
              key={row.key}
              className="absolute left-0 top-0 w-full"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <DiffRowView row={row} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === "file") {
    return (
      <div className="flex h-full items-center gap-2 border-y border-hairline bg-surface px-3 text-muted-foreground">
        <span className={statusColor[row.status]}>{statusLetter[row.status]}</span>
        <span className="truncate text-text-bright">{row.path}</span>
        <div className="flex-1" />
        {row.additions > 0 && <span className="text-green">+{row.additions}</span>}
        {row.deletions > 0 && <span className="text-red">−{row.deletions}</span>}
      </div>
    )
  }
  if (row.kind === "hunk") {
    return (
      <div className="flex h-full items-center bg-sunken px-3 text-[10.5px] text-cyan">
        {row.header}
      </div>
    )
  }
  const bg =
    row.type === "add" ? "bg-green/[0.13]" : row.type === "del" ? "bg-red/[0.12]" : ""
  const fg = row.type === "add" ? "text-green" : row.type === "del" ? "text-red" : "text-muted-foreground"
  const gutter = row.type === "add" ? "text-[#4e6b45]" : row.type === "del" ? "text-[#6b4a4e]" : "text-line-strong"
  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " "
  return (
    <div className={cn("flex h-full items-stretch", bg)}>
      <span className={cn("w-10 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
        {row.oldLn ?? ""}
      </span>
      <span className={cn("w-10 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
        {row.newLn ?? ""}
      </span>
      <span className={cn("w-4 shrink-0 select-none text-center", fg)}>{sign}</span>
      <span className={cn("whitespace-pre", fg)}>{row.content}</span>
    </div>
  )
}
