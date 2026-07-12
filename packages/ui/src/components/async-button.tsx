import { type ReactNode, useEffect, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { cn } from "../lib/cn.js"

type AsyncState = "idle" | "pending" | "success" | "error"

const VARIANT: Record<string, string> = {
  primary: "bg-blue text-editor",
  secondary: "border border-line bg-surface text-text-body",
  danger: "border border-red/45 bg-transparent text-red"
}
const SUCCESS = "bg-green text-editor"

/** A small spinner ring (design's pending state). */
function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-[13px] flex-none animate-spin-fast rounded-full border-2 border-current/30 border-t-current",
        className
      )}
    />
  )
}

/** An animated "draw-in" check mark (design's success state). */
function CheckDraw() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="flex-none">
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={22}
        className="animate-check"
      />
    </svg>
  )
}

/**
 * A button for async / agent actions with built-in feedback:
 * idle → pending (spinner + disabled) → success (green + check draw) → auto-reset
 * after 1.6s; a failure shakes once and shows a retry label. Set `terminal` (or
 * `done`) to hold the success state so the action can't be re-fired — used for
 * "Send to agent" so a comment isn't sent twice. The width is locked on first run
 * so the row never reflows between states.
 */
export function AsyncButton({
  children,
  pendingLabel,
  successLabel = "Done",
  errorLabel = "Failed — retry",
  doneLabel,
  onClick,
  variant = "primary",
  terminal = false,
  done = false,
  disabled = false,
  icon,
  size = "sm",
  className
}: {
  children: ReactNode
  /** Label while the promise is pending (defaults to the idle label). */
  pendingLabel?: ReactNode
  successLabel?: ReactNode
  errorLabel?: ReactNode
  /** Label shown when held in the terminal `done` state (defaults to successLabel). */
  doneLabel?: ReactNode
  onClick: () => Promise<void> | void
  variant?: keyof typeof VARIANT
  /** Hold the success state after completing (no reset) — the action can't re-fire. */
  terminal?: boolean
  /** Externally-controlled terminal success (already done, e.g. persisted "sent"). */
  done?: boolean
  disabled?: boolean
  icon?: ReactNode
  size?: "sm" | "md"
  className?: string
}) {
  const [state, setState] = useState<AsyncState>("idle")
  const ref = useRef<HTMLButtonElement>(null)
  const [minW, setMinW] = useState<number>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const effective: AsyncState = done ? "success" : state
  const held = terminal || done // stays in success (no resend)
  const locked = effective !== "idle" || disabled

  const run = () => {
    if (locked) return
    if (ref.current) setMinW(ref.current.offsetWidth)
    setState("pending")
    Promise.resolve()
      .then(() => onClick())
      .then(() => {
        setState("success")
        if (!terminal) timer.current = setTimeout(() => setState("idle"), 1600)
      })
      .catch(() => {
        setState("error")
        timer.current = setTimeout(() => setState("idle"), 1100)
      })
  }

  const tone =
    effective === "success"
      ? SUCCESS
      : effective === "error"
        ? "border border-red/45 bg-transparent text-red animate-shake"
        : VARIANT[variant]

  return (
    <button
      ref={ref}
      type="button"
      disabled={locked}
      onClick={run}
      style={minW ? { minWidth: minW } : undefined}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-semibold outline-none transition-[color,background-color,border-color,scale] duration-100 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:cursor-default disabled:active:scale-100",
        size === "md" ? "px-3.5 py-1.5 text-[13px]" : "px-3 py-1 text-[12px]",
        tone,
        className
      )}
    >
      {effective === "pending" ? (
        <>
          <Spinner />
          {pendingLabel ?? children}
        </>
      ) : effective === "success" ? (
        <>
          <CheckDraw />
          {held ? (doneLabel ?? successLabel) : successLabel}
        </>
      ) : effective === "error" ? (
        <>
          <TriangleAlert size={14} />
          {errorLabel}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  )
}
