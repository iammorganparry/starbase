import type { ReactNode } from "react"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { buildWidget } from "./build.js"
import { ciChecksWidget } from "./ci-checks.js"
import { parseCommand } from "./command.js"
import { dbQueryWidget } from "./db-query.js"
import { devServerWidget } from "./dev-server.js"
import { diagnosticsWidget } from "./diagnostics.js"
import { genericWidget } from "./generic.js"
import { gitOpWidget } from "./git-op.js"
import { httpRequestWidget } from "./http-request.js"
import { packageInstallWidget } from "./package-install.js"
import { testRunnerWidget } from "./test-runner.js"
import type { CommandWidgetSpec } from "./types.js"

/**
 * The command → widget registry.
 *
 * Order is precedence: the first spec whose `match` accepts the command wins, so
 * specific families come before general ones. `genericWidget` matches everything
 * and is therefore always last — it is the floor, not a peer.
 *
 * Two ways out to the plain tool card, both deliberate:
 *   1. no spec matches (impossible today, since generic matches all), or
 *   2. the matched spec's `parse` returns null — "I don't recognise this shape".
 *
 * (2) is the important one. It means adding a widget can never make a command
 * render *worse* than it does today: unfamiliar output falls back intact.
 */
const SPECS: ReadonlyArray<CommandWidgetSpec<unknown>> = [
  testRunnerWidget,
  /*
   * `build` MUST precede `dev-server`: `vite build` and `next build` satisfy
   * both (dev-server claims the program, build claims the sub-command), and a
   * production build rendered as a dev server would be actively wrong. The
   * sub-command is the more specific fact, so it wins.
   */
  buildWidget,
  devServerWidget,
  diagnosticsWidget,
  packageInstallWidget,
  ciChecksWidget,
  gitOpWidget,
  dbQueryWidget,
  httpRequestWidget,
  genericWidget
]

export interface WidgetInput {
  command: string
  output: string | undefined
  status: ToolCallStatus
  /** The adapter's own word on the result — codex's real `exit 127`, opencode's
   *  error message. For codex bash calls it is the ONLY payload there is. */
  meta?: string | null
}

export interface ResolvedWidget {
  /** The spec that took the command — `"test-runner"`, `"generic"`, … */
  id: string
  node: ReactNode
}

/**
 * Pick and render a widget for a bash call, or return null to let the caller
 * fall back to the generic `ToolCall` card.
 *
 * Returns the winning spec's `id` alongside the node so the caller can label the
 * DOM with it. That label is the only way to tell "the build widget rendered"
 * from "the generic card rendered and happens to mention a file size" — by text
 * alone the two are easy to confuse, and a widget silently degrading to the
 * fallback is exactly the regression worth catching.
 */
export const renderCommandWidget = ({ command, output, status, meta = null }: WidgetInput): ResolvedWidget | null => {
  const parsed = parseCommand(command)
  for (const spec of SPECS) {
    if (!spec.match(parsed)) continue
    const props = spec.parse({ command: parsed, output, status, meta })
    if (props === null) continue // declined — try the next, ending at generic
    return { id: spec.id, node: spec.render(props) }
  }
  return null
}

/** Which widget a command resolves to, without rendering. For tests + stories. */
export const classifyCommand = (command: string): string | null => {
  const parsed = parseCommand(command)
  return SPECS.find((s) => s.match(parsed))?.id ?? null
}
