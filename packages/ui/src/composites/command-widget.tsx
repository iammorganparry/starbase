import { type ReactNode, useState } from "react"
import { cn } from "../lib/cn.js"
import { CommandLine } from "../components/command-line.js"
import { ToolCall, type ToolCallStatus } from "./tool-call.js"

/**
 * The frame every command widget shares.
 *
 * All ten widgets are one shape with a different middle: a row naming the
 * command, a body, and a footer stating the outcome. Keeping that here means a
 * new widget only has to answer "what goes in the middle", and the ten stay in
 * lockstep when the frame changes.
 *
 * That row IS `ToolCall` — the same component a Read or a Grep renders. Not a
 * lookalike: a bespoke row built to the same spec drifted from it within one
 * change (rounder corners, a bigger font, no surface tint), and a bash call
 * sitting beside a Read call in the transcript made the mismatch obvious. A
 * command is a tool call, so it gets the tool call's row, and the only thing
 * that makes it a command is what sits INSIDE the row: `❯ vitest run` in place
 * of a file path, and the widget's own summary in place of a line count.
 *
 * Every widget therefore rests as that row and opens into its rich body on
 * demand — a transcript is read by scrolling past commands, not by studying
 * each one, so a screenful of always-open scoreboards buries the conversation
 * between them.
 */
export type WidgetTone = "live" | "done" | "failed"

export const toneOf = (status: ToolCallStatus): WidgetTone =>
  status === "running" ? "live" : status === "error" ? "failed" : "done"

/** `toneOf` backwards — the row speaks in tool-call status, widgets in tone. */
const statusOf = (tone: WidgetTone): ToolCallStatus =>
  tone === "live" ? "running" : tone === "failed" ? "error" : "success"

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
  /**
   * The collapsed row's one-line story, right of the command.
   *
   * Defaults to `footerMeta` (the exit label, near enough every widget) falling
   * back to `footer`. Deliberately NOT both, and not the footer alongside the
   * header badge: those three are three phrasings of one fact, and a row reading
   * "2 failed · 2 failed · 3.20s · failed" is noise where the point was density.
   * The badge says what happened, this says how it ended.
   *
   * Override where the open card's real summary lives in the footer instead —
   * a check tally, a row count — and the exit code alone would waste the row.
   * Pass `null` to say the badge already tells the whole story.
   */
  summary?: ReactNode
  className?: string
}

/** A rich render of one bash command — a tool-call row, its body, its outcome. */
export function CommandWidget({
  tone,
  command,
  icon,
  headerMeta,
  children,
  footer,
  footerMeta,
  summary,
  className
}: CommandWidgetProps) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((v) => !v)

  return (
    <ToolCall
      status={statusOf(tone)}
      // No name: `❯ vitest run` says "this is a command" better than the word
      // "Bash" does, and the row's job is to get you to the command fast.
      statusIcon={icon}
      target={
        // 11.5px, not the atom's default 12.5px — the row sets the type size for
        // every tool call, and a command is not a louder kind of tool call.
        <CommandLine command={command} className="text-[11.5px]" />
      }
      meta={
        <span className="flex items-center gap-2.5">
          {headerMeta}
          {/* Once open, the footer states the outcome in full; repeating it up
              here would say the same thing twice on one screen. */}
          {!expanded &&
            /* `!== undefined`, not `??`: an explicit `null` is a widget saying
               "the badge covers it", and must not fall through to the default. */
            (summary !== undefined ? summary : (footerMeta ?? footer))}
        </span>
      }
      expanded={expanded}
      onToggle={toggle}
      className={className}
    >
      {expanded && (
        <div className="border-t border-line bg-editor">
          {children}
          {(footer || footerMeta) && (
            <div
              className={cn(
                "flex items-center gap-3 px-3 py-1.5 font-mono text-[11px] text-muted-foreground",
                // No rule above the footer when the body already ends in one —
                // only when the footer is carrying the card on its own.
                children == null ? "" : "border-t border-line/60"
              )}
            >
              {footer}
              <div className="flex-1" />
              {footerMeta && <span className="flex-none">{footerMeta}</span>}
            </div>
          )}
        </div>
      )}
    </ToolCall>
  )
}

/**
 * The standard padded body stack. Widgets with their own padding skip it.
 *
 * Sets the body's type once, and it is the type an expanded Read or Edit uses:
 * 11px mono at 1.5, muted. A widget body is the same kind of thing as the log
 * an expanded tool call shows — a denser reading of it — so it is not a louder
 * kind of thing. Widgets brighten and colour INSIDE this; none of them restate
 * the size.
 */
export function WidgetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2 font-mono text-[11px] leading-[1.5] text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}
