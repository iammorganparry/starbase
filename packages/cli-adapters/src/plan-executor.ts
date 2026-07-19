import type { CliKind, Plan, PlanStep, StreamEvent } from "@starbase/core"
import { executionOrder, PlanError, resolveRunner } from "@starbase/core"
import { Effect, Mailbox, Ref, Schema, Stream } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, isChildLifecycle, PlanDecision } from "./adapter.js"
import { unattendedAnswers } from "./adversarial-plan.js"
import { stepPrompt } from "./plan-executor-prompt.js"
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
  /** Harness+model pairs this host can actually run. */
  readonly available: ReadonlyArray<{ readonly cli: CliKind; readonly model: string }>
  /** Used when a step names no assignee, or names one that isn't installed. */
  readonly fallback: { readonly cli: CliKind; readonly model: string } | null
  readonly binPathFor: (cli: CliKind) => string | null
  /** Called as each step finishes, so progress survives a crash mid-run. */
  readonly onStepDone?: (step: PlanStep) => Effect.Effect<void>
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
  return { status: "blocked", reason: reason && reason.length > 0 ? reason : null }
}

const scopeTo = (event: StreamEvent, agentId: string): StreamEvent =>
  "agentId" in event && event.agentId === undefined ? { ...event, agentId } : event

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
  emit: (event: StreamEvent) => Effect.Effect<void>
): Effect.Effect<StepVerdict, PlanError, CliAdapter> =>
  Effect.gen(function* () {
    const adapter = yield* CliAdapter
    const collected = yield* Ref.make<ReadonlyArray<string>>([])
    // Retries share the step's tab, but need distinct adapter session ids or the
    // resume map would hand attempt 2 attempt 1's context — which is exactly the
    // context we are trying to replace with a corrected brief.
    const agentId = stepAgentId(step)

    const spec: SessionSpec = {
      cli: runner.cli,
      repo: input.repo,
      branch: input.branch,
      cwd: input.cwd,
      prompt: stepPrompt({ plan: input.plan, step, previousBlocker }),
      images: [],
      binPath: input.binPathFor(runner.cli),
      mode: "accept-edits",
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
          // A step's own `Started`/`Done`/`Failed` never reaches the parent —
          // see `isChildLifecycle`. Forwarding them ends the whole run at the
          // first step that succeeds.
          isChildLifecycle(event) ? Effect.void : emit(scopeTo(event, agentId)),
          event._tag === "Assistant" && event.agentId === undefined
            ? Ref.update(collected, (acc) => [...acc, event.text])
            : Effect.void
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

    const outcome = yield* adapter
      .run(`${agentId}_${input.sessionId}_a${attempt}`, spec, ctx)
      .pipe(
        Effect.timeoutFail({
          duration: STEP_TIMEOUT,
          onTimeout: () => ({ _tag: "StepTimedOut" }) as const
        }),
        Effect.either
      )

    yield* emit({
      _tag: "SubagentEnded",
      id: agentId,
      status: outcome._tag === "Right" ? "done" : "error"
    })

    // A crashed or stalled attempt is reported as a BLOCKER rather than a
    // failure, so the loop can try again. Only exhausting the attempts stops
    // the run — the whole point is to carry the plan to completion unattended.
    if (outcome._tag === "Left") {
      return {
        status: "blocked",
        reason:
          outcome.left._tag === "StepTimedOut"
            ? `The attempt ran past ${STEP_TIMEOUT} without finishing.`
            : "The harness failed to run."
      } as const
    }
    const verdict = parseStepVerdict((yield* Ref.get(collected)).join("\n"))
    if (verdict.status === "done" && input.onStepDone) {
      yield* input.onStepDone(step).pipe(Effect.ignore)
    }
    return verdict
  })

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
            yield* emit({ _tag: "Started", sessionId: input.sessionId, model: undefined })

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
            for (const step of order) {
              const runner = resolveRunner(step, input.available, input.fallback)
              if (runner === null) {
                return yield* Effect.fail(
                  new PlanError({
                    message: `No installed harness can run step ${step.number} (${step.title}).`
                  })
                )
              }

              // Iterate this step until it reports done or runs out of attempts.
              // A retry is given the previous blocker verbatim, because most
              // first failures are a missing detail the agent can work around
              // once it knows what stopped it.
              let blocker: string | null = null
              let settled = false
              for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
                const verdict: StepVerdict = yield* runStep(input, step, runner, attempt, blocker, emit)
                if (verdict.status === "done") {
                  settled = true
                  break
                }
                blocker = verdict.reason ?? "It did not say why."
                yield* emit({
                  _tag: "Assistant",
                  text: `Step ${step.number} (${step.title}) is blocked: ${blocker}${
                    attempt < MAX_STEP_ATTEMPTS ? " Trying again." : ""
                  }`,
                  agentId: undefined
                })
              }

              // Out of attempts. This is the ONE thing that stops an approved
              // plan, and it is deliberately the only one: an agent that has
              // failed three times with three explanations is not one attempt
              // from success. Stopping here — rather than pressing on into
              // steps that depended on this one — is what makes the run safe to
              // leave alone.
              if (!settled) {
                return yield* Effect.fail(
                  new PlanError({
                    message:
                      `Stuck on step ${step.number} (${step.title}) after ${MAX_STEP_ATTEMPTS} attempts. ` +
                      `Last blocker: ${blocker ?? "unknown"}`
                  })
                )
              }
              yield* Ref.update(done, (n) => n + 1)
            }

            const count = yield* Ref.get(done)
            yield* emit({
              _tag: "Assistant",
              text: `Ran ${count} of ${order.length} step${order.length === 1 ? "" : "s"}.`,
              agentId: undefined
            })
            yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
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
