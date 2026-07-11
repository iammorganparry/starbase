import type { CliInfo, CliKind, ProviderUsage, Usage, UsageWindow } from "@starbase/core"
import { Effect } from "effect"
import { readClaudeUsage } from "./usage-store.js"

/** Short provider names for the usage modal. */
const NAME: Record<CliKind, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" }

/** Claude's standard windows, mapped from the SDK's rate-limit types. */
const CLAUDE_WINDOWS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "five_hour", label: "Current session" },
  { key: "seven_day", label: "Weekly · all models" },
  { key: "seven_day_opus", label: "Weekly · Opus" }
]

/**
 * Assembles the Usage snapshot for the modal. Claude's windows come from the
 * captured rate-limit events (reset time + status, utilization when present);
 * other harnesses report no usage yet (`available: false`).
 */
export class UsageService extends Effect.Service<UsageService>()("@starbase/UsageService", {
  accessors: true,
  sync: () => ({
    get: (clis: ReadonlyArray<CliInfo>): Effect.Effect<Usage> =>
      Effect.sync(() => {
        const { windows, fetchedAt } = readClaudeUsage()
        const providers: ReadonlyArray<ProviderUsage> = clis
          .filter((c) => c.available)
          .map((c): ProviderUsage => {
            if (c.kind === "claude") {
              const claudeWindows: ReadonlyArray<UsageWindow> = CLAUDE_WINDOWS.map(({ key, label }) => {
                const entry = windows.get(key)
                return {
                  label,
                  resetsAt: entry?.resetsAt ?? null,
                  utilization: entry?.utilization ?? null,
                  status: entry?.status ?? "unknown"
                }
              })
              return { cli: "claude", name: "Claude", plan: null, available: true, windows: claudeWindows }
            }
            return { cli: c.kind, name: NAME[c.kind] ?? c.label, plan: null, available: false, windows: [] }
          })
        return { providers, fetchedAt }
      })
  })
}) {}
