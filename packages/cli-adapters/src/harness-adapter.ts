import type { CliKind } from "@starbase/core"
import { Effect, Layer } from "effect"
import { CliAdapter, scriptedRun } from "./adapter.js"
import { runClaude } from "./claude-adapter.js"

/** When set (e2e / tests), force the deterministic scripted adapter. */
const SCRIPTED_ENV = "STARBASE_SCRIPTED_AGENT"

/**
 * Which adapter handles a spec. Pure so the routing is unit-tested without
 * spawning a harness: forced scripted (env), or no binary → scripted; a `claude`
 * binary → the real Claude adapter; other harnesses fall back to scripted until
 * their adapters land.
 */
export const selectHarness = (
  cli: CliKind,
  binPath: string | null,
  forceScripted: boolean
): "claude" | "scripted" => {
  if (forceScripted || binPath === null) return "scripted"
  return cli === "claude" ? "claude" : "scripted"
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
    run: (sessionId, spec, ctx) =>
      selectHarness(spec.cli, spec.binPath, isScriptedEnv()) === "claude"
        ? runClaude(sessionId, spec, ctx, resume)
        : scripted(sessionId, spec, ctx),
    stop: () => Effect.void
  })
})
