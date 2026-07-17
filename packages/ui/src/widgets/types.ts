import type { ReactNode } from "react"
import type { ToolCallStatus } from "../composites/tool-call.js"
import type { ParsedCommand } from "./command.js"

/** Everything a widget gets to work with — the command, what it printed, how it ended. */
export interface ParseContext {
  command: ParsedCommand
  /**
   * What the command printed. `undefined` while it is still running (no output
   * has arrived yet), NOT the empty string — a command that printed nothing and
   * a command that hasn't printed yet are different facts.
   *
   * Long output is capped by the adapter keeping BOTH ends with a
   * `… N characters omitted …` marker in the middle, so a parser must never
   * assume it can see the whole log. Anchor on the head or the tail.
   */
  output: string | undefined
  status: ToolCallStatus
}

/**
 * One command family's widget: how to recognise it, how to read its output, and
 * how to draw it.
 *
 * `parse` returning `null` is a first-class outcome, not a failure — it means
 * "this output isn't the shape I know", and the caller falls back to the plain
 * tool card. Parsers face unbounded real-world output, so declining is the
 * behaviour that keeps a widget from ever *losing* information relative to the
 * generic renderer.
 */
export interface CommandWidgetSpec<P = unknown> {
  id: string
  match: (command: ParsedCommand) => boolean
  parse: (ctx: ParseContext) => P | null
  render: (props: P) => ReactNode
}

/** Helper so each widget module can stay fully typed without restating P. */
export const defineWidget = <P,>(spec: CommandWidgetSpec<P>): CommandWidgetSpec<unknown> =>
  spec as CommandWidgetSpec<unknown>
