import { cn } from "../lib/cn.js"

/** "42.6k" / "980" — compact token count. */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

export interface ContextMeterProps {
  /** Latest working-set reading, in tokens. */
  tokens: number
  /** Where compaction fires: `min(budget, window × safety)`. Null = unmeasurable. */
  triggerAt: number | null
  /** A digest is built and the next turn will reseed. */
  digestReady?: boolean
  className?: string
}

/**
 * How full the model's working set is, measured against the point at which
 * Starbase will compact it — NOT against the model's hard ceiling.
 *
 * That distinction is the entire feature made visible. A 1M-window model shows
 * this meter near full at ~300k, because 300k is where quality starts to go, and
 * a bar that sat at 30% there would be telling the user the opposite of what
 * matters. The hard window is deliberately not drawn: it is a backstop, not a
 * target, and showing 700k of "available" space would invite exactly the usage
 * this exists to prevent.
 *
 * Renders nothing when the harness cannot report context (`triggerAt === null`),
 * rather than showing an empty bar that reads as "plenty of room left".
 */
export function ContextMeter({
  tokens,
  triggerAt,
  digestReady = false,
  className
}: ContextMeterProps) {
  if (triggerAt === null || triggerAt <= 0) return null
  if (tokens <= 0) return null

  const ratio = Math.min(1, tokens / triggerAt)
  const pct = Math.round(ratio * 100)

  // Three states, and none of them is an alarm. Crossing the trigger is the
  // system working — a digest is being prepared and the next turn will be
  // cheaper — so the top of the range is "warm", never red. Red would train the
  // user to intervene in something that handles itself.
  const tone =
    ratio >= 1 ? "bg-amber-400/70" : ratio >= 0.8 ? "bg-amber-400/45" : "bg-fg/25"

  const label = digestReady
    ? "compacting next turn"
    : ratio >= 1
      ? "compacting soon"
      : "context"

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground",
        className
      )}
      title={`${tokens.toLocaleString()} of ~${triggerAt.toLocaleString()} tokens before Starbase compacts this session`}
    >
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-fg/10">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width]", tone)}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </span>
      <span>
        {fmtTokens(tokens)} <span className="text-dim">{label}</span>
      </span>
    </span>
  )
}
