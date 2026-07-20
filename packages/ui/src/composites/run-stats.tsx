import { useEffect, useState } from "react"
import { Loader } from "lucide-react"
import { cn } from "../lib/cn.js"
import { fmtElapsed } from "../lib/relative-time.js"

/**
 * Live run analytics — elapsed time, ticking while running. Renders nothing
 * when there is no run.
 *
 * The context size deliberately does NOT live here. `ContextMeter` owns that
 * reading: it draws the same number against the point where compaction fires,
 * which is the only framing that makes the count actionable. This component
 * used to print it too, and the pair sat side by side above the composer
 * showing the identical figure twice ("472.2k compacting soon · 472.2k context
 * tokens") — a duplicate that survived because the meter was added ALONGSIDE
 * this readout rather than replacing it.
 */
export function RunStats({
  startedAt,
  busy,
  className
}: {
  /** Epoch ms the run started, or null when idle. */
  startedAt: number | null
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

  if (startedAt === null) return null
  const elapsed = fmtElapsed(now - startedAt)

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground",
        className
      )}
    >
      {busy && <Loader className="size-3 animate-spin text-dim" />}
      <span>{elapsed}</span>
    </span>
  )
}
