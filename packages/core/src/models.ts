import { Schema } from "effect"
import type { CliKind } from "./domain.js"

/** A model a harness can run, shown in the composer's model chip. */
export const ModelOption = Schema.Struct({
  /** The id passed to the harness (`--model` / SDK `model`). */
  id: Schema.String,
  /** Short label shown in the chip/menu. */
  label: Schema.String
})
export type ModelOption = Schema.Schema.Type<typeof ModelOption>

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
  codex: [
    { id: "gpt-5-codex", label: "gpt-5-codex" },
    { id: "gpt-5", label: "gpt-5" },
    { id: "o3", label: "o3" }
  ],
  cursor: [
    { id: "auto", label: "auto" },
    { id: "sonnet-4.5", label: "sonnet-4.5" },
    { id: "gpt-5", label: "gpt-5" }
  ]
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
  codex: "gpt-5-codex",
  // Cursor has no headless adapter, so a review on it is rejected before this is
  // ever read (see ReviewService). Present only to keep the record total.
  cursor: "auto"
}

/** The reviewer's model for `cli`, honouring the user's override when set. */
export const reviewModelFor = (cli: CliKind, configured?: string): string =>
  configured && configured.length > 0 ? configured : DEFAULT_REVIEW_MODEL[cli]
