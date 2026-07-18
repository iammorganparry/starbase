import { cn } from "../lib/cn.js"

export type StatTone = "green" | "red" | "dim" | "yellow"

const toneClass: Record<StatTone, string> = {
  green: "text-green",
  red: "text-red",
  yellow: "text-yellow",
  dim: "text-dim"
}

/**
 * A number and what it counts — `128 passed`.
 *
 * Was a 26px display number stacked over its label, which made a test run the
 * loudest thing in a transcript of 11px tool calls: scrolling past a Read, a
 * Grep and a vitest, only the vitest shouted. The count is the same fact at
 * reading size, inline, so a scoreboard is a dense line rather than a billboard.
 *
 * `tabular-nums` so a counter ticking 98 → 128 doesn't shove the label along,
 * which is the whole point of showing it live.
 */
export function StatCount({
  value,
  label,
  tone = "dim",
  className
}: {
  value: number | string
  label: string
  tone?: StatTone
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-mono text-[11px]", className)}>
      <span className={cn("tabular-nums", toneClass[tone])}>{value}</span>
      <span className="text-dim">{label}</span>
    </span>
  )
}
