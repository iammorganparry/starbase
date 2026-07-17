import type { CliKind } from "@starbase/core"
import { Effect, Layer } from "effect"
import { CliAdapter, scriptedRun } from "./adapter.js"
import { runClaude } from "./claude-adapter.js"
import { runCodex } from "./codex-adapter.js"
import { runOpencode } from "./opencode-adapter.js"
import { isScriptedEnv } from "./scripted.js"

/**
 * Which adapter handles a spec. Pure so the routing is unit-tested without
 * spawning a harness: forced scripted (env), or no binary → scripted; otherwise
 * the harness's real adapter (`claude` / `codex` / `opencode`), falling back to
 * scripted for harnesses without one yet (Cursor).
 */
export const selectHarness = (
  cli: CliKind,
  binPath: string | null,
  forceScripted: boolean
): "claude" | "codex" | "opencode" | "scripted" => {
  if (forceScripted || binPath === null) return "scripted"
  if (cli === "claude") return "claude"
  if (cli === "codex") return "codex"
  if (cli === "opencode") return "opencode"
  return "scripted"
}

/**
 * Forget a session's live resume id when it belongs to a DIFFERENT harness than
 * the one about to run, so the next turn starts that harness fresh.
 *
 * A resume id is only meaningful to the harness that issued it — a Claude SDK
 * UUID means nothing to opencode, whose `session.prompt` rejects it outright.
 * `SessionStore.setHarness` already drops the PERSISTED id on a switch for
 * exactly this reason, but the in-memory map outlives the switch and every
 * adapter prefers it (`resume.get(sessionId) ?? spec.resumeId`) — so without
 * this the cleared persisted value never gets a look in, and the stale id is
 * handed straight to the new harness.
 *
 * Keyed per session rather than per session+harness deliberately: the persisted
 * model holds ONE cli and ONE resumeId, and switching is defined to start the
 * new harness fresh. Remembering the old thread here would resume something the
 * store has already discarded — and only until the app restarts, which is a
 * difference nobody could explain.
 *
 * Exported for tests.
 */
export const forgetForeignResume = (
  resume: Map<string, string>,
  mintedBy: Map<string, CliKind>,
  sessionId: string,
  cli: CliKind
): void => {
  const minted = mintedBy.get(sessionId)
  if (minted !== undefined && minted !== cli) resume.delete(sessionId)
  mintedBy.set(sessionId, cli)
}

/**
 * The `CliAdapter` the app runs: dispatches each turn to the real harness
 * (Claude, Codex, opencode) or the scripted fallback. Holds the per-session
 * harness session id so multi-turn conversations resume. Cursor implements the
 * same `runClaude`-shaped contract next.
 */
export const HarnessCliAdapterLive: Layer.Layer<CliAdapter> = Layer.sync(CliAdapter, () => {
  const resume = new Map<string, string>()
  /** Which harness minted each session's live resume id — see below. */
  const mintedBy = new Map<string, CliKind>()
  const scripted = scriptedRun(320)
  return CliAdapter.of({
    run: (sessionId, spec, ctx) => {
      // The one place that sees both the session and the harness it's about to
      // run on, which is what makes a switch detectable at all.
      forgetForeignResume(resume, mintedBy, sessionId, spec.cli)
      switch (selectHarness(spec.cli, spec.binPath, isScriptedEnv())) {
        case "claude":
          return runClaude(sessionId, spec, ctx, resume)
        case "codex":
          return runCodex(sessionId, spec, ctx, resume)
        case "opencode":
          return runOpencode(sessionId, spec, ctx, resume)
        default:
          return scripted(sessionId, spec, ctx)
      }
    },
    stop: () => Effect.void
  })
})
