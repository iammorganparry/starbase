import type { CliKind, WorkspaceConfig } from "@starbase/core"
import { Effect, Ref, Schema } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import { unattendedAnswers } from "./adversarial-plan.js"
import { evalPrompt } from "./eval-prompt.js"
import { extractJsonBlock } from "./review.js"

/**
 * An opt-in judge for the quality deterministic signals cannot see.
 *
 * It is the only part of the learning loop that SPENDS — it runs a model against
 * the operator's subscription — so it carries stricter guards than anything
 * else here: its own switch, fail-closed under the master switch, idle-only, a
 * daily budget, and a cheap model by default.
 *
 * Its verdict is a MINORITY component of the score (`JUDGE_WEIGHT`), never the
 * whole of it. A miscalibrated judge should nudge a cell, not define it —
 * otherwise the loop stops being grounded in observable events and starts being
 * grounded in one model's taste.
 */

const RawVerdict = Schema.Struct({
  score: Schema.optional(Schema.NullOr(Schema.Number)),
  reason: Schema.optional(Schema.String)
})

export interface Verdict {
  /** 0–1, or null when the judge declined to guess. */
  readonly score: number | null
  readonly reason: string | null
}

/**
 * Parse the judge's reply.
 *
 * Anything unusable becomes `null`, NOT a neutral 0.5. Coercing a refusal into a
 * midpoint would silently drag every judged cell toward the middle and look
 * exactly like a real measurement — the distinction between "no opinion" and "an
 * average opinion" is the whole reason abstaining is allowed.
 */
export const parseVerdict = (text: string): Verdict => {
  const block = extractJsonBlock(text)
  if (block === null) return { score: null, reason: null }
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(RawVerdict))(block)
  if (decoded._tag === "Left") return { score: null, reason: null }
  const raw = decoded.right.score
  const reason = decoded.right.reason?.trim()
  // Out-of-range is a malformed answer, not a clamped one: a judge that returns
  // 7 has misunderstood the scale, and rescuing its number would be inventing an
  // opinion it did not express.
  const score =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null
  return { score, reason: reason && reason.length > 0 ? reason : null }
}

/** Whether the judge may run at all. */
export const judgeEnabled = (config: WorkspaceConfig | null): boolean =>
  config?.learning?.enabled === true && config.learning.evalJudge === true

/** Judgements per day when the operator hasn't chosen. */
export const DEFAULT_DAILY_BUDGET = 20

export const dailyBudget = (config: WorkspaceConfig | null): number => {
  const configured = config?.learning?.evalJudgeDailyBudget
  return typeof configured === "number" && configured >= 0 ? configured : DEFAULT_DAILY_BUDGET
}

export interface JudgeRequest {
  readonly sessionId: string
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly task: string
  readonly diff: string
  readonly cli: CliKind
  /** The small/fast model from `ProviderConfig.backgroundModel`. */
  readonly model: string
  readonly binPath: string | null
}

/**
 * Ask the judge about one piece of work.
 *
 * Read-only and fresh, for the same reasons every side agent here is: the deny-
 * all gate is a denylist over tool names we map and the Codex adapter never
 * calls it, while a stale resume id would let one judgement inherit another's
 * context.
 *
 * Deliberately withholds WHICH model did the work. A judge that knew would make
 * the knowledge base self-confirming — rank a model highly, judge its work
 * generously, rank it higher.
 */
export const judge = (request: JudgeRequest): Effect.Effect<Verdict, never, CliAdapter> =>
  Effect.gen(function* () {
    const adapter = yield* CliAdapter
    const collected = yield* Ref.make<ReadonlyArray<string>>([])

    const spec: SessionSpec = {
      cli: request.cli,
      repo: request.repo,
      branch: request.branch,
      cwd: request.cwd,
      prompt: evalPrompt({ task: request.task, diff: request.diff }),
      images: [],
      binPath: request.binPath,
      mode: "ask",
      model: request.model,
      resumeId: null,
      fresh: true,
      readOnly: true,
      // Unattended: nobody is watching the transcript to notice a stray read.
      confineToCwd: true
    }

    const ctx: AgentContext = {
      emit: (event) =>
        event._tag === "Assistant" && event.agentId === undefined
          ? Ref.update(collected, (acc) => [...acc, event.text])
          : Effect.void,
      canUseTool: () => Effect.succeed("deny" as const),
      // NOT `[]`: an empty answer renders as "(no selection)" to the harness,
      // which reads as a non-answer and provokes an endless re-ask. The planning
      // roles hit exactly that and hung for 16 minutes; this judge runs
      // unattended on the same contract, so it carries the same fix.
      askQuestion: (req) => Effect.succeed(unattendedAnswers(req.questions)),
      proposePlan: () => Effect.succeed(PlanDecision.Reject()),
      registerBackgroundStop: () => Effect.void
    }

    const outcome = yield* adapter
      .run(`judge_${request.sessionId}`, spec, ctx)
      .pipe(Effect.either)
    // A failed judgement is simply an absent one. It must never fail a tick, and
    // must never be recorded as a low score — "the judge crashed" is not "the
    // work was bad".
    if (outcome._tag === "Left") return { score: null, reason: null }
    return parseVerdict((yield* Ref.get(collected)).join("\n"))
  })
