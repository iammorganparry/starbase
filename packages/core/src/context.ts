import { Schema } from "effect"
// TYPE-only, and load-bearing. `domain.ts` imports the budget constants below as
// VALUES, so a value import back would close the loop. That cycle is not merely a
// module-init hazard: it made `StreamEvent` infer as `never`, which collapsed the
// entire `applyStreamEvent` match into unreachable code with errors pointing at
// tags that had nothing to do with the change.
//
// The rule this encodes: schemas live in the module that OWNS the concept —
// `ContextConfig` with the rest of the config in `domain.ts`, `ContextDigest`
// with the transcript in `conversation.ts` — and this module stays pure policy.
import type { CliKind } from "./domain.js"

/**
 * ── The quality band ────────────────────────────────────────────────────────
 *
 * Attention degrades long before a model hits its hard ceiling. The usable band
 * is roughly 256k–500k tokens on the current generation; past that, recall and
 * instruction-following fall off regardless of how much window is nominally left.
 *
 * So compaction fires on an ABSOLUTE budget, not a percentage of the window. On
 * a 1M-window model we compact at the budget and simply decline to use the rest,
 * because that remainder is where the rot lives. A percentage rule would do the
 * opposite — it would let a 1M model run to 650k before acting, which is exactly
 * the failure this exists to prevent.
 */
export const DEFAULT_BUDGET_TOKENS = 500_000

/**
 * The band the budget may be tuned within, enforced by schema and by clamp.
 *
 * Current 1M-window models routinely hold 450–600k of occupancy with no sign of
 * the rot this band was drawn to avoid. The quality argument above still holds —
 * it is why the ceiling is 500k and not "the window" — but the floor of the
 * degradation band sits higher on the current generation of models than it did
 * when this was written.
 */
export const BUDGET_RANGE = { min: 256_000, max: 500_000 } as const

/**
 * The window is a BACKSTOP, not the trigger. A model whose ceiling sits below
 * the budget (a legacy 200k Claude) must still compact before it hits that ceiling, so
 * the effective trigger is `min(budget, window × SAFETY_RATIO)`.
 *
 * 0.75 leaves room for one full agentic turn plus the harness's own preamble. A
 * live Codex thread exhausted a 258.4k window from a last good 206.9k reading:
 * the former 15% reserve could not hold its ten tool/model calls. Twenty-five
 * percent prepares the digest before that turn begins.
 *
 * It is
 * deliberately not a user lever: it is mechanical self-preservation, and a user
 * who set it to 0.99 would simply get hard context errors instead of compaction.
 */
const SAFETY_RATIO = 0.75

/**
 * ── Window floors ──────────────────────────────────────────────────────────
 *
 * Best-effort, and deliberately CONSERVATIVE. `triggerAt` takes a minimum, so
 * under-estimating a window makes us compact slightly early — harmless. Over-
 * estimating makes us compact too late and blow the context — the failure we
 * cannot recover from. When in doubt, quote the smaller number.
 *
 * Matched by longest id prefix, because harness model ids are unstable
 * (`sonnet`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929` are one model).
 */
const WINDOW_PREFIXES: Partial<Record<CliKind, ReadonlyArray<readonly [string, number]>>> = {
  claude: [
    // Fable's 1M window is the whole reason a percentage-of-window rule fails —
    // 75% of 1M is 750k, deep into the rot. The budget wins here, by design.
    ["claude-fable", 1_000_000],
    ["fable", 1_000_000],
    // Bare `opus` and `sonnet` are current Claude Code routes. Release-numbered
    // ids are persisted though, and over-estimating one is unrecoverable because
    // `reconcileWindow` only raises a proven-too-low guess. Longest-prefix wins,
    // so every legacy release family below must beat these current aliases.
    ["opus-4-5", 1_000_000],
    ["opus-4.5", 1_000_000],
    ["opus-4-8", 1_000_000],
    ["opus-4.8", 1_000_000],
    ["opus-5", 1_000_000],
    ["sonnet-4-5", 1_000_000],
    ["sonnet-4.5", 1_000_000],
    ["sonnet-5", 1_000_000],
    // Older Claude generations and the 4.0/4.1 release line are 200k. Some
    // harnesses omit `claude-` from the id, so both shapes have explicit floors.
    ["claude-3", 200_000],
    ["opus-4", 200_000],
    ["opus-3", 200_000],
    ["sonnet-4", 200_000],
    ["sonnet-3", 200_000],
    ["3-7-sonnet", 200_000],
    ["3-5-sonnet", 200_000],
    ["3-sonnet", 200_000],
    ["opus-4-1", 200_000],
    ["opus-4.1", 200_000],
    ["opus-4-20250514", 200_000],
    ["opus", 1_000_000],
    ["sonnet", 1_000_000],
    // No Haiku 1M model is established here. A low guess compacts early; a high
    // one can run into the harness ceiling without any way to reconcile down.
    ["haiku", 200_000]
  ],
  // Codex reports the effective session window through
  // `thread/tokenUsage/updated.modelContextWindow`. Current GPT-5.6 sessions
  // report 258,400 even though the public Responses API advertises a larger
  // model context. This table is only the conservative pre-telemetry fallback;
  // the live runtime value replaces it as soon as the adapter receives one.
  codex: [
    ["gpt-5.6-sol", 258_400],
    ["gpt-5.6-terra", 258_400],
    ["gpt-5.6-luna", 258_400],
    ["gpt-5.6", 258_400],
    ["gpt-5", 272_000]
  ]
}

/**
 * The floor used when no prefix matches but we still know the harness's family.
 *
 * `null` means "genuinely unknown", and unknown is load-bearing: `contextPhase`
 * refuses to escalate without a window, because guessing a ceiling is worse than
 * doing nothing. Cursor has no headless adapter at all. opencode resolves models
 * from the user's own credentials across ~167 providers, so there is no honest
 * default — those users declare it themselves via the Settings override.
 */
const DEFAULT_WINDOW: Record<CliKind, number | null> = {
  claude: 200_000,
  codex: 272_000,
  cursor: null,
  opencode: null,
  // The orchestrator is not one model with one window — it fans a round out
  // across independent vendors, so there is no single ceiling to name. It also
  // reports no `Usage` of its own, so `contextReporting` already keeps
  // compaction away from it; `null` states the same thing in the one place that
  // computes a budget.
  starbase: null
}

/**
 * The hard ceiling for `cli`/`model`, in tokens, or `null` when unknown.
 *
 * `override` is the user's per-provider Settings value and always wins — it is
 * the only way an opencode user gets auto-compaction at all, and the escape
 * hatch when a harness ships a model whose window we don't yet know.
 */
export const contextWindowFor = (
  cli: CliKind,
  model: string | null,
  override?: number | null
): number | null => {
  if (override !== undefined && override !== null && override > 0) return override
  const id = (model ?? "").toLowerCase()
  const table = WINDOW_PREFIXES[cli] ?? []
  // Longest prefix wins, so `claude-fable-5` can't be captured by a shorter id.
  const match = table
    .filter(([prefix]) => id.includes(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0]
  return match?.[1] ?? DEFAULT_WINDOW[cli]
}

/**
 * Correct an inferred window against what the session has actually been observed
 * holding.
 *
 * The table is a guess keyed on an unstable model id, and a guess can be
 * DISPROVEN: a session reporting 598k of occupancy is proof its window is not
 * 200k, whatever the prefix table believes. Ignoring that produced the exact
 * failure this exists to prevent, in reverse — `triggerAt` sat at 170k, every
 * turn read as "over budget", and the session compacted continuously while the
 * harness was happy.
 *
 * Only ever raises, never lowers: a low reading proves nothing about the
 * ceiling. The measured peak is treated as a FLOOR (the window is at least this
 * big), which is the strongest honest claim available without a probe.
 */
export const reconcileWindow = (
  inferred: number | null,
  observedPeak: number
): number | null => {
  if (!Number.isFinite(observedPeak) || observedPeak <= 0) return inferred
  if (inferred === null || inferred <= 0) return null
  return Math.max(inferred, observedPeak)
}

/** Clamp a configured budget into the usable band. */
export const clampBudget = (tokens: number): number =>
  Math.min(BUDGET_RANGE.max, Math.max(BUDGET_RANGE.min, Math.floor(tokens)))

/**
 * The working-set size at which compaction should fire: the quality budget, or
 * the window's safety margin, whichever comes first.
 *
 * A 1M model triggers at the budget because it *should*; a 200k model triggers at
 * 150k because it *must*.
 */
export const triggerAt = (window: number, budget: number): number =>
  Math.min(clampBudget(budget), Math.floor(window * SAFETY_RATIO))

/**
 * What the context manager should do with a session right now.
 *
 * - `unknown` — no window, or auto-compaction off. Never escalates.
 * - `idle`    — comfortably inside the band.
 * - `prepare` — over the trigger, build a digest in the background.
 * - `swap`    — over the trigger AND a digest is ready: reseed on this turn.
 */
export type ContextPhase = "unknown" | "idle" | "prepare" | "swap"

export interface ContextPhaseInput {
  /** Latest working-set reading for the session, in tokens. */
  readonly tokens: number
  /** The model's hard ceiling, or null when we don't know it. */
  readonly window: number | null
  /** The configured quality budget (clamped internally). */
  readonly budget: number
  /** Auto-compaction enabled for this session. */
  readonly auto: boolean
  /** A digest has already been built and is waiting to be applied. */
  readonly digestReady: boolean
}

/**
 * Pure and total — the single decision point for the whole feature.
 *
 * `unknown` short-circuits before any threshold maths: a session we can't
 * measure is a session we leave alone, so the harness's own limit stays the
 * backstop exactly as it is today.
 */
export const contextPhase = (input: ContextPhaseInput): ContextPhase => {
  if (!input.auto) return "unknown"
  if (input.window === null || input.window <= 0) return "unknown"
  if (!Number.isFinite(input.tokens) || input.tokens < 0) return "unknown"
  if (input.tokens < triggerAt(input.window, input.budget)) return "idle"
  return input.digestReady ? "swap" : "prepare"
}

/**
 * ── The swap gate ──────────────────────────────────────────────────────────
 *
 * `contextPhase` answers "is there enough context to be worth compacting". This
 * answers the question after it: "would compacting RIGHT NOW cost more than it
 * saves". Crossing a budget is a threshold; being mid-task is not, and a swap
 * dropped into the middle of a debugging thread throws away exactly the working
 * state the next turn needs.
 */

/** How many turns in a row a session may defer its swap before it must take it. */
export const MAX_SWAP_DEFERRALS = 3

/**
 * The occupancy fraction past which deferral stops being offered.
 *
 * Deliberately HIGHER than `SAFETY_RATIO`, and that gap is the whole hold band.
 * On a 200k model `triggerAt` is already 0.75 × window, so a hold ceiling at
 * 0.75 would leave no room at all: every digest would be built at the exact
 * point holding became forbidden, and the gate would be dead code on the most
 * common harness in the app.
 *
 * 0.95 spends part of the reserve `SAFETY_RATIO` sets aside — which is what that
 * reserve is FOR, since it is sized for one more full turn and a hold is exactly
 * one more turn. Past it there is no longer room to be polite, and the deferral
 * cap bounds how many turns can be spent in the band regardless.
 */
const HOLD_CEILING_RATIO = 0.95

export interface SwapGateInput {
  /** The digest's own read of whether the session is mid-task. */
  readonly midFlow: boolean
  /**
   * Structural evidence a summary cannot see: a plan still executing, a question
   * the user never answered, a gate awaiting approval, a background task running.
   */
  readonly localHold: boolean
  /** The latest working-set reading, in tokens. */
  readonly tokens: number
  /** The model's hard ceiling, or null when unknown. */
  readonly window: number | null
  /** How many times in a row this session has already deferred. */
  readonly deferrals: number
}

/**
 * Should the swap be HELD for another turn? Pure and total.
 *
 * Holding never discards the digest — it stays ready and is re-offered on the
 * next turn — so the worst case of a wrong "hold" is one turn of extra context,
 * bounded by both the ceiling and the deferral cap. The worst case of a wrong
 * "swap" is a session that forgets what it was doing halfway through doing it.
 */
export const shouldHoldSwap = (input: SwapGateInput): boolean => {
  // Physics beats preference: past the safety line, compact regardless.
  if (
    input.window !== null &&
    Number.isFinite(input.window) &&
    input.window > 0 &&
    Number.isFinite(input.tokens) &&
    input.tokens >= input.window * HOLD_CEILING_RATIO
  ) {
    return false
  }
  // A session that always looks busy would otherwise never compact at all.
  if (!Number.isFinite(input.deferrals) || input.deferrals >= MAX_SWAP_DEFERRALS) return false
  return input.midFlow || input.localHold
}

/**
 * ── The digest model ───────────────────────────────────────────────────────
 *
 * The summary run goes through the SESSION'S OWN harness binary, so it inherits
 * the user's existing subscription and quota. There is no API key, no separate
 * client, and no incremental cost beyond tokens they already pay for.
 *
 * Mirrors `reviewModelFor`, but inverted: a review deliberately reaches for a
 * STRONGER model than wrote the code, whereas a digest is a mechanical
 * summarisation and should reach for the CHEAPEST tier that can do it. That is
 * what `ProviderConfig.backgroundModel` has always been documented as — "small/
 * fast model for summaries & side tasks" — and this is its first consumer.
 */
export const DEFAULT_DIGEST_MODEL: Record<CliKind, string> = {
  claude: "haiku",
  // The cheapest tier in the Codex fallback list. Live discovery surfaces the
  // real catalogue; Settings is where a user picks something else.
  codex: "gpt-5.5",
  // No headless adapter — a digest on Cursor is refused before this is read.
  // Present only to keep the record total.
  cursor: "auto",
  // opencode Zen's free tier: the honest zero-config answer for a harness whose
  // catalogue comes from the user's own credentials.
  opencode: "opencode/north-mini-code-free",
  // Unreachable in practice — the orchestrator reports no context, so a digest
  // is never requested for it. Present because the record must be total, and
  // matching its sole catalogue entry so the "names a model the harness offers"
  // guard keeps holding.
  starbase: "auto"
}

/** The digest model for `cli`, honouring the user's `backgroundModel` override. */
export const digestModelFor = (cli: CliKind, configured?: string): string =>
  configured && configured.length > 0 ? configured : DEFAULT_DIGEST_MODEL[cli]

/**
 * ── Wire types ─────────────────────────────────────────────────────────────
 */



/** Per-session context accounting, as shown by the meter and Settings. */
export const ContextSnapshot = Schema.Struct({
  sessionId: Schema.String,
  /** Latest working-set reading, in tokens. */
  tokens: Schema.Number,
  /** The model's hard ceiling; null when unknown (meter renders nothing). */
  window: Schema.NullOr(Schema.Number),
  /** The configured quality budget for this session. */
  budget: Schema.Number,
  /** The computed `min(budget, window × safety)` — what the meter fills toward. */
  triggerAt: Schema.NullOr(Schema.Number),
  phase: Schema.Literal("unknown", "idle", "prepare", "swap"),
  /**
   * A digest is being built RIGHT NOW on a background fiber.
   *
   * Load-bearing for the UI, not diagnostics. Without it an automatic
   * compaction is completely invisible while it runs: the meter would sit on
   * "compacting soon" for however long the summary takes, with no sign anything
   * was happening — which reads as the feature being stuck rather than working.
   */
  preparing: Schema.Boolean,
  /**
   * A digest is built and waiting to be applied on the next turn.
   *
   * Distinct from `phase`: a manual "Compact now" can leave a session holding a
   * ready digest while still comfortably inside the budget, so `phase` reads
   * `idle` and only this says the next turn will reseed.
   */
  digestReady: Schema.Boolean,
  /** ISO timestamp of the last successful compaction, or null. */
  lastCompactedAt: Schema.NullOr(Schema.String),
  /** How many times this session has been compacted. */
  compactions: Schema.Number,
  /**
   * This session has given up on compacting itself.
   *
   * Set once consecutive digest failures hit the retry ceiling, after which the
   * manager stops forking fibers for this session entirely. Without it the meter
   * cannot tell "a digest is coming" from "no digest is ever coming": both leave
   * `phase: "prepare"` with `preparing: false`, so the UI promised "compacting
   * soon" indefinitely for a session that had permanently stopped trying.
   *
   * Cleared by a manual "Compact now", which resets the failure count.
   */
  stalled: Schema.Boolean,
  /**
   * A digest is ready but is being HELD because the session is mid-task.
   *
   * Visible for the same reason `preparing` is: a deferral nobody can see reads
   * as the feature being broken. Without it the meter would promise "compacts
   * next turn" for several turns running and never deliver.
   *
   * Optional so a snapshot encoded before this existed still decodes.
   */
  held: Schema.optional(Schema.Boolean),
  /** One line naming what is in flight, for the meter's tooltip. */
  heldReason: Schema.optional(Schema.NullOr(Schema.String))
})
export type ContextSnapshot = Schema.Schema.Type<typeof ContextSnapshot>
