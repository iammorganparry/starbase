import type { CliInfo, CliKind, ModelOption, ProviderModels } from "@starbase/core"
import { FALLBACK_MODELS } from "@starbase/core"
import { Effect, Ref } from "effect"
import { fetchCodexModels } from "./codex-models.js"

/**
 * Live model discovery per harness, so the composer's chip stays current instead
 * of drifting against a hardcoded list.
 *
 * Each harness is asked in the way that actually works for it:
 *  - **codex** — the CLI's own app-server (`model/list`). Authoritative, and
 *    needs no API key, so it works on subscription auth. See `codex-models.ts`.
 *  - **claude** — the Anthropic models API, when `ANTHROPIC_API_KEY` is set. The
 *    Claude CLI has no list command, and its fallback aliases (`opus`/`sonnet`/
 *    `haiku`) are valid and stable, so the fallback is a fine answer here.
 *  - **cursor** — no discovery path; always the fallback.
 *
 * Anything that fails (offline, no credentials, protocol drift) degrades to
 * `FALLBACK_MODELS`. Results are cached for the process lifetime.
 */

const CLAUDE = /^claude/i

const fetchAnthropic = async (): Promise<ReadonlyArray<ModelOption> | null> => {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> }
  return (body.data ?? [])
    .filter((m) => CLAUDE.test(m.id))
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }))
}

const fetchFor = (
  cli: CliKind,
  binPath?: string | null
): Promise<ReadonlyArray<ModelOption> | null> =>
  cli === "claude"
    ? fetchAnthropic()
    : cli === "codex"
      ? fetchCodexModels(binPath)
      : Promise.resolve(null)

export class ModelsService extends Effect.Service<ModelsService>()("@starbase/ModelsService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const cache = yield* Ref.make(new Map<CliKind, ReadonlyArray<ModelOption>>())

    /**
     * The models `cli` offers. `binPath` is the discovered CLI binary (from
     * `DiscoveryService`) — it matters because a GUI-launched Electron app often
     * has a threadbare `PATH`, so probing bare `codex` would miss installs that
     * discovery finds at an absolute path.
     */
    const list = (cli: CliKind, binPath?: string | null): Effect.Effect<ReadonlyArray<ModelOption>> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cache)).get(cli)
        if (cached) return cached
        const fetched = yield* Effect.tryPromise(() => fetchFor(cli, binPath)).pipe(
          Effect.orElseSucceed(() => null)
        )
        const result = fetched && fetched.length > 0 ? fetched : FALLBACK_MODELS[cli]
        yield* Ref.update(cache, (m) => new Map(m).set(cli, result))
        return result
      })

    return {
      list,

      /**
       * Every *installed* harness with its models — the sections of the model
       * menu. Unavailable CLIs are dropped rather than shown disabled: offering
       * a harness we can't run would only produce a broken session. Takes the
       * discovery result as an argument to keep this service free of a
       * `DiscoveryService` dependency (and hermetically testable).
       */
      catalog: (clis: ReadonlyArray<CliInfo>): Effect.Effect<ReadonlyArray<ProviderModels>> =>
        Effect.forEach(
          clis.filter((c) => c.available),
          (c) =>
            list(c.kind, c.binPath).pipe(
              Effect.map((models) => ({ cli: c.kind, label: c.label, models }))
            ),
          { concurrency: "unbounded" }
        )
    }
  })
}) {}
