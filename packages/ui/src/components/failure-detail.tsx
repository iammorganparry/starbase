import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * A failing assertion: what broke, and the evidence for it.
 *
 * Distinct from `Callout`, which is a one-line notice with a glyph. This is the
 * two-part shape a diagnostic needs — a claim ("✗ applies migrations in order")
 * and the proof indented beneath it ("expected 4 to equal 3, at …:41:23").
 *
 * A single red rule down the left, not a bordered and tinted box. An expanded
 * tool call is a flat body — its own output sits on `bg-editor` with nothing
 * drawn round it — and a card nested inside that body reads as a second panel
 * floating on the first. The rule carries the same two jobs the box did: it
 * marks the block as a failure, and it makes the evidence subordinate to the
 * claim it sits under.
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
    <div className={cn("flex flex-col gap-0.5 border-l-2 border-red/50 pl-2.5 font-mono", className)}>
      <div className="text-[11px] leading-[1.5] text-red">{title}</div>
      {children && <div className="text-[11px] leading-[1.5] text-dim">{children}</div>}
    </div>
  )
}
