import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { CommandLine } from "../components/command-line.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "./tool-call.js"

/**
 * The frame every command widget shares.
 *
 * Reading the design board, all ten widgets are one shape with a different
 * middle: a header naming the command, a body, and a footer stating the outcome.
 * Keeping that here means a new widget only has to answer "what goes in the
 * middle", and the ten cards stay in lockstep when the frame changes.
 *
 * The tone (border + header tint) is the card's whole status at a glance, from
 * across the transcript, before you read a word of it.
 */
export type WidgetTone = "live" | "done" | "failed"

const toneFrame: Record<WidgetTone, string> = {
  // Blue, not yellow: yellow is the agent's *own* thinking state elsewhere in
  // the transcript. A running command is the app watching something external.
  live: "border-blue/[0.32]",
  done: "border-line",
  failed: "border-red/35"
}

const toneHeader: Record<WidgetTone, string> = {
  live: "bg-blue/[0.06]",
  done: "bg-panel",
  failed: "bg-red/[0.06]"
}

export const toneOf = (status: ToolCallStatus): WidgetTone =>
  status === "running" ? "live" : status === "error" ? "failed" : "done"

export interface CommandWidgetProps {
  tone: WidgetTone
  /** The command as the agent wrote it. */
  command: string
  /**
   * Replaces the default status glyph — a database/git icon, a green "listening"
   * dot. Defaults to ✓ / ✗ / a pulsing dot.
   */
  icon?: ReactNode
  /** Right of the header: "running · 3.2s", "1 warning", "200 OK". */
  headerMeta?: ReactNode
  children?: ReactNode
  /** Left of the footer: "built in 4.12s", "3 errors · 2 files". Omit for no footer. */
  footer?: ReactNode
  /** Right of the footer: "exit 0". */
  footerMeta?: ReactNode
  className?: string
}

const defaultIcon = (tone: WidgetTone): ReactNode =>
  tone === "done" ? (
    <span className="text-green">✓</span>
  ) : tone === "failed" ? (
    <span className="text-red">✗</span>
  ) : (
    <StatusDot tone="bg-yellow" size={9} pulse />
  )

/** A rich render of one bash command — header, body, outcome. */
export function CommandWidget({
  tone,
  command,
  icon,
  headerMeta,
  children,
  footer,
  footerMeta,
  className
}: CommandWidgetProps) {
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-xl border bg-sunken text-text",
        toneFrame[tone],
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-[9px] border-b border-hairline px-3 py-2.5",
          toneHeader[tone]
        )}
      >
        {icon ?? defaultIcon(tone)}
        <CommandLine command={command} className="min-w-0 flex-1" />
        {headerMeta && <span className="flex-none text-[10.5px]">{headerMeta}</span>}
      </div>
      {children}
      {(footer || footerMeta) && (
        <div className="flex items-center gap-3 border-t border-hairline px-3.5 py-2.5 font-mono text-[11px] text-muted-foreground">
          {footer}
          <div className="flex-1" />
          {footerMeta && <span className="flex-none">{footerMeta}</span>}
        </div>
      )}
    </div>
  )
}

/** The standard padded body stack. Widgets with their own padding skip it. */
export function WidgetBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-[11px] px-4 py-3.5", className)}>{children}</div>
}
