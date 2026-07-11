import type { CliKind } from "@starbase/core"
import { Effect, Layer } from "effect"
import { CliAdapter, scriptedRun } from "./adapter.js"
import { runClaude } from "./claude-adapter.js"
import { runCodex } from "./codex-adapter.js"

/** When set (e2e / tests), force the deterministic scripted adapter. */
const SCRIPTED_ENV = "STARBASE_SCRIPTED_AGENT"

/**
 * Which adapter handles a spec. Pure so the routing is unit-tested without
 * spawning a harness: forced scripted (env), or no binary → scripted; otherwise
 * the harness's real adapter (`claude` / `codex`), falling back to scripted for
 * harnesses without one yet (Cursor).
 */
export const selectHarness = (
  cli: CliKind,
  binPath: string | null,
  forceScripted: boolean
): "claude" | "codex" | "scripted" => {
  if (forceScripted || binPath === null) return "scripted"
  if (cli === "claude") return "claude"
  if (cli === "codex") return "codex"
  return "scripted"
}

const isScriptedEnv = (): boolean =>
  process.env[SCRIPTED_ENV] === "1" || process.env[SCRIPTED_ENV] === "true"

/**
 * The `CliAdapter` the app runs: dispatches each turn to the real harness
 * (Claude today) or the scripted fallback. Holds the per-session SDK session id
 * so multi-turn conversations resume. Codex/Cursor implement the same
 * `runClaude`-shaped contract next.
 */
export const HarnessCliAdapterLive: Layer.Layer<CliAdapter> = Layer.sync(CliAdapter, () => {
  const resume = new Map<string, string>()
  const scripted = scriptedRun(320)
  return CliAdapter.of({
    run: (sessionId, spec, ctx) => {
      switch (selectHarness(spec.cli, spec.binPath, isScriptedEnv())) {
        case "claude":
          return runClaude(sessionId, spec, ctx, resume)
        case "codex":
          return runCodex(sessionId, spec, ctx, resume)
        default:
          return scripted(sessionId, spec, ctx)
      }
    },
    stop: () => Effect.void
  })
})
