import { cn } from "../lib/cn.js"

export type StatTone = "green" | "red" | "dim" | "yellow"

const toneClass: Record<StatTone, string> = {
  green: "text-green",
  red: "text-red",
  yellow: "text-yellow",
  dim: "text-dim"
}

/**
 * A headline number over its label — the test-runner scoreboard.
 *
 * `tabular-nums` so a counter ticking 98 → 128 doesn't shift the label under it,
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
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className={cn("font-mono text-[26px] font-semibold leading-none tabular-nums", toneClass[tone])}>
        {value}
      </span>
      <span className="text-[10.5px] tracking-[0.3px] text-dim">{label}</span>
    </div>
  )
}
