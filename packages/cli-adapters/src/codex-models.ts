import type { ModelOption } from "@starbase/core"
import { requestCodexAppServer } from "./codex-app-server.js"

/**
 * Codex's model catalogue, read from the Codex CLI itself.
 *
 * Why not the OpenAI API: `GET api.openai.com/v1/models` needs an
 * `OPENAI_API_KEY`, which Codex users on ChatGPT subscription auth do not have
 * (their credentials live in `~/.codex/auth.json` as refresh tokens). It also
 * returns the *API* catalogue — a different vocabulary from Codex's own models
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, …), most of which it never lists. So that
 * route could not produce a correct list even with a key.
 *
 * Instead we speak the CLI's own app-server protocol over stdio: newline-
 * delimited JSON-RPC, `initialize` then `model/list`. It reuses whatever auth
 * the CLI already has, so it works for subscription and API-key users alike, and
 * the list is exactly what `codex` itself would offer.
 *
 * The protocol is marked experimental upstream, so every failure here is
 * non-fatal — callers fall back to `FALLBACK_MODELS`.
 */

/** One entry of `model/list`'s response (only the fields we consume). */
export interface CodexModel {
  readonly id: string
  readonly displayName?: string
  readonly hidden?: boolean
  readonly isDefault?: boolean
}

/**
 * Fold `model/list`'s payload into chip options — the pure, unit-tested seam
 * (the surrounding process plumbing is verified live, as with `runCodex`).
 */
export const toModelOptions = (models: ReadonlyArray<CodexModel>): ReadonlyArray<ModelOption> =>
  models
    // `hidden` models (e.g. codex-auto-review) aren't user-selectable.
    .filter((m) => m?.id && !m.hidden)
    // Surface the CLI's own default first: callers treat index 0 as the default
    // model, so this keeps us in step with `codex` itself.
    .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
    .map((m) => ({ id: m.id, label: m.displayName ?? m.id }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isCodexModel = (value: unknown): value is CodexModel =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.displayName === undefined || typeof value.displayName === "string") &&
  (value.hidden === undefined || typeof value.hidden === "boolean") &&
  (value.isDefault === undefined || typeof value.isDefault === "boolean")

/**
 * Ask a Codex binary for its models. Resolves `null` on *any* problem (binary
 * missing, protocol drift, timeout, not logged in) — never rejects, never hangs.
 */
export const fetchCodexModels = async (
  binPath?: string | null
): Promise<ReadonlyArray<ModelOption> | null> => {
  const response = await requestCodexAppServer(binPath, "model/list", {})
  if (!isRecord(response) || !Array.isArray(response.data) || !response.data.every(isCodexModel)) {
    return null
  }
  const options = toModelOptions(response.data)
  return options.length > 0 ? options : null
}
