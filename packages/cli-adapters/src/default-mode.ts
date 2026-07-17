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
 * Map opencode's `opencode.json` `permission` block onto our mode. It is either
 * a blanket action (`"permission": "allow"`) or per-tool
 * (`{ edit: "allow", bash: "ask" }`), where each value is `"ask" | "allow" |
 * "deny"` — or an object of glob→action for finer rules.
 *
 * A glob object is deliberately NOT treated as a blanket grant: `{ bash: { "*":
 * "ask", "git *": "allow" } }` means the user wants to be asked about most
 * commands, so the mode that respects it is `ask`. Only an unconditional
 * `"allow"` earns `auto`.
 *
 * `deny` maps to `ask` rather than anything stricter: we're picking the mode to
 * *execute* under, and Starbase has no "refuse everything" execution mode — the
 * gate will still ask, and the user can decline.
 */
export const opencodeDefaultMode = (configJson: string): PermissionMode => {
  const permission = ((): unknown => {
    try {
      // opencode's config permits comments and trailing commas (its schema sets
      // allowComments/allowTrailingCommas). `JSON.parse` rejects those, and a
      // user's commented config then reads as "no config" → the fallback. That's
      // the right failure: a wrong guess at their mode would be worse than the
      // conservative default.
      return (JSON.parse(configJson) as { permission?: unknown }).permission
    } catch {
      return undefined
    }
  })()
  if (permission === undefined) return EXEC_FALLBACK

  // Blanket form: `"permission": "allow"`.
  if (typeof permission === "string") return permission === "allow" ? "auto" : "ask"
  if (typeof permission !== "object" || permission === null) return EXEC_FALLBACK

  const rules = permission as Record<string, unknown>
  // Only a bare string is an unconditional action; an object is a glob ruleset.
  const action = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined
  const star = action(rules["*"])
  const edit = action(rules.edit) ?? star
  const bash = action(rules.bash) ?? star

  if (edit === "allow" && bash === "allow") return "auto"
  if (edit === "allow") return "accept-edits"
  if (edit !== undefined || bash !== undefined) return "ask"
  return EXEC_FALLBACK
}

/**
 * Read the user's native CLI config and resolve their default execution mode:
 * `~/.codex/config.toml` (codex), `~/.config/opencode/opencode.json` (opencode),
 * or `~/.claude/settings.json` (claude/cursor). Never fails — a missing file
 * resolves to `accept-edits`.
 *
 * opencode's config dir can be relocated with `OPENCODE_CONFIG_DIR`, and it also
 * merges project-level and remote configs; we read the standard user path only,
 * which is the one the setting actually reflects for the vast majority.
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
    if (cli === "opencode") {
      const json = yield* read(`${homeDir}/.config/opencode/opencode.json`)
      return json.length > 0 ? opencodeDefaultMode(json) : EXEC_FALLBACK
    }
    const json = yield* read(`${homeDir}/.claude/settings.json`)
    return json.length > 0 ? claudeDefaultMode(json) : EXEC_FALLBACK
  })
