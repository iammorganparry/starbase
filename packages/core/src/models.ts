import { Schema } from "effect"
import { CliKind } from "./domain.js"

/** A model a harness can run, shown in the composer's model chip. */
export const ModelOption = Schema.Struct({
  /** The id passed to the harness (`--model` / SDK `model`). */
  id: Schema.String,
  /** Short label shown in the chip/menu. */
  label: Schema.String
})
export type ModelOption = Schema.Schema.Type<typeof ModelOption>

/** A harness plus the models it offers — one section of the composer's model menu. */
export const ProviderModels = Schema.Struct({
  cli: CliKind,
  /** Human label for the section header ("Claude Code", "Codex CLI"). */
  label: Schema.String,
  models: Schema.Array(ModelOption)
})
export type ProviderModels = Schema.Schema.Type<typeof ProviderModels>

/**
 * Fallback model choices per harness — used only when live discovery from the
 * provider fails (offline / no credentials). The real list is fetched at runtime
 * by `ModelsService`; the first entry here is the default model. Kept small and
 * conservative on purpose.
 */
export const FALLBACK_MODELS: Record<CliKind, ReadonlyArray<ModelOption>> = {
  claude: [
    { id: "opus", label: "opus" },
    { id: "sonnet", label: "sonnet" },
    { id: "haiku", label: "haiku" },
    // Fable is the adversarial reviewer's default (see `DEFAULT_REVIEW_MODEL`).
    // It is deliberately NOT first: `defaultModel` takes index 0, so promoting it
    // would silently switch every new *session* onto the priciest tier.
    { id: "claude-fable-5", label: "fable" }
  ],
  // Codex's real catalogue comes from the CLI itself (`codex app-server` →
  // `model/list`), which is authoritative and needs no API key. These are only
  // the offline shape. Do NOT reach for the OpenAI *API* catalogue here: Codex
  // models are a different vocabulary and mostly aren't served from /v1/models.
  codex: [
    { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { id: "gpt-5.5", label: "gpt-5.5" }
  ],
  cursor: [
    { id: "auto", label: "auto" },
    { id: "sonnet-4.5", label: "sonnet-4.5" },
    { id: "gpt-5", label: "gpt-5" }
  ],
  // opencode ids are provider-qualified (`provider/model`), and the provider can
  // itself contain slashes — `openrouter/anthropic/claude-opus-4.5` is one id, so
  // only the FIRST slash separates provider from model (see `splitModelId`).
  //
  // These are opencode Zen's *free* tier on purpose. opencode resolves providers
  // from the user's own credentials, so with none configured the only thing that
  // runs is Zen free (opencode drops every model with a non-zero input cost and
  // falls back to a "public" key). That makes this list the honest offline answer
  // AND a working zero-config first run. The real catalogue — including the
  // user's OpenRouter/Anthropic models — comes live from `ModelsService`.
  //
  // NOTE: `defaultModel` takes index 0, so this also seeds a new session's model.
  // opencode users who configured their own default deserve *that* instead —
  // `/config/providers` returns a `default` map per provider, which live
  // discovery should prefer over this list.
  opencode: [
    { id: "opencode/big-pickle", label: "big-pickle" },
    { id: "opencode/north-mini-code-free", label: "north-mini-code-free" },
    { id: "opencode/hy3-free", label: "hy3-free" }
  ],
  // Starbase picks the model per step from the plan and the repo's knowledge
  // base, so there is exactly one choice to offer: let it choose. This is not a
  // placeholder for a real catalogue — offering a fixed model here would
  // contradict the whole point of selecting the orchestrator.
  starbase: [{ id: "auto", label: "orchestrate" }]
}

/** The default model id for a harness (the first fallback option). */
export const defaultModel = (cli: CliKind): string => FALLBACK_MODELS[cli][0]!.id

/**
 * The model the adversarial reviewer runs on per harness, when the user hasn't
 * chosen one in Settings · GitHub. Deliberately distinct from `defaultModel`:
 * the point of an adversarial review is to critique the diff with a *stronger*
 * model than the one that wrote it, so Claude reviews default to Fable
 * (`claude-fable-5`) — 1M context swallows large diffs whole and thinking is
 * always on. Live discovery (`ModelsService`) surfaces the real catalogue; these
 * are the offline fallbacks.
 */
export const DEFAULT_REVIEW_MODEL: Record<CliKind, string> = {
  claude: "claude-fable-5",
  // Same as `defaultModel("codex")` — the Codex fallback list has no stronger
  // tier to reach for, so a Codex review runs on the model that wrote the code
  // unless the user picks otherwise. Live discovery surfaces the real catalogue.
  codex: "gpt-5.6-sol",
  // Cursor has no headless adapter, so a review on it is rejected before this is
  // ever read (see ReviewService). Present only to keep the record total.
  cursor: "auto",
  // Same reasoning as Codex: the offline fallback has no stronger tier to reach
  // for, so an opencode review runs on the model that wrote the code unless the
  // user picks otherwise. Live discovery surfaces the real catalogue — and for
  // opencode that is the widest of any harness (models.dev spans 167 providers),
  // so the Settings override is where a serious reviewer model gets chosen.
  opencode: "opencode/big-pickle",
  // Never read: a review runs on the harness that wrote the diff, and the
  // orchestrator writes none of it — its steps run on real harnesses, which is
  // what a review attributes to. Present only to keep the record total.
  starbase: "auto"
}

/** The reviewer's model for `cli`, honouring the user's override when set. */
export const reviewModelFor = (cli: CliKind, configured?: string): string =>
  configured && configured.length > 0 ? configured : DEFAULT_REVIEW_MODEL[cli]

/**
 * Split a provider-qualified model id into the `{providerID, modelID}` pair
 * opencode's API wants. Only the FIRST slash separates them: the provider id
 * never contains a slash but the model id routinely does —
 * `openrouter/anthropic/claude-opus-4.5` is provider `openrouter`, model
 * `anthropic/claude-opus-4.5`. A naive `split("/")` silently mangles every
 * OpenRouter model.
 *
 * Lives here rather than in the opencode adapter so `vendor.ts` can resolve a
 * model id to the lab behind it without `core` depending on `cli-adapters`.
 */
export const splitModelId = (id: string): { providerID: string; modelID: string } => {
  const i = id.indexOf("/")
  return i === -1
    ? { providerID: id, modelID: "" }
    : { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}
