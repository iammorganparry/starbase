import type {
  CliKind,
  ModelOption,
  Plan,
  PlanChallenge,
  PlanCritique,
  PlanParticipant,
  PlanRound,
  PlanStep,
  QuestionAnswer,
  ReviewSeverity,
  StreamEvent,
  VendorReach
} from "@starbase/core"
import { DEFAULT_REVIEW_MODEL, PlanError, scopeToAgent } from "@starbase/core"
import { Effect, Mailbox, Ref, Schema, Stream } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, isChildLifecycle, PlanDecision } from "./adapter.js"
import type { AvailableAgent } from "./adversarial-plan-prompt.js"
import { critiquePrompt, planAsText, proposalPrompt, revisionPrompt } from "./adversarial-plan-prompt.js"
import { extractJsonBlock } from "./review.js"
import { parsePlan } from "./plan-parse.js"

/**
 * Adversarial planning: one flagship proposes a plan, a model from a DIFFERENT
 * lab attacks it, and the proposer answers.
 *
 * Deliberately bypasses `AgentRunner` for the same reasons `ReviewService` does
 * — the runner takes its model from the session, writes the transcript, persists
 * a resume id, and parks on approval gates, and all four are wrong for a
 * non-interactive side agent. So this builds its own `SessionSpec` per role and
 * drives `CliAdapter` directly.
 *
 * The three roles are surfaced as SUBAGENTS of the planning run, which is not a
 * cosmetic choice: it means the existing agent tab bar renders each phase live,
 * with its own transcript, for free — "proposing / attacking / revising" is
 * legible as it happens rather than one opaque spinner.
 */

// ── Pure helpers (the testable seam) ─────────────────────────────────────────

/** Raw shapes: everything optional, because a model's JSON is never trusted. */
const RawChallenge = Schema.Struct({
  step: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  rationale: Schema.optional(Schema.String)
})
const RawCritique = Schema.Struct({
  challenges: Schema.optional(Schema.Array(RawChallenge))
})
const RawResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  defence: Schema.optional(Schema.NullOr(Schema.String))
})
const RawResponses = Schema.Struct({
  responses: Schema.optional(Schema.Array(RawResponse))
})

const SEVERITIES: ReadonlyArray<ReviewSeverity> = ["critical", "major", "minor", "nit"]

const asSeverity = (raw: string | undefined): ReviewSeverity => {
  const s = (raw ?? "").toLowerCase().trim()
  return SEVERITIES.includes(s as ReviewSeverity) ? (s as ReviewSeverity) : "minor"
}

const nonEmpty = (raw: string | null | undefined): string | null => {
  const s = (raw ?? "").trim()
  return s.length > 0 ? s : null
}

/** Normalise "2", "02", "step 02" to the plan's own ordinal form. */
const normaliseStepRef = (raw: string | null | undefined): string | null => {
  const s = (raw ?? "").trim().replace(/^step\s*/i, "")
  if (s.length === 0) return null
  return /^\d$/.test(s) ? `0${s}` : s
}

export interface ParsedCritique {
  readonly challenges: ReadonlyArray<PlanChallenge>
  /** Parallel to `challenges` — the step each attacks, null for plan-level. */
  readonly targets: ReadonlyArray<string | null>
}

/**
 * Parse the adversary's reply into challenges.
 *
 * Returns null ONLY when there was no parseable JSON at all — which is a
 * different outcome from an empty array, and the caller must keep them apart. An
 * empty array means a rival lab read the plan and found nothing; null means it
 * refused, rambled, or emitted junk, and reporting that as a clean bill of
 * health is the most misleading thing this feature could do.
 */
export const parseCritique = (text: string): ParsedCritique | null => {
  const block = extractJsonBlock(text)
  if (block === null) return null
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(RawCritique))(block)
  if (decoded._tag === "Left") return null
  const raw = decoded.right.challenges ?? []
  const challenges: PlanChallenge[] = []
  const targets: (string | null)[] = []
  raw.forEach((c, i) => {
    const title = nonEmpty(c.title)
    // A challenge with no title has nothing to show, so it cannot be actioned
    // or dismissed — dropping it is better than rendering a blank row.
    if (title === null) return
    challenges.push({
      id: `c${i + 1}`,
      severity: asSeverity(c.severity),
      title,
      rationale: nonEmpty(c.rationale) ?? "",
      status: "open",
      defence: null
    })
    targets.push(normaliseStepRef(c.step))
  })
  return { challenges, targets }
}

/** How the proposer said it handled each challenge, keyed by challenge id. */
export type ChallengeResponses = ReadonlyMap<
  string,
  { readonly status: "addressed" | "defended"; readonly defence: string | null }
>

/**
 * Parse the revision's account of each challenge.
 *
 * A response that claims `defended` with no reason is downgraded to `open`
 * rather than trusted: "I considered this and disagree" with no argument is
 * indistinguishable from ignoring it, and treating it as an answer would let a
 * model silently dismiss every objection by asserting it had thought about them.
 */
export const parseResponses = (text: string): ChallengeResponses => {
  const out = new Map<string, { status: "addressed" | "defended"; defence: string | null }>()
  const block = extractJsonBlock(text)
  if (block === null) return out
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(RawResponses))(block)
  if (decoded._tag === "Left") return out
  for (const r of decoded.right.responses ?? []) {
    const id = nonEmpty(r.id)
    if (id === null) continue
    const defence = nonEmpty(r.defence)
    const status = (r.status ?? "").toLowerCase().trim()
    if (status === "addressed") out.set(id, { status: "addressed", defence: null })
    else if (status === "defended" && defence !== null) out.set(id, { status: "defended", defence })
  }
  return out
}

/**
 * Fold the critique and the proposer's answers onto the revised plan's steps.
 *
 * A challenge the revision never mentioned stays `open` — that is the whole
 * point of the round. Silence is not resolution, and an unanswered objection is
 * the most useful thing a reader can be shown.
 */
export const applyChallenges = (
  plan: Plan,
  critique: ParsedCritique,
  responses: ChallengeResponses,
  /**
   * The plan the critique was actually written against.
   *
   * Load-bearing when `plan` is the REVISION. The adversary's targets are step
   * NUMBERS against the proposal, and a revision is free to renumber — insert a
   * step at 02 and the old 03 becomes 04. Keying the revised plan by number
   * then pinned "the migration has no rollback" to whatever now sits at 03, and
   * handed the actual migration `challenges: []` — which this codebase defines
   * as "examined and survived". The highest-value signal in the round, attached
   * to the wrong step and endorsing the right one.
   *
   * Titles survive renumbering far better than numbers do, so targets are
   * resolved number → title against the source, then title → step in `plan`.
   * Omit it when `plan` IS what the critique reviewed.
   */
  source?: Plan
): Plan => {
  const resolved = critique.challenges.map((c): PlanChallenge => {
    const answer = responses.get(c.id)
    if (answer === undefined) return c
    return { ...c, status: answer.status, defence: answer.defence }
  })
  // What the adversary reviewed, keyed the way it referred to steps.
  const reviewed = source ?? plan
  const titleOf = new Map(reviewed.steps.map((s) => [s.number, s.title]))
  const key = (s: PlanStep): string => (source === undefined ? s.number : s.title)

  const byStep = new Map<string, PlanChallenge[]>()
  resolved.forEach((c, i) => {
    const target = critique.targets[i]
    if (target === null || target === undefined) return
    const k = source === undefined ? target : titleOf.get(target)
    if (k === undefined) return
    byStep.set(k, [...(byStep.get(k) ?? []), c])
  })

  // Titles the adversary actually saw. A step absent from this set is NEW in
  // the revision — nothing examined it — so it gets `undefined`, not `[]`.
  // `wasChallenged` reads the difference, and collapsing the two would let an
  // unreviewed step read as an endorsed one.
  const examined = new Set(reviewed.steps.map((s) => (source === undefined ? s.number : s.title)))

  return {
    ...plan,
    steps: plan.steps.map((s): PlanStep => {
      const found = byStep.get(key(s))
      if (found !== undefined) return { ...s, challenges: found }
      return examined.has(key(s))
        ? { ...s, challenges: [] }
        : { ...s, challenges: undefined }
    })
  }
}

/** Mark every step as examined-and-clean, for a critique that raised nothing. */
export const markUnchallenged = (plan: Plan): Plan => ({
  ...plan,
  steps: plan.steps.map((s): PlanStep => ({ ...s, challenges: [] }))
})

/**
 * Record what the knowledge base actually said about each chosen assignee.
 *
 * The MODEL picks and writes the reason; this only annotates. Letting the KB
 * overwrite the pick would make a thin cell authoritative, and letting the model
 * write its own `evidence` would let it invent a track record — so the two
 * halves come from the two places that can honestly supply them.
 */
export const annotateAssignees = (
  plan: Plan,
  ranked: ReadonlyArray<{ cli: CliKind; model: string; level: string; observations: number }>
): Plan => ({
  ...plan,
  steps: plan.steps.map((s): PlanStep => {
    if (!s.assignee) return s
    const match = ranked.find((r) => r.cli === s.assignee!.cli && r.model === s.assignee!.model)
    if (match === undefined) return s
    return {
      ...s,
      assignee: {
        ...s.assignee,
        evidence: { level: match.level, observations: match.observations }
      }
    }
  })
})

/** Stamp each step with the model that proposed it. */
export const markOrigin = (plan: Plan, by: PlanParticipant): Plan => ({
  ...plan,
  steps: plan.steps.map((s): PlanStep => ({ ...s, origin: by }))
})

/**
 * The strongest model available for a vendor, on the harness we reach it by.
 *
 * Prefers the harness's curated top tier (`DEFAULT_REVIEW_MODEL` — Fable for
 * Claude) when that model actually belongs to this vendor, which it does for the
 * native harnesses. For a lab reached through opencode the curated default names
 * an opencode model, not this vendor's, so the vendor's own first model wins.
 */
export const flagshipFor = (reach: VendorReach): ModelOption | null => {
  const curated = DEFAULT_REVIEW_MODEL[reach.cli]
  return reach.models.find((m) => m.id === curated) ?? reach.models[0] ?? null
}

/**
 * Pick who proposes and who attacks.
 *
 * The two must come from different labs — a critic trained alongside the author
 * shares its blind spots, which is the entire premise of the feature. Beyond
 * that the choice is a documented preference rather than a discovered fact:
 * Anthropic proposes and OpenAI attacks when both are present, because those are
 * the two the repo already treats as its strongest planner and its strongest
 * reviewer. Everything else falls back to the stable vendor order so the roles
 * never flicker between runs.
 */
export const chooseRoles = (
  vendors: ReadonlyArray<VendorReach>
): { proposer: VendorReach; adversary: VendorReach } | null => {
  if (vendors.length < 2) return null
  const proposer =
    vendors.find((v) => v.vendor === "anthropic") ?? vendors[0]!
  const adversary =
    vendors.find((v) => v.vendor === "openai" && v.vendor !== proposer.vendor) ??
    vendors.find((v) => v.vendor !== proposer.vendor)!
  return { proposer, adversary }
}

const participant = (reach: VendorReach, model: ModelOption): PlanParticipant => ({
  cli: reach.cli,
  model: model.id,
  vendor: reach.vendor
})

// ── The service ──────────────────────────────────────────────────────────────

export interface PlanRoundInput {
  readonly sessionId: string
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly brief: string
  readonly vendors: ReadonlyArray<VendorReach>
  readonly binPathFor: (cli: CliKind) => string | null
  /** Whether to ask the round to route each step to an agent. */
  readonly assignAgents: boolean
  /**
   * What this repo's history says about each candidate, when learning is on and
   * has anything to say. Absent means phase-A behaviour: the model routes on its
   * own judgement, which is exactly what should happen with an empty or disabled
   * knowledge base.
   */
  readonly affinity?: ReadonlyArray<{
    readonly cli: CliKind
    readonly model: string
    readonly level: string
    readonly observations: number
    readonly estimate: number
  }>
  /**
   * Where the finished round goes — the plan library wires the store in here.
   * A hook rather than a service dependency so the round logic stays pure of
   * persistence and can be driven in tests without a filesystem.
   */
  readonly onRound?: (round: PlanRound) => Effect.Effect<void>
}

type RoundEnv = CliAdapter

const ROLE_IDS = { propose: "plan_propose", attack: "plan_attack", revise: "plan_revise" } as const

/**
 * What a role is told when it asks the operator a question mid-round.
 *
 * There is nobody to ask: a planning role runs unattended, and its questions are
 * not rendered anywhere. Returning NO answers looks like it should be safe, but
 * it is the opposite — `formatQuestionAnswer` then renders "(no selection)",
 * which gives the model nothing to act on, so it simply rephrases and asks
 * again. Observed in the app: a proposer that normally finishes in ~52s ran for
 * 16 minutes in that loop and never produced a plan.
 *
 * So the answer has to be DECISIVE rather than empty. We deliberately do not
 * pick one of its options for it — inventing a preference would silently steer
 * the plan — and instead tell it to choose, proceed, and surface the choice as
 * an assumption, which is exactly the thing a reviewer needs to see.
 */
export const UNATTENDED_ANSWER =
  "Nobody is available to answer during planning. Choose the option you judge most likely, " +
  "continue without asking again, and record the choice explicitly as an assumption in the plan."

/**
 * One decisive answer per question asked.
 *
 * Exported for test: the wording is load-bearing (it is the thing that breaks
 * the re-ask loop), and the shape must stay one answer per question because
 * `formatQuestionAnswer` pairs them positionally.
 */
export const unattendedAnswers = (
  questions: ReadonlyArray<{ readonly question: string }>
): ReadonlyArray<QuestionAnswer> =>
  questions.map(() => ({ selected: [], other: UNATTENDED_ANSWER }))

/**
 * How long any single role may run before the round gives up on it.
 *
 * Measured against the real harnesses on a small repo: propose ~52s, attack
 * ~270s, revise ~147s. Eight minutes is therefore several times the slowest
 * observed role — generous enough that a legitimately slow run is never killed,
 * while still bounded, because the alternative is what we actually shipped: a
 * round that hangs forever with the session sitting at "Idle" and nothing on
 * screen to say it died.
 */
export const ROLE_TIMEOUT = "8 minutes"

/**
 * Run one role to completion and return everything it said on the main thread.
 *
 * Subagent chatter is excluded from the collected text on purpose: a planner
 * that spawns a helper would otherwise interleave the helper's illustrative JSON
 * into the reply we parse, and the contract says the LAST block is the payload —
 * so a subagent's example would win that race.
 */
const runRole = (
  input: PlanRoundInput,
  role: keyof typeof ROLE_IDS,
  who: PlanParticipant,
  prompt: string,
  emit: (event: StreamEvent) => Effect.Effect<void>
): Effect.Effect<string, PlanError, RoundEnv> =>
  Effect.gen(function* () {
    const adapter = yield* CliAdapter
    const collected = yield* Ref.make<ReadonlyArray<string>>([])
    const childFailure = yield* Ref.make<string | null>(null)
    const agentId = ROLE_IDS[role]

    const spec: SessionSpec = {
      cli: who.cli,
      repo: input.repo,
      branch: input.branch,
      cwd: input.cwd,
      prompt,
      images: [],
      binPath: input.binPathFor(who.cli),
      // "ask" rather than "plan": plan mode drives the harness toward
      // ExitPlanMode, which only Claude has — and this round deliberately reads
      // its plan out of a fenced block so any harness can hold any role.
      mode: "ask",
      model: who.model,
      resumeId: null,
      // `resumeId: null` alone is NOT enough — the adapter's in-memory resume map
      // wins over the spec, and our key is stable per session and role, so every
      // re-plan would silently resume the previous one and inherit its context.
      // A plan must be a pure function of THIS brief.
      fresh: true,
      // The load-bearing half of read-only. The deny-all gate below is a denylist
      // over tool names WE map, and the Codex adapter never calls it at all — so
      // without this a Codex planner would run workspace-write over the very
      // worktree it was told not to touch.
      readOnly: true,
      // Unattended: nobody is watching the transcript to notice a stray read.
      unattended: true
    }

    const ctx: AgentContext = {
      emit: (event) =>
        event._tag === "Failed"
          ? Ref.set(childFailure, event.message)
          : Effect.zipRight(
              // A role's own `Started`/`Done` never reaches the parent — see
              // `isChildLifecycle`. Forwarding either ended the round the moment
              // the proposer finished. Failed is captured above: swallowing its
              // reason would turn a logged-out harness into an empty fake plan.
              isChildLifecycle(event) ? Effect.void : emit(scopeToRole(event, agentId)),
              event._tag === "Assistant" && event.agentId === undefined
                ? Ref.update(collected, (acc) => [...acc, event.text])
                : Effect.void
            ),
      canUseTool: () => Effect.succeed("deny" as const),
      // NOT `[]` — see `UNATTENDED_ANSWER`. An empty answer reads as
      // "(no selection)" to the harness and provokes an endless re-ask.
      askQuestion: (request) => Effect.succeed(unattendedAnswers(request.questions)),
      proposePlan: () => Effect.succeed(PlanDecision.Reject()),
      // Deliberately dropped: these are nested read-only runs under the session's
      // own id, so registering a stop handle would overwrite the real agent's and
      // aim the dock's Stop button at a planner instead of the task.
      registerBackgroundStop: () => Effect.void
    }

    yield* emit({
      _tag: "SubagentStarted",
      id: agentId,
      name: ROLE_NAMES[role],
      description: `${who.cli} · ${who.model} (${who.vendor})`,
      parentId: null,
      // Brand the tab with the harness ACTUALLY running this role. The attacker
      // is deliberately a rival lab, so inheriting the session's CLI would label
      // a Codex run "Claude".
      cli: who.cli
    })
    const outcome = yield* adapter
      .run(`${agentId}_${input.sessionId}`, spec, ctx)
      .pipe(
        // Bounded so a role that never terminates fails the round LOUDLY rather
        // than leaving the session at "Idle" forever. `Effect.either` below is
        // not enough on its own: it only catches a failure that actually
        // arrives.
        Effect.timeoutFail({
          duration: ROLE_TIMEOUT,
          onTimeout: () => ({ _tag: "RoleTimedOut" }) as const
        }),
        Effect.either
      )
    const reportedFailure = yield* Ref.get(childFailure)
    yield* emit({
      _tag: "SubagentEnded",
      id: agentId,
      status: outcome._tag === "Right" && reportedFailure === null ? "done" : "error"
    })
    if (outcome._tag === "Left") {
      // Name WHICH failure. "The Proposing step failed" sends you to the logs;
      // "gave up after 8 minutes" tells you it stalled rather than errored.
      const timedOut = outcome.left._tag === "RoleTimedOut"
      return yield* Effect.fail(
        new PlanError({
          message: timedOut
            ? `The ${ROLE_NAMES[role]} step gave up after ${ROLE_TIMEOUT} without finishing.`
            : `The ${ROLE_NAMES[role]} step failed: ${outcome.left.message}`
        })
      )
    }
    if (reportedFailure !== null) {
      return yield* Effect.fail(
        new PlanError({ message: `The ${ROLE_NAMES[role]} step failed: ${reportedFailure}` })
      )
    }
    return (yield* Ref.get(collected)).join("\n")
  })

const ROLE_NAMES = {
  propose: "Proposing",
  attack: "Attacking",
  revise: "Revising"
} as const

/** Attribute an event to the role that produced it, where the shape allows. */
const scopeToRole = scopeToAgent

export class AdversarialPlanService extends Effect.Service<AdversarialPlanService>()(
  "@starbase/AdversarialPlanService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      /**
       * Propose, attack, revise — as a stream, so the operator watches it happen.
       *
       * Every degradation below is deliberate and none of them fail the round: a
       * plan that survived less scrutiny than intended is still worth having, and
       * the OUTCOME records exactly how much scrutiny it got so nothing has to
       * pretend otherwise.
       */
      const run = (
        input: PlanRoundInput
      ): Stream.Stream<StreamEvent, PlanError, RoundEnv> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const out = yield* Mailbox.make<StreamEvent>()
            const emit = (event: StreamEvent) => Effect.asVoid(out.offer(event))

            const work = Effect.gen(function* () {
              const roles = chooseRoles(input.vendors)
              if (roles === null) {
                return yield* Effect.fail(
                  new PlanError({
                    message:
                      "Adversarial planning needs two model providers so a rival lab can review the plan."
                  })
                )
              }
              const proposerModel = flagshipFor(roles.proposer)
              const adversaryModel = flagshipFor(roles.adversary)
              if (proposerModel === null || adversaryModel === null) {
                return yield* Effect.fail(
                  new PlanError({ message: "No usable model for one of the planning roles." })
                )
              }
              const proposer = participant(roles.proposer, proposerModel)
              const adversary = participant(roles.adversary, adversaryModel)
              const agents: ReadonlyArray<AvailableAgent> = input.vendors.flatMap((v) =>
                v.models.map((m) => {
                  const known = input.affinity?.find((a) => a.cli === v.cli && a.model === m.id)
                  return {
                    cli: v.cli,
                    model: m.id,
                    vendor: v.vendor,
                    ...(known
                      ? {
                          evidence: {
                            level: known.level,
                            observations: known.observations,
                            estimate: known.estimate
                          }
                        }
                      : {})
                  }
                })
              )

              yield* emit({ _tag: "Started", sessionId: input.sessionId, model: proposer.model })

              // ── Propose ────────────────────────────────────────────────────
              const proposalText = yield* runRole(
                input,
                "propose",
                proposer,
                proposalPrompt({ brief: input.brief, agents, assignAgents: input.assignAgents }),
                emit
              )
              const proposal = markOrigin(parsePlan(proposalText, `${input.sessionId}_proposal`), proposer)

              // ── Attack ─────────────────────────────────────────────────────
              // A dead adversary must not fail the round: an unchallenged plan is
              // still a plan. It is labelled `unchallenged`, never as endorsed.
              const critiqueText = yield* runRole(
                input,
                "attack",
                adversary,
                critiquePrompt({ brief: input.brief, plan: planAsText(proposal) }),
                emit
              ).pipe(Effect.either)

              if (critiqueText._tag === "Left") {
                yield* emit({ _tag: "PlanProposed", plan: proposal })
                yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
                return round(input, proposer, null, proposal, null, null, "unchallenged")
              }

              const parsed = parseCritique(critiqueText.right)
              // null (no parseable JSON) is NOT an empty critique. The adversary
              // refused or rambled, so nobody meaningfully reviewed this plan.
              if (parsed === null) {
                const plan = proposal
                yield* emit({ _tag: "PlanProposed", plan })
                yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
                const critique: PlanCritique = {
                  by: adversary,
                  challenges: [],
                  targets: [],
                  note: critiqueText.right.trim().slice(0, 2000)
                }
                return round(input, proposer, adversary, plan, critique, null, "unchallenged")
              }

              if (parsed.challenges.length === 0) {
                const plan = markUnchallenged(proposal)
                yield* emit({ _tag: "PlanProposed", plan })
                yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
                const critique: PlanCritique = {
                  by: adversary,
                  challenges: [],
                  targets: [],
                  note: null
                }
                return round(input, proposer, adversary, plan, critique, null, "clean")
              }

              // ── Revise ─────────────────────────────────────────────────────
              const revisionText = yield* runRole(
                input,
                "revise",
                proposer,
                revisionPrompt({
                  brief: input.brief,
                  plan: planAsText(proposal),
                  challenges: parsed.challenges,
                  agents,
                  assignAgents: input.assignAgents
                }),
                emit
              ).pipe(Effect.either)

              const critique: PlanCritique = {
                by: adversary,
                challenges: parsed.challenges,
                targets: parsed.targets,
                note: null
              }

              if (revisionText._tag === "Left") {
                // The critique still stands even though the answer never came —
                // every challenge stays `open`, which is the honest report.
                const plan = applyChallenges(proposal, parsed, new Map())
                yield* emit({ _tag: "PlanProposed", plan })
                yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
                return round(input, proposer, adversary, plan, critique, null, "revised")
              }

              const revised = markOrigin(
                parsePlan(revisionText.right, `${input.sessionId}_revised`),
                proposer
              )
              const answered = annotateAssignees(
                applyChallenges(revised, parsed, parseResponses(revisionText.right), proposal),
                input.affinity ?? []
              )
              yield* emit({ _tag: "PlanProposed", plan: answered })
              yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
              return round(input, proposer, adversary, proposal, critique, answered, "revised")
            })

            yield* Effect.forkScoped(
              work.pipe(
                // Persistence is best-effort and last: a full store must never
                // lose a plan the operator can already see on screen.
                Effect.tap((r) => (input.onRound ? input.onRound(r).pipe(Effect.ignore) : Effect.void)),
                Effect.tapError((e) => emit({ _tag: "Failed", message: e.message })),
                Effect.ignore,
                Effect.ensuring(out.end)
              )
            )
            return Mailbox.toStream(out)
          })
        )

      return { run }
    })
  }
) {}

const round = (
  input: PlanRoundInput,
  proposer: PlanParticipant,
  adversary: PlanParticipant | null,
  proposal: Plan,
  critique: PlanCritique | null,
  revised: Plan | null,
  outcome: PlanRound["outcome"]
): PlanRound => ({
  id: `round_${input.sessionId}`,
  sessionId: input.sessionId,
  createdAt: new Date().toISOString(),
  proposer,
  adversary,
  proposal,
  critique,
  revised,
  outcome
})
