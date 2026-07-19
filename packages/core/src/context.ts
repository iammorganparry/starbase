import { Schema } from "effect"
import { CliKind } from "./domain.js"

/**
 * ── The quality band ────────────────────────────────────────────────────────
 *
 * Attention degrades long before a model hits its hard ceiling. The usable band
 * is roughly 256k–400k tokens; past that, recall and instruction-following fall
 * off regardless of how much window is nominally left.
 *
 * So compaction fires on an ABSOLUTE budget, not a percentage of the window. On
 * a 1M-window model we compact at 300k and simply decline to use the remaining
 * 700k, because that 700k is where the rot lives. A percentage rule would do the
 * opposite — it would let a 1M model run to 650k before acting, which is exactly
 * the failure this exists to prevent.
 */
export const DEFAULT_BUDGET_TOKENS = 300_000

/** The band the budget may be tuned within, enforced by schema and by clamp. */
export const BUDGET_RANGE = { min: 256_000, max: 400_000 } as const

/**
 * The window is a BACKSTOP, not the trigger. A model whose ceiling sits below
 * the budget (a 200k Claude) must still compact before it hits that ceiling, so
 * the effective trigger is `min(budget, window × SAFETY_RATIO)`.
 *
 * 0.85 leaves room for one more full turn plus the harness's own preamble. It is
 * deliberately not a user lever: it is mechanical self-preservation, and a user
 * who set it to 0.99 would simply get hard context errors instead of compaction.
 */
const SAFETY_RATIO = 0.85

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
    // 85% of 1M is 850k, deep into the rot. The budget wins here, by design.
    ["claude-fable", 1_000_000],
    ["fable", 1_000_000],
    ["opus", 200_000],
    ["sonnet", 200_000],
    ["haiku", 200_000]
  ],
  // The gpt-5 family's INPUT window, which is the number that matters for
  // context occupancy (the larger "total" figure includes output).
  codex: [["gpt-5", 272_000]]
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
  opencode: null
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

/** Clamp a configured budget into the usable band. */
export const clampBudget = (tokens: number): number =>
  Math.min(BUDGET_RANGE.max, Math.max(BUDGET_RANGE.min, Math.floor(tokens)))

/**
 * The working-set size at which compaction should fire: the quality budget, or
 * the window's safety margin, whichever comes first.
 *
 * A 1M model triggers at 300k because it *should*; a 200k model triggers at 170k
 * because it *must*.
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
  opencode: "opencode/north-mini-code-free"
}

/** The digest model for `cli`, honouring the user's `backgroundModel` override. */
export const digestModelFor = (cli: CliKind, configured?: string): string =>
  configured && configured.length > 0 ? configured : DEFAULT_DIGEST_MODEL[cli]

/**
 * ── Wire types ─────────────────────────────────────────────────────────────
 */

/**
 * The carried-forward summary of a conversation, produced by a background run
 * over our own transcript and used to seed a fresh harness conversation.
 *
 * Deliberately STRUCTURED rather than a prose blob. Structure is what lets the
 * compaction divider show the user exactly what survived, and what lets a
 * malformed model reply be rejected wholesale — a half-parsed digest that
 * silently dropped "decisions" would reseed a session with its own reasoning
 * amputated, and nothing downstream could tell.
 */
export const ContextDigest = Schema.Struct({
  /** What the user is ultimately trying to achieve in this session. */
  goal: Schema.String,
  /** Choices made and why — the part a summary most often destroys. */
  decisions: Schema.Array(Schema.String),
  /** Files created or modified, so the fresh conversation knows where it is. */
  filesTouched: Schema.Array(Schema.String),
  /** Work explicitly left unfinished. */
  openThreads: Schema.Array(Schema.String),
  /** Standing instructions the user gave that must keep applying. */
  preferences: Schema.Array(Schema.String),
  /**
   * The last message this digest covers. Everything AFTER it is replayed
   * verbatim at swap time, so a digest built two turns ago is still correct
   * without being rebuilt.
   */
  throughMessageId: Schema.String,
  builtAt: Schema.String
})
export type ContextDigest = Schema.Schema.Type<typeof ContextDigest>

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
  /** ISO timestamp of the last successful compaction, or null. */
  lastCompactedAt: Schema.NullOr(Schema.String),
  /** How many times this session has been compacted. */
  compactions: Schema.Number
})
export type ContextSnapshot = Schema.Schema.Type<typeof ContextSnapshot>

/** The global auto-compaction levers, persisted in `WorkspaceConfig.context`. */
export const ContextConfig = Schema.Struct({
  /** Master switch. Off returns the app to exactly its pre-feature behaviour. */
  auto: Schema.Boolean,
  /** Working-set budget in tokens, constrained to the usable band. */
  budgetTokens: Schema.Number.pipe(
    Schema.between(BUDGET_RANGE.min, BUDGET_RANGE.max)
  )
})
export type ContextConfig = Schema.Schema.Type<typeof ContextConfig>

/** The shipped defaults — auto ON, mid-band budget. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  auto: true,
  budgetTokens: DEFAULT_BUDGET_TOKENS
}
