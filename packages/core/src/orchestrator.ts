import { Schema } from "effect"
import { CliKind } from "./domain.js"
import type { WorkspaceConfig } from "./domain.js"

/**
 * The model the orchestrator speaks as.
 *
 * Deliberately ONE model rather than a per-message decision. Starbase's whole
 * claim is that it picks the right agent for a piece of work — but that claim is
 * only interesting where the answer varies, which is across the steps of a plan.
 * For everything else, an operator who selected the orchestrator wants a
 * competent assistant with a predictable identity, not a router that silently
 * changes who they are talking to between messages.
 */

/**
 * Claude Opus until the operator says otherwise.
 *
 * A flagship on purpose: this model plans, and reads whole repositories to do
 * it. Defaulting to something cheap would make the orchestrator's own judgement
 * the weakest link in a feature whose entire value is judgement.
 */
export const ORCHESTRATOR_DEFAULT: { readonly cli: CliKind; readonly model: string } = {
  cli: "claude",
  model: "opus"
}

/**
 * Resolve the orchestrator's harness+model from config.
 *
 * Never returns `starbase`: the orchestrator cannot be its own backend, and a
 * config that says otherwise (hand-edited, or written by an older build) would
 * otherwise recurse. Falling back is the only safe reading of that.
 */
export const resolveOrchestrator = (
  config: WorkspaceConfig | null
): { readonly cli: CliKind; readonly model: string } => {
  const chosen = config?.orchestrator
  if (chosen === undefined || chosen.cli === "starbase") return ORCHESTRATOR_DEFAULT
  return chosen
}

/**
 * Which account a harness run is actually charged to.
 *
 * Surfaced rather than merely acted on: the failure this exists for was SILENT.
 * An exported API key overrode a paid subscription with per-token billing and
 * nothing on screen said so, which is how it went unnoticed until someone went
 * looking for it.
 */
export const HarnessBilling = Schema.Struct({
  cli: CliKind,
  /**
   * `subscription` — the operator's plan. `api-key` — a metered key from the
   * environment. `unknown` — neither detected; the harness will decide, and may
   * well fail to authenticate at all. `undetermined` — we could not READ the
   * credential store, which is a different claim from finding nothing there and
   * must not be reported as "sign in": the operator may already be signed in.
   */
  path: Schema.Literal("subscription", "api-key", "unknown", "undetermined"),
  /** True when a key was present but withheld because a plan was found. */
  keyWithheld: Schema.Boolean
})
export type HarnessBilling = Schema.Schema.Type<typeof HarnessBilling>
