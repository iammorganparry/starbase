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
    { id: "haiku", label: "haiku" }
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
