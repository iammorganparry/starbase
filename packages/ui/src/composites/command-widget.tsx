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
 *
 * ON COLOUR, since this reverses a decision worth reversing explicitly. The
 * card these widgets used to be tinted a RUNNING command blue, on the argument
 * that yellow is the agent's own thinking state and a command is external work.
 * A running command now takes ToolCall's yellow, like every other running tool
 * call. The old argument sorted by *who is working*; this sorts by *what kind
 * of thing this is*, and the second is what a reader actually scans for — a
 * column of tool calls where one is a different colour reads as a different
 * kind of row, not as "this one is external". Blue would have to be threaded
 * back through `ToolCall` for every tool to keep that distinction honest, and
 * no other tool wants it.
 */
export interface CommandWidgetProps {
  /**
   * The command's state, in the row's own vocabulary.
   *
   * This was a `WidgetTone` ("live" | "done" | "failed") back when the card
   * painted its own border and header tint from it. `ToolCall` owns that now,
   * so a tone type would be `ToolCallStatus` under another name — every widget
   * mapping status → tone and this component mapping it straight back, a
   * bijection composed with its inverse that both sides had to be read to see
   * cancelled out. Widgets that want to *override* the state still do (a
   * listening dev server reports success; a linter with errors reports error) —
   * they now say so in the vocabulary the row actually uses.
   */
  status: ToolCallStatus
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
  status,
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

  /*
   * `!== undefined`, not `??`: an explicit `null` is a widget saying "the badge
   * covers it", and must not fall through to the default.
   */
  const resolvedSummary = summary !== undefined ? summary : (footerMeta ?? footer)
  /*
   * What the row says on the right. Once open, the footer states the outcome in
   * full, so the row drops the summary and keeps only the badge — repeating it
   * would say the same thing twice on one screen.
   */
  const rowMeta = expanded
    ? headerMeta
    : headerMeta && resolvedSummary
      ? (
          <span className="flex items-center gap-2.5">
            {headerMeta}
            {resolvedSummary}
          </span>
        )
      : (headerMeta ?? resolvedSummary)
  /*
   * A widget's body is routinely conditional JSX (`{n > 0 && <div/>}`), which
   * yields `false`, not null, when the condition fails. `Boolean(children)` —
   * never `children == null` — so an absent body reads as absent: otherwise the
   * footer draws its own rule directly under the body wrapper's, two hairlines
   * with nothing between them.
   */
  const hasBody = Boolean(children)

  return (
    <ToolCall
      status={status}
      // No name: `❯ vitest run` says "this is a command" better than the word
      // "Bash" does, and the row's job is to get you to the command fast.
      statusIcon={icon}
      target={
        // 11.5px, not the atom's default 12.5px — the row sets the type size for
        // every tool call, and a command is not a louder kind of tool call.
        <CommandLine command={command} className="text-[11.5px]" />
      }
      // `|| undefined` so an empty result reaches ToolCall's own `meta &&`
      // guard. An always-rendered wrapper span defeats it and leaves an empty
      // flex item widening the gap before the chevron — visible against a
      // plain row, which is the parity this frame is for.
      meta={rowMeta || undefined}
      expanded={expanded}
      onToggle={toggle}
      className={className}
    >
      {/*
       * `undefined` when collapsed, NOT `false`. ToolCall shows its running
       * shimmer only for `children == null`, so passing `false` would suppress
       * the live-work bar on a running collapsed command while an identical
       * running Read still showed it — losing the very parity this frame exists
       * to establish.
       */}
      {expanded ? (
        <div className="border-t border-line bg-editor">
          {children}
          {(footer || footerMeta) && (
            <div
              className={cn(
                "flex items-center gap-3 px-3 py-1.5 font-mono text-[11px] text-muted-foreground",
                // No rule above the footer when the body already ends in one —
                // only when the footer is carrying the card on its own.
                hasBody && "border-t border-line/60"
              )}
            >
              {footer}
              <div className="flex-1" />
              {footerMeta && <span className="flex-none">{footerMeta}</span>}
            </div>
          )}
        </div>
      ) : undefined}
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
