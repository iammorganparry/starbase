import type { CliKind } from "./domain.js"
import type { Plan, PlanStep, PlanStepAssignee } from "./conversation.js"

/**
 * Working out what to run, in what order, and on which harness.
 *
 * Kept pure and separate from the runner because this is where the errors that
 * matter live. A plan is written by a model, so it can name a dependency that
 * doesn't exist, depend on itself, or form a cycle — and an executor that walks
 * such a plan naively either hangs or silently drops work. None of that needs a
 * process to test.
 */

/** Why a step was left out of the run, in words the operator can act on. */
export type SkipReason =
  /** A conditional: which arm applies is a judgement nobody has made yet. */
  | "branch"
  /** Its dependencies can never be satisfied — a cycle, or a missing step. */
  | "unreachable"

export interface SkippedStep {
  readonly step: PlanStep
  readonly why: SkipReason
}

export interface ExecutionPlan {
  /** Steps to run, in the order they must happen. */
  readonly order: ReadonlyArray<PlanStep>
  /** Steps deliberately not run, each with a reason. Never silently dropped. */
  readonly skipped: ReadonlyArray<SkippedStep>
}

/**
 * Order the runnable steps, honouring `dependsOn`.
 *
 * A stable topological sort: ties break on the plan's own order, so a plan with
 * no dependencies at all runs exactly top to bottom — which is what its author
 * and its reviewer both saw on screen. Reordering equivalent work would make the
 * run diverge from the reviewed artifact for no benefit.
 *
 * Two classes of step never run automatically:
 *
 *  - **Branches and their arms.** Which arm applies depends on something only
 *    the run itself reveals, and executing every arm of a conditional is not a
 *    conservative approximation of executing the right one — it is actively
 *    wrong. They are surfaced for a human instead.
 *  - **Steps whose dependencies cannot be satisfied** — a cycle, a self
 *    reference, or a dependency on a step that doesn't exist. Running them in
 *    plan order anyway would violate the one ordering constraint the adversary
 *    was there to check.
 *
 * Dependencies are matched on `number` (what the plan format writes, e.g.
 * `depends: 01`) and on `id`, because both appear in practice.
 */
export const executionOrder = (plan: Plan): ExecutionPlan => {
  const steps = plan.steps
  const runnable = steps.filter((s) => s.kind === "step")
  const branches = steps
    .filter((s) => s.kind !== "step")
    .map((step): SkippedStep => ({ step, why: "branch" }))

  // A step is addressable by either handle, so a dependency written as "01"
  // resolves to the same node as one written as its id.
  const byHandle = new Map<string, PlanStep>()
  for (const s of runnable) {
    byHandle.set(s.id, s)
    byHandle.set(s.number, s)
  }

  /** Dependencies that name a real runnable step. Others are handled below. */
  const depsOf = (s: PlanStep): ReadonlyArray<PlanStep> => {
    const out: PlanStep[] = []
    for (const raw of s.dependsOn) {
      const dep = byHandle.get(raw.trim())
      // Self-dependency is a cycle of one; excluding it here would quietly
      // "fix" a plan the operator should be told about, so it falls through to
      // the unreachable set below.
      if (dep !== undefined && dep.id !== s.id) out.push(dep)
    }
    return out
  }

  /** A dependency naming something that isn't a runnable step at all. */
  const hasDanglingDep = (s: PlanStep): boolean =>
    s.dependsOn.some((raw) => {
      const handle = raw.trim()
      if (handle.length === 0) return false
      const dep = byHandle.get(handle)
      return dep === undefined || dep.id === s.id
    })

  const order: PlanStep[] = []
  const placed = new Set<string>()
  const blocked = new Set<string>()

  for (const s of runnable) {
    if (hasDanglingDep(s)) blocked.add(s.id)
  }

  // Kahn's algorithm, but scanning in plan order each pass so the result is
  // stable rather than dependent on map iteration.
  let progressed = true
  while (progressed) {
    progressed = false
    for (const s of runnable) {
      if (placed.has(s.id) || blocked.has(s.id)) continue
      const deps = depsOf(s)
      // Work queued behind a blocked step needs no special case: a blocked step
      // is never placed, so nothing depending on it can ever satisfy this, and
      // it falls through to `unreachable` below. Verified by test — an explicit
      // propagation pass here changed no outcome, so it was removed.
      if (deps.every((d) => placed.has(d.id))) {
        order.push(s)
        placed.add(s.id)
        progressed = true
      }
    }
  }

  // Anything still unplaced is in a cycle. It cannot be ordered, so it cannot
  // be run — reported rather than dropped.
  const unreachable = runnable
    .filter((s) => !placed.has(s.id))
    .map((step): SkippedStep => ({ step, why: "unreachable" }))

  return { order, skipped: [...branches, ...unreachable] }
}

/**
 * Which harness and model should run a step.
 *
 * `null` means "nothing here can run it", which the caller must treat as a
 * failure rather than a reason to guess: silently running a step on a harness
 * the plan didn't choose discards the one decision the round existed to make.
 *
 * Two exclusions are absolute:
 *
 *  - **`starbase`.** A step routed back to the orchestrator would re-enter
 *    planning to execute one step of the plan it just produced.
 *  - **A harness that isn't available here.** A plan can be reviewed on one
 *    machine and run on another, and the assignee is only a recommendation —
 *    it cannot conjure an install.
 */
export const resolveRunner = (
  step: PlanStep,
  available: ReadonlyArray<{ readonly cli: CliKind; readonly model: string }>,
  fallback: { readonly cli: CliKind; readonly model: string } | null
): { readonly cli: CliKind; readonly model: string } | null => {
  const usable = available.filter((a) => a.cli !== "starbase")
  const assignee: PlanStepAssignee | undefined = step.assignee
  if (assignee !== undefined && assignee.cli !== "starbase") {
    const exact = usable.find((a) => a.cli === assignee.cli)
    // Honour the harness even when the exact model isn't in the catalogue: the
    // lab is the substantive half of the choice, and a stale model id is a far
    // smaller divergence than running on a different vendor entirely.
    if (exact !== undefined) return { cli: assignee.cli, model: assignee.model }
  }
  // The fallback must clear the SAME bar as an assignee: installed here. It
  // used to be returned on the `starbase` check alone, so on a Codex-only host
  // the default orchestrator (claude/opus) was handed to steps that had no
  // assignee — the harness isn't there, the step burns all three attempts, and
  // the run dies with "stuck after 3 attempts" instead of the accurate "no
  // installed harness can run this step" that this function exists to produce.
  if (
    fallback !== null &&
    fallback.cli !== "starbase" &&
    usable.some((a) => a.cli === fallback.cli)
  ) {
    return fallback
  }
  return usable[0] ?? null
}
