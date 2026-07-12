import type { ReactNode } from "react"
import { Check, X } from "lucide-react"
import { cn } from "../lib/cn.js"

/** Three bouncing dots — the "agent is thinking" cue. */
function ThinkingDots() {
  return (
    <span className="flex flex-none gap-[3px]">
      {[0, 0.18, 0.36].map((delay) => (
        <span
          key={delay}
          className="size-[5px] animate-pulse-dot rounded-full bg-current"
          style={{ animationDelay: `${delay}s`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  )
}

/**
 * A compact inline status line with feedback states — a spinner while working, the
 * bouncing "thinking" dots for the agent, or a check / x that slides in on
 * settle. Use next to async / agent actions.
 */
export function InlineStatus({
  variant,
  children,
  className
}: {
  variant: "loading" | "thinking" | "success" | "error"
  children: ReactNode
  className?: string
}) {
  const tone =
    variant === "success"
      ? "text-green animate-slide-in"
      : variant === "error"
        ? "text-red animate-slide-in"
        : variant === "thinking"
          ? "text-yellow"
          : "text-muted-foreground"

  return (
    <span className={cn("inline-flex items-center gap-2 text-[12px]", tone, className)}>
      {variant === "loading" && (
        <span className="inline-block size-[13px] flex-none animate-spin-fast rounded-full border-2 border-current/30 border-t-current" />
      )}
      {variant === "thinking" && <ThinkingDots />}
      {variant === "success" && <Check size={14} className="flex-none" />}
      {variant === "error" && <X size={14} className="flex-none" />}
      {children}
    </span>
  )
}

/**
 * A thin progress bar. With `progress` (0–1) it fills determinately; without, it
 * runs an indeterminate sweep — the "agent working, unknown duration" cue.
 */
export function IndeterminateBar({
  progress,
  tone = "bg-blue",
  className
}: {
  progress?: number
  tone?: string
  className?: string
}) {
  const determinate = typeof progress === "number"
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-surface", className)}>
      {determinate ? (
        <span
          className={cn("block h-full rounded-full transition-[width] duration-300", tone)}
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      ) : (
        <span className={cn("block h-full w-1/3 animate-bar rounded-full", tone)} />
      )}
    </div>
  )
}
