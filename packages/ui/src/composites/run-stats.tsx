import { useEffect, useState } from "react"
import { Loader } from "lucide-react"
import { cn } from "../lib/cn.js"
import { fmtElapsed } from "../lib/relative-time.js"

/** "42.6k" / "980" — compact token count. */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

/**
 * Live session analytics — elapsed time (ticking while running) + the number of
 * tokens currently occupying the main agent's context window. Renders nothing
 * when there's no run and no context size to show.
 */
export function RunStats({
  startedAt,
  tokens,
  busy,
  className
}: {
  /** Epoch ms the run started, or null when idle. */
  startedAt: number | null
  tokens: number
  busy: boolean
  className?: string
}) {
  // Re-render each second while a run is in flight so the elapsed time advances.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy || startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy, startedAt])

  if (startedAt === null && tokens === 0) return null
  const elapsed = startedAt !== null ? fmtElapsed(now - startedAt) : null

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground",
        className
      )}
    >
      {busy && <Loader className="size-3 animate-spin text-dim" />}
      {elapsed && <span>{elapsed}</span>}
      {elapsed && tokens > 0 && <span className="text-dim">·</span>}
      {tokens > 0 && (
        <span>
          {fmtTokens(tokens)} <span className="text-dim">context tokens</span>
        </span>
      )}
    </span>
  )
}
