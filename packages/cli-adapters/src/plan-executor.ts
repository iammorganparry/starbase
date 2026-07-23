import type {
  CliKind,
  ExecutionMode,
  Plan,
  PlanStep,
  RouteAttempt,
  RouteCandidate,
  StreamEvent
} from "@starbase/core"
import { executionOrder, PlanError, resolveRunner, scopeToAgent } from "@starbase/core"
import { Effect, Mailbox, Ref, Schema, Stream } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, isChildLifecycle, PlanDecision } from "./adapter.js"
import { unattendedAnswers } from "./adversarial-plan.js"
import { stepPrompt } from "./plan-executor-prompt.js"
import type { RouteFailure } from "./provider-failure.js"
import { classifyProviderFailure, toolMayMutate } from "./provider-failure.js"
import { extractJsonBlock } from "./review.js"

/**
 * Running an approved plan, one step at a time, each on the harness the plan
 * chose for it.
 *
 * This is the half of "orchestrator" that actually orchestrates: the round
 * decides WHO should do each piece of work, and without this that decision is
 * decoration. Each step becomes a subagent of the run, so the existing tab bar
 * renders per-step progress for free — the same trick the planning round uses
 * for its three roles.
 *
 * Sequential, deliberately. Steps share ONE worktree, so two agents editing at
 * once would interleave writes to the same files with no lock and no way to
 * attribute the result. Parallelism here needs a worktree per step, which is a
 * different feature.
 */

export interface StepRunInput {
  readonly sessionId: string
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly plan: Plan
  /**
   * Bounded text-only context from the conversation that produced the plan.
   * Every step starts a fresh harness session, so this is its only access to the
   * original request and decisions that the structured plan may only summarize.
   */
  readonly context?: string
  /** Harness+model pairs this host can actually run. */
  readonly available: ReadonlyArray<{
    readonly cli: CliKind
    readonly model: string
  }>
  /** Known catalogue routes that cannot run now, with the operator-facing cause. */
  readonly unavailable?: ReadonlyArray<{
    readonly cli: CliKind
    readonly model: string
    readonly reason: string
  }>
  /** Used when a step names no assignee, or names one that isn't installed. */
  readonly fallback: { readonly cli: CliKind; readonly model: string } | null
  readonly binPathFor: (cli: CliKind) => string | null
  /** Concrete permission mode selected when the operator approved the plan. */
  readonly executionMode?: ExecutionMode
  /** Called as each step finishes, so progress survives a crash mid-run. */
  readonly onStepDone?: (step: PlanStep) => Effect.Effect<void>
  /** Called after every route attempt, so provenance survives a crash mid-step. */
  readonly onStepUpdated?: (step: PlanStep) => Effect.Effect<void>
}

/** A step's subagent id — stable, so a reconnecting watcher lands on the same tab. */
export const stepAgentId = (step: PlanStep): string => `plan_step_${step.id}`

/**
 * How long one step may run before the plan gives up on it.
 *
 * Far more generous than the planning roles': this is real work, not a
 * classification, and a substantial step legitimately takes many minutes. Still
 * bounded, because the alternative is a run that never ends and a session that
 * sits at "Idle" with no explanation — the exact failure the planning round
 * shipped with.
 */
export const STEP_TIMEOUT = "30 minutes"

/**
 * How many times a step may be attempted before the run asks for help.
 *
 * The run is meant to carry an approved plan to completion without supervision,
 * so a step that fails once is retried WITH the blocker it reported — most
 * first failures are a missing detail the agent can work around once it knows.
 * Three is where that stops being true: an agent that has failed three times
 * with three explanations is not one attempt away from success, it is stuck,
 * and continuing to spend on it is worse than saying so.
 */
export const MAX_STEP_ATTEMPTS = 3

/** What a step says about itself when it finishes. */
export interface StepVerdict {
  readonly status: "done" | "blocked"
  /** Why it is blocked, in the agent's words. Null when done. */
  readonly reason: string | null
}

export type StepAttemptOutcome =
  | { readonly status: "done"; readonly mutationPossible: boolean }
  | { readonly status: "blocked"; readonly reason: string | null; readonly mutationPossible: boolean }
  | {
      readonly status: "failed"
      readonly failure: RouteFailure
      readonly mutationPossible: boolean
    }

const RawVerdict = Schema.Struct({
  status: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.NullOr(Schema.String))
})

/**
 * Read the step's closing verdict.
 *
 * An unparseable or absent verdict counts as DONE, which is the uncomfortable
 * default and chosen deliberately. These steps share one worktree and have
 * already written to it; re-running a step that actually succeeded risks
 * applying its edits twice, which is a worse and much harder failure to see than
 * a step that quietly did less than it claimed. A step that wrongly reports done
 * is caught by the next step failing, or by the diff the operator reviews —
 * neither of which can recover a double-applied edit.
 */
export const parseStepVerdict = (text: string): StepVerdict => {
  const block = extractJsonBlock(text)
  if (block === null) return { status: "done", reason: null }
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(RawVerdict))(block)
  if (decoded._tag === "Left") return { status: "done", reason: null }
  const status = decoded.right.status?.trim().toLowerCase()
  if (status !== "blocked") return { status: "done", reason: null }
  const reason = decoded.right.reason?.trim()
  return {
    status: "blocked",
    reason: reason && reason.length > 0 ? reason : null
  }
}

/** Attribute a step's output to its own tab. See `scopeToAgent` for the trap. */
const scopeTo = scopeToAgent

/**
 * Execute one step.
 *
 * `readOnly` is deliberately NOT set: this is the one agent in the app that is
 * supposed to change the worktree. It runs in `accept-edits` rather than `ask`
 * because the plan has already been reviewed and approved — stopping to ask
 * about each edit would re-litigate a decision the operator already made, and
 * an unattended run has nobody to ask anyway.
 */
const runStep = (
  input: StepRunInput,
  step: PlanStep,
  runner: { readonly cli: CliKind; readonly model: string },
  attempt: number,
  previousBlocker: string | null,
  emit: (event: StreamEvent) => Effect.Effect<void>,
  /** Run-level spend accumulator — see the `Done` branch in `ctx.emit`. */
  spend: Ref.Ref<{ costUsd: number; tokens: number }>
): Effect.Effect<StepAttemptOutcome, PlanError, CliAdapter> =>
  Effect.gen(function* () {
    const adapter = yield* CliAdapter
    const collected = yield* Ref.make<ReadonlyArray<string>>([])
    const childFailure = yield* Ref.make<string | null>(null)
    const mutationPossible = yield* Ref.make(false)
    // Retries share the step's tab, but need distinct adapter session ids or the
    // resume map would hand attempt 2 attempt 1's context — which is exactly the
    // context we are trying to replace with a corrected brief.
    const agentId = stepAgentId(step)

    const spec: SessionSpec = {
      cli: runner.cli,
      repo: input.repo,
      branch: input.branch,
      cwd: input.cwd,
      prompt: stepPrompt({
        plan: input.plan,
        step,
        context: input.context,
        previousBlocker
      }),
      images: [],
      binPath: input.binPathFor(runner.cli),
      mode: input.executionMode ?? "accept-edits",
      model: runner.model,
      resumeId: null,
      // Each step is its own context. Resuming would carry one step's reasoning
      // into the next, which defeats the point of assigning them to different
      // models — the second would inherit the first's framing.
      fresh: true,
      readOnly: false,
      // File tools are held to this worktree. Note what that does NOT cover: a
      // step legitimately needs Bash to build and test, and Bash takes a command
      // string rather than a path, so the shell is not confined. An approved
      // plan is trusted code execution — the confinement here narrows careless
      // reads and writes, it is not a sandbox.
      unattended: true
    }

    const ctx: AgentContext = {
      emit: (event) =>
        Effect.zipRight(
          Effect.zipRight(
            // A step's `Done` is dropped as a lifecycle event, but it is also
            // the ONLY carrier of what the step cost. Dropping it outright made
            // a two-hour twelve-step run report a spend of exactly zero — in a
            // feature whose sibling machinery exists precisely because silent
            // spend is the failure being fixed. Accrue before discarding.
            event._tag === "Done"
              ? Ref.update(spend, (t) => ({
                  costUsd: t.costUsd + (Number.isFinite(event.costUsd) ? event.costUsd : 0),
                  tokens: t.tokens + (Number.isFinite(event.tokens) ? event.tokens : 0)
                }))
              : Effect.void,
            // A step's own `Started`/`Done`/`Failed` never reaches the parent —
            // see `isChildLifecycle`. Forwarding them ends the whole run at the
            // first step that succeeds.
            isChildLifecycle(event) ? Effect.void : emit(scopeTo(event, agentId))
          ),
          Effect.all(
            [
              event._tag === "Assistant" && event.agentId === undefined
                ? Ref.update(collected, (acc) => [...acc, event.text])
                : Effect.void,
              event._tag === "Failed" ? Ref.set(childFailure, event.message) : Effect.void,
              event._tag === "ToolStart" && toolMayMutate(event.name)
                ? Ref.set(mutationPossible, true)
                : Effect.void,
              event._tag === "ToolEnd" && event.diff !== null
                ? Ref.set(mutationPossible, true)
                : Effect.void
            ],
            { discard: true }
          )
        ),
      // The plan was approved; edits are the work. Commands still gate through
      // the harness's own `accept-edits` semantics rather than being waved
      // through here.
      canUseTool: () => Effect.succeed("allow" as const),
      // Decisive, never empty — an empty answer reads as "(no selection)" and
      // provokes an endless re-ask. See `UNATTENDED_ANSWER`.
      askQuestion: (req) => Effect.succeed(unattendedAnswers(req.questions)),
      proposePlan: () => Effect.succeed(PlanDecision.Reject()),
      registerBackgroundStop: () => Effect.void
    }

    yield* emit({
      _tag: "SubagentStarted",
      id: agentId,
      // No attempt suffix: `applySubagentEvent` ignores a `SubagentStarted`
      // whose id it already holds, and retries reuse the step's id on purpose so
      // they share one tab. A computed "(try 2)" would be silently discarded.
      // Retries are surfaced by the blocker line the loop emits instead.
      name: `${step.number} ${step.title}`,
      description: `${runner.cli} · ${runner.model}`,
      parentId: null
    })

    const outcome = yield* adapter.run(`${agentId}_${input.sessionId}_a${attempt}`, spec, ctx).pipe(
      Effect.timeoutFail({
        duration: STEP_TIMEOUT,
        onTimeout: () => ({ _tag: "StepTimedOut" }) as const
      }),
      Effect.either
    )

    const failed = yield* Ref.get(childFailure)
    const mutated = yield* Ref.get(mutationPossible)
    yield* emit({
      _tag: "SubagentEnded",
      id: agentId,
      status: outcome._tag === "Right" && failed === null ? "done" : "error"
    })

    if (outcome._tag === "Left") {
      const failure =
        outcome.left._tag === "StepTimedOut"
          ? classifyProviderFailure(`The attempt timed out after ${STEP_TIMEOUT} without finishing.`)
          : classifyProviderFailure(outcome.left)
      return {
        status: "failed",
        failure,
        mutationPossible: mutated
      }
    }
    if (failed !== null) {
      return {
        status: "failed",
        failure: classifyProviderFailure(failed),
        mutationPossible: mutated
      }
    }
    const verdict = parseStepVerdict((yield* Ref.get(collected)).join("\n"))
    return verdict.status === "done"
      ? { status: "done", mutationPossible: mutated }
      : { ...verdict, mutationPossible: mutated }
  })

/** Keep provenance useful without allowing a transcript to grow without bound. */
export const MAX_ROUTE_ATTEMPT_HISTORY = 16

const sameRoute = (left: RouteCandidate, right: RouteCandidate): boolean =>
  left.cli === right.cli && left.model === right.model

const routeCandidates = (
  step: PlanStep,
  input: StepRunInput
): ReadonlyArray<RouteCandidate> => {
  const routing = step.routing
  // Shadow is observational. Resolve its executable route exactly as a legacy
  // plan would at run time and ignore counterfactual alternatives persisted by
  // older builds; only Active mode may change providers automatically.
  if (routing === undefined || routing.mode === "shadow") {
    const legacy = resolveRunner(step, input.available, input.fallback)
    return legacy === null ? [] : [legacy]
  }
  const selected: RouteCandidate = {
    cli: routing.decision.cli,
    model: routing.decision.model
  }
  return [selected, ...routing.decision.alternatives].filter(
    (candidate, index, all) =>
      all.findIndex((other) => sameRoute(candidate, other)) === index && candidate.cli !== "starbase"
  )
}

const appendAttempt = (step: PlanStep, attempt: RouteAttempt): PlanStep => {
  if (step.routing === undefined) return step
  const attempts = [...step.routing.attempts, attempt].slice(-MAX_ROUTE_ATTEMPT_HISTORY)
  return { ...step, routing: { ...step.routing, attempts } }
}

export class PlanExecutor extends Effect.Service<PlanExecutor>()("@starbase/PlanExecutor", {
  accessors: true,
  effect: Effect.gen(function* () {
    /**
     * Run the plan's steps in dependency order, stopping at the first failure.
     *
     * Stopping is the whole point rather than a limitation. Steps are ordered
     * because their order matters; carrying on past a failed migration to run
     * the backfill that needed it is precisely the defect the adversarial round
     * exists to catch, and it would be perverse for the executor to reintroduce
     * it. The failure names the step, so what to do next is obvious.
     */
    const run = (input: StepRunInput): Stream.Stream<StreamEvent, PlanError, CliAdapter> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const out = yield* Mailbox.make<StreamEvent, PlanError>()
          const emit = (event: StreamEvent) => Effect.asVoid(out.offer(event))
          const { order, skipped } = executionOrder(input.plan)

          const work = Effect.gen(function* () {
            yield* emit({
              _tag: "Started",
              sessionId: input.sessionId,
              model: undefined
            })

            // Say what will NOT be run, before running anything. A branch left
            // for a human is a decision the operator has to make; discovering
            // that only from a diff that is missing work is far worse.
            for (const s of skipped) {
              yield* emit({
                _tag: "Assistant",
                text:
                  s.why === "branch"
                    ? `Skipping step ${s.step.number} (${s.step.title}) — it is a branch, so which arm applies is your call.`
                    : `Skipping step ${s.step.number} (${s.step.title}) — its dependencies can't be satisfied.`,
                agentId: undefined
              })
            }

            const done = yield* Ref.make(0)
            const spend = yield* Ref.make({ costUsd: 0, tokens: 0 })
            // The plan as the operator is currently watching it. `onStepDone`
            // ticks the step on the STORED transcript, which is what survives a
            // crash — but a disk write is invisible to a running renderer, so
            // the Plan tab sat on "proposed" for every step of a live run and
            // only caught up on reload. `PlanUpdated` is the live channel; hold
            // the evolving plan here and publish each transition through it.
            const live = yield* Ref.make(input.plan)
            const publish = (updated: PlanStep) =>
              Ref.updateAndGet(live, (p) => ({
                ...p,
                steps: p.steps.map((step) => (step.id === updated.id ? updated : step))
              })).pipe(Effect.flatMap((plan) => emit({ _tag: "PlanUpdated", plan })))
            const persistStep = (updated: PlanStep) =>
              input.onStepUpdated === undefined
                ? Effect.void
                : input.onStepUpdated(updated).pipe(Effect.ignore)
            const updateStep = (updated: PlanStep) =>
              Effect.all([publish(updated), persistStep(updated)], { discard: true })
            const liveRoutes = new Set(
              input.available
                .filter((candidate) => candidate.cli !== "starbase")
                .map((candidate) => `${candidate.cli}\u0000${candidate.model}`)
            )
            const unavailableRoutes = new Map(
              (input.unavailable ?? []).map((candidate) => [
                `${candidate.cli}\u0000${candidate.model}`,
                candidate.reason
              ])
            )

            for (const step of order) {
              const candidates = routeCandidates(step, input)
              let currentStep: PlanStep = { ...step, status: "current" }
              let candidateIndex = 0
              let attempts = 0
              let previousOutcome: string | null = null
              let settled = false
              let terminalReason: string | null = null
              const unavailableReasons: Array<string> = []

              const record = (attempt: RouteAttempt) => {
                if (currentStep.routing === undefined) return Effect.void
                currentStep = appendAttempt(currentStep, attempt)
                return updateStep(currentStep)
              }

              // Mark it running BEFORE the first attempt, so the operator can
              // see which step a long run is actually on. Retries stay
              // `current` — the tab and the blocker line carry that detail.
              yield* updateStep(currentStep)

              while (attempts < MAX_STEP_ATTEMPTS && !settled) {
                let runner = candidates[candidateIndex]
                while (
                  runner !== undefined &&
                  !liveRoutes.has(`${runner.cli}\u0000${runner.model}`)
                ) {
                  const route = `${runner.cli}/${runner.model}`
                  const reason =
                    unavailableRoutes.get(`${runner.cli}\u0000${runner.model}`) ??
                    "not in the execution-time model catalogue"
                  unavailableReasons.push(`${route}: ${reason}`)
                  const createdAt = yield* Effect.sync(() => new Date().toISOString())
                  yield* record({
                    attempt: null,
                    candidate: runner,
                    outcome: "unavailable",
                    reason,
                    mutationPossible: false,
                    createdAt
                  })
                  yield* emit({
                    _tag: "Assistant",
                    text: `Route ${route} cannot run step ${step.number}: ${reason}. Checking the next candidate.`,
                    agentId: undefined
                  })
                  candidateIndex += 1
                  runner = candidates[candidateIndex]
                }

                if (runner === undefined) {
                  terminalReason =
                    step.routing === undefined
                      ? `No installed harness can run step ${step.number} (${step.title}).`
                      : `No executable route remains for step ${step.number} (${step.title}).${
                          unavailableReasons.length === 0
                            ? ""
                            : ` ${unavailableReasons.join("; ")}`
                        }`
                  break
                }

                attempts += 1
                const outcome: StepAttemptOutcome = yield* runStep(
                  input,
                  currentStep,
                  runner,
                  attempts,
                  previousOutcome,
                  emit,
                  spend
                )
                const createdAt = yield* Effect.sync(() => new Date().toISOString())
                yield* record({
                  attempt: attempts,
                  candidate: runner,
                  outcome: outcome.status,
                  reason:
                    outcome.status === "done"
                      ? null
                      : outcome.status === "blocked"
                        ? outcome.reason
                        : outcome.failure.message,
                  mutationPossible: outcome.mutationPossible,
                  createdAt
                })

                if (outcome.status === "done") {
                  settled = true
                  break
                }

                if (outcome.status === "blocked") {
                  previousOutcome = outcome.reason ?? "It did not say why."
                  yield* emit({
                    _tag: "Assistant",
                    text: `Step ${step.number} (${step.title}) is blocked: ${previousOutcome}${
                      attempts < MAX_STEP_ATTEMPTS ? " Trying again." : ""
                    }`,
                    agentId: undefined
                  })
                  continue
                }

                previousOutcome = outcome.failure.message
                const preservesLegacySemantics =
                  step.routing === undefined || step.routing.mode === "shadow"

                // Shadow must behave exactly like a pre-routing plan. Active
                // mode also keeps bounded same-route recovery for non-operator
                // failures; only changing providers requires proof that no
                // mutation-capable tool started.
                if (preservesLegacySemantics) {
                  if (attempts < MAX_STEP_ATTEMPTS) {
                    yield* emit({
                      _tag: "Assistant",
                      text: `Step ${step.number} (${step.title}) failed: ${previousOutcome} Trying again.`,
                      agentId: undefined
                    })
                    continue
                  }
                  break
                }

                if (outcome.failure.classification === "terminal-operator") {
                  terminalReason =
                    `Step ${step.number} (${step.title}) stopped on ${runner.cli}/${runner.model}: ` +
                    outcome.failure.message
                  break
                }

                if (
                  outcome.failure.classification === "transient-provider" &&
                  !outcome.mutationPossible &&
                  candidateIndex + 1 < candidates.length
                ) {
                  candidateIndex += 1
                  const next = candidates[candidateIndex]!
                  yield* emit({
                    _tag: "Assistant",
                    text:
                      `Step ${step.number} provider failure on ${runner.cli}/${runner.model}: ` +
                      `${outcome.failure.message} Falling back to ${next.cli}/${next.model}.`,
                    agentId: undefined
                  })
                  continue
                }

                if (attempts < MAX_STEP_ATTEMPTS) {
                  const fallbackNote = outcome.mutationPossible
                    ? " The worktree may have changed, so retrying the same route instead of falling back."
                    : " Retrying the same route."
                  yield* emit({
                    _tag: "Assistant",
                    text:
                      `Step ${step.number} (${step.title}) failed on ${runner.cli}/${runner.model}: ` +
                      `${previousOutcome}${fallbackNote}`,
                    agentId: undefined
                  })
                  continue
                }
                break
              }

              if (!settled) {
                return yield* Effect.fail(
                  new PlanError({
                    message: terminalReason ??
                      `Stuck on step ${step.number} (${step.title}) after ${MAX_STEP_ATTEMPTS} attempts. ` +
                        `Last blocker: ${previousOutcome ?? "unknown"}`
                  })
                )
              }

              currentStep = { ...currentStep, status: "done" }
              yield* publish(currentStep)
              if (input.onStepDone !== undefined) {
                yield* input.onStepDone(currentStep).pipe(Effect.ignore)
              }
              yield* Ref.update(done, (n) => n + 1)
            }

            const count = yield* Ref.get(done)
            const total = yield* Ref.get(spend)
            yield* emit({
              _tag: "Assistant",
              text: `Ran ${count} of ${order.length} step${order.length === 1 ? "" : "s"}.`,
              agentId: undefined
            })
            // The run's real spend, summed from the steps rather than asserted
            // as zero.
            yield* emit({
              _tag: "Done",
              costUsd: total.costUsd,
              tokens: total.tokens
            })
          })

          yield* Effect.forkScoped(
            work.pipe(
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
}) {}
