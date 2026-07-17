import type { ModelOption } from "@starbase/core"
import { withOpencodeServer } from "./opencode-server.js"

/**
 * opencode's model catalogue, read from a short-lived opencode server.
 *
 * Why the server and not `opencode models`: both cost about the same (~0.7s), but
 * `opencode models` prints bare `provider/model` lines with no display names,
 * while `GET /config/providers` returns each provider's resolved models with
 * proper names, plus where the provider's credentials came from. Neither is a
 * static list — and that is the point. opencode resolves providers from the
 * USER's own credentials (`opencode auth login`, or an env var like
 * `OPENROUTER_API_KEY`), so the catalogue is whatever they have configured: an
 * OpenRouter key alone yields ~342 models, and with no credentials at all only
 * opencode Zen's free tier resolves. Asking the binary is the only way to know.
 *
 * Every failure here is non-fatal — callers fall back to `FALLBACK_MODELS`.
 */

/** A provider as `/config/providers` reports it (only the fields we consume). */
export interface OpencodeProvider {
  readonly id: string
  readonly name: string
  /** Where the credential came from — env var, config, `auth login`, built-in. */
  readonly source?: "env" | "config" | "custom" | "api"
  /** The env vars this provider reads, e.g. `["OPENROUTER_API_KEY"]`. */
  readonly env?: ReadonlyArray<string>
  readonly models: Record<string, { readonly id: string; readonly name?: string }>
}

/**
 * Fold `/config/providers` into chip options — the pure, unit-tested seam (the
 * process plumbing is verified live, as with `runOpencode`).
 *
 * Ids are provider-qualified (`openrouter/anthropic/claude-opus-4.5`) because
 * that is what opencode itself takes. Labels are too: the menu groups by
 * *harness*, so every opencode model shares one section, and "Claude Opus 4.5"
 * alone would be ambiguous when the same model is reachable through Zen and
 * OpenRouter both.
 */
export const toModelOptions = (
  providers: ReadonlyArray<OpencodeProvider>,
  defaults: Record<string, string> = {}
): ReadonlyArray<ModelOption> =>
  providers
    .flatMap((provider) =>
      Object.values(provider.models ?? {})
        .filter((model) => typeof model?.id === "string" && model.id.length > 0)
        .map((model) => ({
          id: `${provider.id}/${model.id}`,
          label: `${provider.id} · ${model.name ?? model.id}`,
          // Sort key only — surface each provider's own default first so the
          // top of the menu is the model opencode would have picked.
          isDefault: defaults[provider.id] === model.id
        }))
    )
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label)
    )
    .map(({ id, label }) => ({ id, label }))

/** The `/config/providers` payload (only the fields we consume). */
export interface ProvidersResponse {
  readonly providers?: ReadonlyArray<OpencodeProvider>
  readonly default?: Record<string, string>
}

/** Ask a running opencode server for the providers its credentials resolve. */
export const readProviders = async (url: string): Promise<ProvidersResponse | null> => {
  const res = await fetch(`${url}/config/providers`)
  return res.ok ? ((await res.json()) as ProvidersResponse) : null
}

/**
 * The `/provider` payload — the FULL models.dev registry, not just what resolves.
 *
 * `/config/providers` answers "what can this user run right now" (~2 entries);
 * this answers "what does opencode know about at all" (~167) plus which of them
 * are `connected`. Settings needs both: you cannot offer to add a key for
 * OpenRouter if OpenRouter only appears once it already has one.
 *
 * NOTE: `all[].source` is NOT a usable connected-signal here — the registry
 * stamps 166 of 167 as `"custom"` regardless. `connected` is the real answer,
 * and `/config/providers` is where a connected provider's true origin lives.
 */
export interface AllProvidersResponse {
  readonly all?: ReadonlyArray<OpencodeProvider>
  /** Provider ids that currently resolve, e.g. `["openai", "opencode"]`. */
  readonly connected?: ReadonlyArray<string>
}

/** Ask a running opencode server for every provider it knows, connected or not. */
export const readAllProviders = async (url: string): Promise<AllProvidersResponse | null> => {
  const res = await fetch(`${url}/provider`)
  return res.ok ? ((await res.json()) as AllProvidersResponse) : null
}

/** Boot a throwaway opencode server and ask it for the resolved catalogue. */
export const fetchOpencodeModels = async (
  binPath?: string | null
): Promise<ReadonlyArray<ModelOption> | null> =>
  withOpencodeServer(binPath, async (url) => {
    const body = await readProviders(url)
    if (body === null) return null
    const options = toModelOptions(body.providers ?? [], body.default ?? {})
    return options.length > 0 ? options : null
  })
