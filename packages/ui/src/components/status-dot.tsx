import type { SessionStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { statusDotClass, statusPulses } from "../tokens.js"

const glowColor: Record<string, string> = {
  "bg-yellow": "shadow-[0_0_8px_var(--sb-yellow)]",
  "bg-blue": "shadow-[0_0_8px_var(--sb-blue)]",
  "bg-green": "shadow-[0_0_8px_var(--sb-green)]",
  "bg-red": "shadow-[0_0_8px_var(--sb-red)]"
}

export interface StatusDotProps {
  /** Domain status; sets color + pulse automatically. */
  status?: SessionStatus
  /** Or an explicit Tailwind bg color class (e.g. "bg-green"). */
  tone?: string
  size?: number
  glow?: boolean
  pulse?: boolean
  className?: string
}

/** The One Dark status dot — optionally glowing and pulsing. */
export function StatusDot({ status, tone, size = 8, glow, pulse, className }: StatusDotProps) {
  const bg = tone ?? (status ? statusDotClass[status] : "bg-line-strong")
  const shouldPulse = pulse ?? (status ? statusPulses(status) : false)
  const shouldGlow = glow ?? shouldPulse
  return (
    <span
      className={cn(
        "inline-block flex-none rounded-full",
        bg,
        shouldGlow && glowColor[bg],
        shouldPulse && "[animation:var(--animate-pulse-dot)]",
        className
      )}
      style={{ width: size, height: size }}
    />
  )
}
