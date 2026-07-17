import type { ModelOption } from "@starbase/core"
import { spawn } from "node:child_process"
import { parseServerUrl } from "./opencode-adapter.js"

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

/** How long the server gets to boot and answer before we use the fallback. */
const TIMEOUT_MS = 8000

/**
 * Boot a throwaway opencode server, ask it for the resolved catalogue, and shut
 * it down. `binPath` comes from `DiscoveryService` — a GUI-launched Electron app
 * often has a threadbare `PATH`, so a bare `opencode` lookup would miss installs
 * discovery finds at an absolute path.
 */
export const fetchOpencodeModels = async (
  binPath?: string | null
): Promise<ReadonlyArray<ModelOption> | null> => {
  if (!binPath) return null

  const proc = spawn(binPath, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    stdio: ["ignore", "pipe", "pipe"],
    // Inherit the user's environment untouched: their provider keys live there
    // (opencode reads OPENROUTER_API_KEY et al directly), and this listing must
    // reflect exactly what a real run would resolve.
    env: process.env
  })
  const kill = (): void => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM")
  }

  const timer = setTimeout(kill, TIMEOUT_MS)
  try {
    const url = await new Promise<string | null>((resolve) => {
      let output = ""
      let settled = false
      const done = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        const parsed = parseServerUrl(output)
        if (parsed !== null) done(parsed)
      })
      proc.on("error", () => done(null))
      proc.on("exit", () => done(null))
      setTimeout(() => done(null), TIMEOUT_MS)
    })
    if (url === null) return null

    const res = await fetch(`${url}/config/providers`)
    if (!res.ok) return null
    const body = (await res.json()) as {
      providers?: ReadonlyArray<OpencodeProvider>
      default?: Record<string, string>
    }
    const options = toModelOptions(body.providers ?? [], body.default ?? {})
    return options.length > 0 ? options : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    kill()
  }
}
