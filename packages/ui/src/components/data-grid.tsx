import { cn } from "../lib/cn.js"

export interface DataColumn {
  key: string
  /** Right-align and fix the width — numeric columns, so digits line up. */
  numeric?: boolean
}

/**
 * A small read-only result grid — a SQL SELECT's rows.
 *
 * Numeric columns right-align with `tabular-nums` and tint green: in a query
 * result the counts ARE the answer, and ragged left-aligned digits are unreadable
 * at a glance. Text columns stay bright and flexible.
 */
export function DataGrid({
  columns,
  rows,
  className
}: {
  columns: ReadonlyArray<DataColumn>
  rows: ReadonlyArray<ReadonlyArray<string>>
  className?: string
}) {
  return (
    <div className={cn("font-mono text-[12px]", className)}>
      <div className="flex border-b border-line px-1 pb-[7px] text-[10.5px] uppercase tracking-[0.3px] text-muted-foreground">
        {columns.map((c) => (
          <span key={c.key} className={cn(c.numeric ? "w-20 flex-none text-right" : "min-w-0 flex-1 truncate")}>
            {c.key}
          </span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn("flex px-1 py-1.5", i < rows.length - 1 && "border-b border-line/25")}
        >
          {columns.map((c, j) => (
            <span
              key={c.key}
              className={cn(
                c.numeric
                  ? "w-20 flex-none text-right tabular-nums text-green"
                  : "min-w-0 flex-1 truncate text-text-bright"
              )}
            >
              {row[j] ?? ""}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
