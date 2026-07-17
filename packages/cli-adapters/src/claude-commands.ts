import { query } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"

/**
 * What the Claude CLI says it can do — its slash commands and its skills, taken
 * from the harness itself rather than guessed.
 */
export interface ClaudeCapabilities {
  /**
   * Every `/` command the CLI exposes: its own built-ins (`goal`, `init`,
   * `compact`, …), file-based skills, and plugin commands (`figma:figma-use`).
   * Bare names — no leading slash.
   */
  readonly commands: ReadonlyArray<string>
  /** The subset that are skills rather than built-in commands. Bare names. */
  readonly skills: ReadonlyArray<string>
}

export const NO_CAPABILITIES: ClaudeCapabilities = { commands: [], skills: [] }

/**
 * Commands the CLI reports but nobody should be offered — internal plumbing that
 * would only be noise in the `/` menu.
 */
const isInternal = (name: string): boolean => name.startsWith("__")

/** How long to wait for the CLI to announce itself before giving up. */
const PROBE_TIMEOUT = "20 seconds"

/**
 * Ask the Claude CLI what commands it has.
 *
 * The CLI announces its whole surface — `slash_commands`, `skills`, `plugins` —
 * on the `system/init` message, and nowhere else: there's no `--list-commands`.
 * So the only way to know is to start a query and read the announcement.
 *
 * This costs no model turn. `init` is emitted while the CLI boots, before the
 * prompt is looked at — the only messages ahead of it are local session hooks
 * (measured: hooks at ~2.1s, init at ~2.2s, no `assistant` message in between).
 * We stop reading there and drop the iterator, so the model is never reached.
 *
 * Best-effort by construction: any failure yields no capabilities, and the
 * caller falls back to scanning the skills directories. A `/` menu that's
 * missing the built-ins beats an app that won't start.
 */
export const probeClaudeCapabilities = (
  binPath: string | null,
  cwd: string | null
): Effect.Effect<ClaudeCapabilities> =>
  Effect.tryPromise(async () => {
    const iterator = query({
      // Never processed: we stop at `init`, which precedes the prompt entirely.
      prompt: "",
      options: {
        cwd: cwd || undefined,
        pathToClaudeCodeExecutable: binPath ?? undefined,
        maxTurns: 1
      }
    })
    try {
      for await (const message of iterator) {
        if (message.type !== "system" || message.subtype !== "init") continue
        const init = message as unknown as {
          slash_commands?: ReadonlyArray<string>
          skills?: ReadonlyArray<string>
        }
        return {
          commands: (init.slash_commands ?? []).filter((c) => !isInternal(c)),
          skills: init.skills ?? []
        }
      }
      return NO_CAPABILITIES
    } finally {
      // Abandon the run: we only ever wanted the CLI's opening statement.
      await iterator.return?.(undefined).catch(() => {})
    }
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => NO_CAPABILITIES)
  )
