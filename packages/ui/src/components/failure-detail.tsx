import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * A failing assertion: what broke, and the evidence for it.
 *
 * Distinct from `Callout`, which is a one-line notice with a glyph. This is the
 * two-part shape a diagnostic needs — a claim ("✗ applies migrations in order")
 * and the proof indented beneath it ("expected 4 to equal 3, at …:41:23"). The
 * left rule is what makes the second part read as subordinate rather than as a
 * second, equal notice.
 */
export function FailureDetail({
  title,
  children,
  className
}: {
  title: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-[7px] rounded-md border border-red/30 bg-red/[0.05] px-3 py-2.5 font-mono",
        className
      )}
    >
      <div className="text-[11.5px] leading-[1.5] text-red">{title}</div>
      {children && (
        <div className="border-l-2 border-line pl-3.5 text-[11px] leading-[1.6] text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  )
}
