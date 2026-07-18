import type { CliInfo, CliKind, ProviderUsage, Usage } from "@starbase/core"
import { Effect } from "effect"
import { fetchClaudeUsage, toClaudeProviderUsage } from "./claude-usage.js"
import { fetchCodexUsage, toCodexProviderUsage } from "./codex-usage.js"
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
 * Assembles the Usage snapshot for the modal. Claude reads its SDK `/usage`
 * control request; Codex reads `account/rateLimits/read` from its app server.
 * Failed reads and scripted mode degrade to "not available" without making the
 * modal itself fail.
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
            if (c.kind === "codex" && !scripted) {
              return Effect.promise(() => fetchCodexUsage(c.binPath)).pipe(
                Effect.map((usage) =>
                  usage ? toCodexProviderUsage(usage) : unavailable("codex")
                )
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
