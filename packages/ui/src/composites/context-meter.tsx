import type { ContextPhase } from "@starbase/core"
import { cn } from "../lib/cn.js"

/** "42.6k" / "980" — compact token count. */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

export interface ContextMeterProps {
  /** Latest working-set reading, in tokens. */
  tokens: number
  /** Where compaction fires: `min(budget, window × safety)`. Null = unmeasurable. */
  triggerAt: number | null
  /**
   * What the context manager will ACTUALLY do with this session.
   *
   * The meter must not re-derive this from `tokens / triggerAt`. `triggerAt` is
   * computed the moment the model's window is known, but compaction additionally
   * requires auto-compaction to be enabled AND the harness to report usage — so
   * `contextPhase` returns `"unknown"` in cases where the ratio is well past 1.
   * Labelling off the ratio is what made the meter sit on "compacting soon"
   * forever on sessions the manager had never intended to compact.
   */
  phase?: ContextPhase
  /** A summary is being built right now, on a background fiber. */
  preparing?: boolean
  /** A digest is built and the next turn will reseed. */
  digestReady?: boolean
  /** Consecutive digest failures hit the ceiling; nothing more will be tried. */
  stalled?: boolean
  /**
   * Compact this session now, ahead of the budget.
   *
   * Attached to the meter rather than hidden in a menu because the meter is
   * already where someone looks when they wonder about context — the moment
   * they want the control is the moment they are reading this.
   */
  onCompactNow?: () => void
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
  phase = "unknown",
  preparing = false,
  digestReady = false,
  stalled = false,
  onCompactNow,
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
  // A session that will never compact gets no warm tone: amber here reads as
  // "something is about to happen", and nothing is.
  const willCompact = phase === "prepare" || phase === "swap"
  const tone =
    preparing || digestReady
      ? "bg-blue/60"
      : stalled
        ? "bg-fg/25"
        : willCompact
          ? "bg-amber-400/70"
          : ratio >= 0.8 && phase !== "unknown"
            ? "bg-amber-400/45"
            : "bg-fg/25"

  /**
   * Four states, in the order they actually occur.
   *
   * `preparing` is the one that matters most and was missing: an automatic
   * compaction takes as long as a summary takes, and without a word for it the
   * meter sat on "compacting soon" throughout, which reads as stuck rather than
   * working. It is also the only state the user cannot cause themselves, so it
   * is the one they most need told about.
   */
  const label = preparing
    ? "compacting…"
    : digestReady
      ? "compacts next turn"
      : stalled
        ? "compaction failed"
        : willCompact
          ? "compacting soon"
          : "context"

  const title = `${tokens.toLocaleString()} of ~${triggerAt.toLocaleString()} tokens before Starbase compacts this session${
    preparing
      ? " · summarising in the background"
      : digestReady
        ? " · the next turn starts from a summary"
        : stalled
          ? " · automatic compaction gave up after repeated failures; click to try again"
          : phase === "unknown"
            ? " · automatic compaction is off for this session"
            : onCompactNow
              ? " · click to compact now"
              : ""
  }`

  // A plain span when there is nothing to click, so the meter never presents a
  // button that does nothing (a digest is already queued, or the harness gave
  // the host no handler).
  const busy = preparing || digestReady
  const Tag = onCompactNow && !busy ? "button" : "span"

  return (
    <Tag
      {...(Tag === "button"
        ? { type: "button" as const, onClick: onCompactNow, "aria-label": "Compact now" }
        : {})}
      className={cn(
        "flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground",
        Tag === "button" && "cursor-pointer transition-opacity hover:opacity-80",
        className
      )}
      title={title}
    >
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-fg/10">
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width]",
            tone,
            // Only while a summary is genuinely in flight — a pulse that never
            // stops is noise, and one that stops says "done".
            preparing && "animate-pulse"
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </span>
      <span>
        {fmtTokens(tokens)} <span className="text-dim">{label}</span>
      </span>
    </Tag>
  )
}
