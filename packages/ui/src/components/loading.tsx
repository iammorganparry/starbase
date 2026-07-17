import { cn } from "../lib/cn.js"

/**
 * A small One Dark spinner.
 *
 * `tone="working"` is the command-widget variant — a yellow arc on the card's
 * line colour, marking the one row of a list that is mid-run. It reads as
 * activity against a dark card, where the default's transparent gap reads as a
 * gap. Distinct from `StatusDot pulse`, which says "this whole card is live":
 * a test-suite card uses both at once.
 */
export function Spinner({
  size = 14,
  tone = "loading",
  className
}: {
  size?: number
  tone?: "loading" | "working"
  className?: string
}) {
  return (
    <span
      className={cn(
        // flex-none: it has an explicit size, so it must never be the thing a
        // flex row shrinks.
        "inline-block flex-none rounded-full border-2 [animation:var(--animate-spin-fast)]",
        tone === "working" ? "border-line border-t-yellow" : "border-dim border-t-transparent",
        className
      )}
      style={{ width: size, height: size }}
    />
  )
}

/** A shimmering skeleton placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block h-5 rounded-md [background-size:220px_100%] [animation:var(--animate-shine)]",
        "bg-[linear-gradient(90deg,rgba(255,255,255,.02),rgba(255,255,255,.07),rgba(255,255,255,.02))]",
        className
      )}
    />
  )
}
