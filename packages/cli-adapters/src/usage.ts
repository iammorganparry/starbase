import type { CliInfo, CliKind, ProviderUsage, Usage } from "@starbase/core"
import { Effect } from "effect"
import { fetchClaudeUsage, toClaudeProviderUsage } from "./claude-usage.js"
import { isScriptedEnv } from "./scripted.js"

/** Short provider names for the usage modal. */
const NAME: Record<CliKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  // Lowercase is the product's own styling, not a typo.
  opencode: "opencode"
}


const unavailable = (cli: CliKind, name?: string): ProviderUsage => ({
  cli,
  name: name ?? NAME[cli] ?? cli,
  plan: null,
  available: false,
  windows: []
})

/**
 * Assembles the Usage snapshot for the modal. Claude's windows are read live
 * from the SDK's structured `/usage` control request each time (real utilization
 * + reset + subscription); a failed read (not logged in, API-key session, or
 * scripted mode) degrades to "not available". Other harnesses expose no usage
 * data yet.
 */
export class UsageService extends Effect.Service<UsageService>()("@starbase/UsageService", {
  accessors: true,
  sync: () => ({
    get: (clis: ReadonlyArray<CliInfo>): Effect.Effect<Usage> =>
      Effect.gen(function* () {
        const scripted = isScriptedEnv()
        const providers = yield* Effect.forEach(
          clis.filter((c) => c.available),
          (c): Effect.Effect<ProviderUsage> => {
            if (c.kind === "claude" && !scripted) {
              return Effect.tryPromise(() => fetchClaudeUsage(c.binPath)).pipe(
                Effect.map(toClaudeProviderUsage),
                Effect.catchAll(() => Effect.succeed(unavailable("claude")))
              )
            }
            return Effect.succeed(unavailable(c.kind, NAME[c.kind] ?? c.label))
          },
          { concurrency: "unbounded" }
        )
        return { providers, fetchedAt: new Date().toISOString() }
      })
  })
}) {}
