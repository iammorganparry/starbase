import type { CliInfo, CliKind, ModelOption, ProviderModels } from "@starbase/core"
import { FALLBACK_MODELS } from "@starbase/core"
import { Effect } from "effect"
import { fetchCodexModels } from "./codex-models.js"
import { fetchOpencodeModels } from "./opencode-models.js"

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
 *  - **opencode** — a short-lived opencode server (`/config/providers`). Live
 *    discovery matters most here: opencode resolves providers from the user's
 *    OWN credentials, so the catalogue is theirs, not ours. See
 *    `opencode-models.ts`.
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
      : cli === "opencode"
        ? fetchOpencodeModels(binPath)
        : Promise.resolve(null)

/**
 * Narrow a harness's catalogue to the models the user chose to see
 * (`ProviderConfig.visibleModels`).
 *
 * Curation exists because live discovery can be overwhelming rather than
 * helpful: a single OpenRouter key resolves ~342 opencode models, which is not a
 * menu anyone can use. An absent or empty list means "show everything" — the
 * user hasn't curated, so we don't presume to.
 *
 * For the COMPOSER's menu only. Never narrow a configuration surface with it —
 * a curation that can hide models from the screen you'd use to edit it is a
 * one-way door (see `visibleModels` in `domain.ts`).
 *
 * A curation that matches nothing (every id stale after an upstream rename)
 * falls back to the full list. Showing everything is recoverable; showing an
 * empty model menu looks like the harness is broken.
 */
export const filterVisible = (
  models: ReadonlyArray<ModelOption>,
  visible: ReadonlyArray<string> | undefined
): ReadonlyArray<ModelOption> => {
  if (visible === undefined || visible.length === 0) return models
  const allowed = new Set(visible)
  const filtered = models.filter((m) => allowed.has(m.id))
  return filtered.length > 0 ? filtered : models
}

export class ModelsService extends Effect.Service<ModelsService>()("@starbase/ModelsService", {
  accessors: true,
  effect: Effect.gen(function* () {
    /**
     * The models `cli` offers, memoized for the process lifetime AND coalesced
     * while in flight — `cachedFunction` hands every concurrent caller the same
     * running probe rather than starting a rival one.
     *
     * That coalescing is the point, not just an optimization: the startup
     * prefetch and the renderer's `loadCatalog` (fired when a conversation opens)
     * both call this before the first result lands, and without a shared probe
     * each would boot its OWN `opencode serve` / `codex app-server` for the same
     * harness — a real doubling of spawned servers seen during warm-up.
     *
     * Keyed by `cli` alone: `binPath` is resolved from `DiscoveryService` and is
     * stable per harness across a session, so two calls for the same CLI want the
     * same answer. (It matters at all because a GUI-launched Electron app has a
     * threadbare PATH, so probing bare `codex` would miss an install discovery
     * finds at an absolute path.) The fetch degrades to `FALLBACK_MODELS` on any
     * failure and so always yields a value — caching it for the lifetime matches
     * the prior behaviour of caching whatever the first probe returned.
     */
    const fetchCached = yield* Effect.cachedFunction(
      (input: { readonly cli: CliKind; readonly binPath?: string | null }) =>
        Effect.tryPromise(() => fetchFor(input.cli, input.binPath)).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((fetched) =>
            fetched && fetched.length > 0 ? fetched : FALLBACK_MODELS[input.cli]
          )
        ),
      (a, b) => a.cli === b.cli
    )

    const list = (cli: CliKind, binPath?: string | null): Effect.Effect<ReadonlyArray<ModelOption>> =>
      fetchCached({ cli, binPath })

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
