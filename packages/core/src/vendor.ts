import { Schema } from "effect"
import { CliKind } from "./domain.js"
import type { ProviderModels } from "./models.js"
import { ModelOption, splitModelId } from "./models.js"

/**
 * Which *lab* is behind a (harness, model) pair, and the cheapest way to reach
 * each one.
 *
 * Adversarial planning only means anything when the critic comes from a
 * different lab than the proposer — a reviewer trained alongside the author
 * shares its blind spots. So the question that gates the feature is "how many
 * distinct labs can this machine reach", and that is NOT the same as "how many
 * CLIs are installed". Counting CLIs is wrong in both directions:
 *
 *  - **One harness can supply both roles.** opencode resolves providers from the
 *    user's own credentials, so a single OpenRouter key reaches Anthropic AND
 *    OpenAI AND Moonshot. Counting CLIs would hide the feature from the person
 *    best equipped to use it.
 *  - **Two harnesses can be one lab.** Claude Code's `opus` and opencode's
 *    `openrouter/anthropic/claude-opus-4.5` are the same weights. Counting CLIs
 *    would offer a "panel" of a model arguing with itself.
 *
 * Exact-id dedup can't rescue it either: the vocabularies share nothing. Claude
 * uses server-resolved aliases (`opus`, `claude-fable-5`), Codex uses
 * `gpt-5.6-sol`, opencode uses provider-qualified ids where the provider itself
 * contains slashes. Resolving to a vendor is the only comparison that works.
 */

/**
 * Providers that resell other labs' models. For these the vendor sits one
 * segment deeper: `openrouter/anthropic/claude-opus-4.5` is Anthropic's model,
 * not OpenRouter's, and pairing it against Claude Code would be same-lab.
 *
 * A gateway we don't know about degrades to counting itself as a vendor, which
 * over-counts diversity rather than hiding the feature — see `vendorOf`.
 */
const GATEWAYS: ReadonlySet<string> = new Set(["openrouter", "opencode", "vercel", "requesty"])

/**
 * The harness that *is* a given vendor. Reaching a lab through its own CLI runs
 * on the user's subscription; reaching identical weights through a gateway bills
 * a metered API key. Same model, real money difference — so when both are
 * present, native wins.
 */
const NATIVE_HARNESS: Readonly<Record<string, CliKind>> = {
  anthropic: "claude",
  openai: "codex"
}

/**
 * The lab behind a (harness, model) pair, or null when the pair can't
 * participate.
 *
 * `claude` and `codex` ARE their vendor — the harness is the lab, whatever model
 * id is selected. `cursor` returns null: it has no real adapter (it falls
 * through to the scripted stub in `harness-adapter.ts`), so a cursor
 * "participant" would return fabricated output.
 *
 * Fails OPEN: an unrecognised provider counts as its own vendor. Over-counting
 * offers a slightly weaker pairing; under-counting hides the feature with no
 * clue why, and a provider slug we've never seen is far more likely to be a new
 * lab than a new gateway.
 */
export const vendorOf = (cli: CliKind, modelId: string | null): string | null => {
  if (cli === "claude") return "anthropic"
  if (cli === "codex") return "openai"
  if (cli === "cursor") return null
  // Starbase is an orchestrator, not a lab. Counting it as a vendor would let a
  // host with ONLY our own harness look like it had the two independent
  // providers adversarial planning needs — a panel of us against ourselves.
  if (cli === "starbase") return null
  const { providerID, modelID } = splitModelId(modelId ?? "")
  if (providerID === "") return null
  if (!GATEWAYS.has(providerID)) return providerID
  // A gateway resells someone else's weights, but only a *further-qualified*
  // remainder names the lab: `openrouter/anthropic/claude-opus-4.5` is
  // Anthropic's, while `opencode/big-pickle` is the gateway's own model and
  // `big-pickle` is a model name, not a lab. Requiring the second slash is what
  // separates the two — without it, every gateway-native model invents a vendor
  // named after itself and would happily "diversify" a panel against nothing.
  const slash = modelID.indexOf("/")
  if (slash <= 0) return providerID
  return modelID.slice(0, slash)
}

/** A lab this machine can reach, and the cheapest harness that reaches it. */
export const VendorReach = Schema.Struct({
  vendor: Schema.String,
  /** The preferred harness — native where one exists, else whatever reaches it. */
  cli: CliKind,
  /** That harness's models for this vendor, in catalogue order. */
  models: Schema.Array(ModelOption)
})
export type VendorReach = Schema.Schema.Type<typeof VendorReach>

/**
 * Pick the harness to reach `vendor` with, given every harness that can.
 * Native first (subscription over metered key); otherwise deterministic by name
 * so the choice never flickers between runs.
 */
const preferHarness = (vendor: string, clis: ReadonlyArray<CliKind>): CliKind => {
  const native = NATIVE_HARNESS[vendor]
  if (native !== undefined && clis.includes(native)) return native
  return [...clis].sort()[0]!
}

/**
 * Every lab reachable from this catalogue, each via its preferred harness.
 *
 * Sorted by vendor name so the result is stable — role assignment (who proposes,
 * who attacks) is the caller's decision, and a list that reordered itself
 * between runs would make that decision non-reproducible.
 */
export const reachableVendors = (
  catalog: ReadonlyArray<ProviderModels>
): ReadonlyArray<VendorReach> => {
  /** vendor → cli → its models for that vendor */
  const byVendor = new Map<string, Map<CliKind, ModelOption[]>>()
  for (const provider of catalog) {
    for (const model of provider.models) {
      const vendor = vendorOf(provider.cli, model.id)
      if (vendor === null) continue
      const clis = byVendor.get(vendor) ?? new Map<CliKind, ModelOption[]>()
      const models = clis.get(provider.cli) ?? []
      models.push(model)
      clis.set(provider.cli, models)
      byVendor.set(vendor, clis)
    }
  }
  return [...byVendor.entries()]
    .map(([vendor, clis]) => {
      const cli = preferHarness(vendor, [...clis.keys()])
      return { vendor, cli, models: clis.get(cli) ?? [] }
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor))
}

export const PlanningReadiness = Schema.Struct({
  ready: Schema.Boolean,
  vendors: Schema.Array(VendorReach),
  /** Names the fix when not ready; null when it is. Shown on the disabled entry. */
  reason: Schema.NullOr(Schema.String)
})
export type PlanningReadiness = Schema.Schema.Type<typeof PlanningReadiness>

/** The minimum labs an adversarial round needs: one to propose, one to attack. */
const MIN_VENDORS = 2

/**
 * Whether adversarial planning is worth offering here, and if not, what would
 * fix it.
 *
 * Reports a REASON rather than hiding the entry. A silently absent menu item
 * teaches the user nothing — the repo already settled this for a too-old
 * opencode, which "reports unavailable *with a note* naming the version found
 * and the fix, so it's distinguishable from a missing one". It also happens to
 * be the best argument in the app for why a second harness is worth setting up.
 */
export const planningReadiness = (
  catalog: ReadonlyArray<ProviderModels>
): PlanningReadiness => {
  const vendors = reachableVendors(catalog)
  if (vendors.length >= MIN_VENDORS) return { ready: true, vendors, reason: null }
  if (vendors.length === 0) {
    return {
      ready: false,
      vendors,
      reason:
        "Adversarial planning needs two model providers. No harness is available — install Claude Code, Codex or opencode."
    }
  }
  return {
    ready: false,
    vendors,
    reason:
      `Adversarial planning needs a second model provider, so a rival lab can review the plan. ` +
      `You can only reach ${vendors[0]!.vendor} — install Codex, or add a provider key in Settings · Providers.`
  }
}
