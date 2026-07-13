import type { CliKind, PermissionMode } from "@starbase/core"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"

/**
 * Read the user's *default* execution permission mode from their native CLI
 * config, so approving a plan drops them back into the mode they normally run in
 * (auto / accept-edits / ask) rather than a hardcoded guess. Best-effort and
 * pure at the mapping layer: a missing/garbled config falls back to `accept-edits`.
 * "plan" is never a valid result — we're picking the mode to *execute* under.
 */

const EXEC_FALLBACK: PermissionMode = "accept-edits"

/**
 * Map Claude Code's `settings.json` `permissions.defaultMode` onto our mode.
 * Claude values: "default" | "acceptEdits" | "plan" | "bypassPermissions".
 */
export const claudeDefaultMode = (settingsJson: string): PermissionMode => {
  const mode = ((): string | undefined => {
    try {
      const parsed = JSON.parse(settingsJson) as { permissions?: { defaultMode?: unknown } }
      const m = parsed.permissions?.defaultMode
      return typeof m === "string" ? m : undefined
    } catch {
      return undefined
    }
  })()
  switch (mode) {
    case "bypassPermissions":
      return "auto"
    case "acceptEdits":
      return "accept-edits"
    case "default":
      return "ask"
    // "plan" (and anything unknown) — never restore into plan; use the exec default.
    default:
      return EXEC_FALLBACK
  }
}

/**
 * Map Codex's `config.toml` (`approval_policy` + `sandbox_mode`) onto our mode.
 * We read it with a light regex rather than pulling in a TOML parser — the two
 * keys are simple string assignments. Codex approval values: "untrusted" |
 * "on-failure" | "on-request" | "never"; sandbox: "read-only" | "workspace-write"
 * | "danger-full-access".
 */
export const codexDefaultMode = (configToml: string): PermissionMode => {
  const val = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(configToml)?.[1]
  const approval = val("approval_policy")
  const sandbox = val("sandbox_mode")
  if (approval === "never" || sandbox === "danger-full-access") return "auto"
  if (approval === "on-failure" || sandbox === "workspace-write") return "accept-edits"
  if (approval === "on-request" || approval === "untrusted" || sandbox === "read-only") return "ask"
  return EXEC_FALLBACK
}

/**
 * Read `~/.claude/settings.json` (claude/cursor) or `~/.codex/config.toml`
 * (codex) and resolve the user's default execution mode. Never fails — a missing
 * file resolves to `accept-edits`.
 */
export const readDefaultMode = (
  cli: CliKind,
  homeDir: string
): Effect.Effect<PermissionMode, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
    if (cli === "codex") {
      const toml = yield* read(`${homeDir}/.codex/config.toml`)
      return toml.length > 0 ? codexDefaultMode(toml) : EXEC_FALLBACK
    }
    const json = yield* read(`${homeDir}/.claude/settings.json`)
    return json.length > 0 ? claudeDefaultMode(json) : EXEC_FALLBACK
  })
