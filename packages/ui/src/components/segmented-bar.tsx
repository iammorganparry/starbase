import { cn } from "../lib/cn.js"

export interface BarSegment {
  /** Relative weight. Segments with `value <= 0` are dropped, not rendered at 0px. */
  value: number
  /** Tailwind bg class, e.g. "bg-green". */
  tone: string
  label?: string
  /** Sweep a highlight across this segment — the work still outstanding. */
  shine?: boolean
}

/**
 * A proportional stacked bar — pass/fail/skip/remaining in one glance.
 *
 * Uses flex-grow weights rather than percentages so the segments always fill the
 * track exactly, with no rounding gap at the end. The `shine` segment carries
 * the liveness: a static remainder would read as "stalled".
 */
export function SegmentedBar({
  segments,
  className
}: {
  segments: ReadonlyArray<BarSegment>
  className?: string
}) {
  const shown = segments.filter((s) => s.value > 0)
  return (
    <div className={cn("flex h-2 gap-[2px] overflow-hidden rounded-sm bg-hairline", className)}>
      {shown.map((s, i) => (
        <span
          key={i}
          title={s.label}
          className={cn("relative overflow-hidden", s.tone)}
          style={{ flex: s.value }}
        >
          {s.shine && (
            <span className="absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-blue/55 to-transparent [animation:var(--animate-shine-sweep)]" />
          )}
        </span>
      ))}
    </div>
  )
}
