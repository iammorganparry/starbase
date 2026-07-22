import type {
  ApprovalGate,
  Attachment,
  ExecutionMode,
  GateDecision,
  Message,
  PermissionMode,
  Plan,
  PlanComment,
  QuestionAnswer,
  QuestionRequest,
  Session,
  StreamEvent
} from "@starbase/core"
import {
  ADHD_MODE_DEFAULT,
  applyStreamEvent,
  assistantMessage,
  CliExecError,
  defaultModel,
  findApprovedPlan,
  isBackgroundTaskEvent,
  isSubagentEvent,
  PLAN_AUTO_RUN_DEFAULT,
  resumePlanPrompt,
  setQuestionAnswers,
  STOPPED_NOTE,
  userMessage,
  resolveOrchestrator
} from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Cause, Deferred, Effect, Fiber, Mailbox, Option, Ref, Stream } from "effect"
import { adhdNote } from "./adhd-prompt.js"
import { planNote } from "./plan-prompt.js"
import { questionNote } from "./question-prompt.js"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import type { PermissionDecision, PermissionRequest, SessionSpec, StopBackgroundTask } from "./adapter.js"
import { ContextManager } from "./context-manager.js"
import { renderPrimer, tailAfter } from "./context-digest.js"
import { readDefaultMode } from "./default-mode.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { PlanStore } from "./plan-store.js"

/** Tools that write to disk — a successful one advances the matching plan step. */
const EDIT_TOOLS = new Set(["Write", "Edit", "Update", "MultiEdit", "NotebookEdit"])

/**
 * How long `stop` waits for an interrupted run to finish unwinding before it
 * gives up the session lock.
 *
 * Not a deadline on the interrupt — that is already delivered — only on our
 * WAIT for it. The Claude adapter grants itself 15s to tear a child down, and a
 * stop that held the lock for all of it would leave the operator's next message
 * sitting unanswered for fifteen seconds, which is the very symptom this whole
 * change exists to remove. Five seconds covers an ordinary teardown; past that
 * we would rather overlap than stall.
 */
const INTERRUPT_GRACE = "5 seconds"

/**
 * How long a turn may produce NOTHING before we declare the harness wedged.
 *
 * Nothing else in the stack bounds this. `AgentRunner.prompt` has no timeout,
 * `Effect.ensuring(out.end)` only runs once `adapter.run` returns, and the
 * Claude adapter's `for await` over the SDK stream is unbounded — so a child
 * that hangs before its `system/init` line is invisible everywhere, and the
 * turn's placeholder message stays empty with `streaming: true` forever. That
 * is the spinning-eyebrow-with-no-reply bug; 32 of 946 assistant turns in
 * ~/starbase/transcripts are stuck in exactly that state.
 *
 * Generous on purpose. This is the wait for the FIRST event, not for the
 * answer: harness startup, MCP server boot and a cold resume all land well
 * inside two minutes, and a false trip costs the operator real work.
 */
const FIRST_EVENT_DEADLINE = "120 seconds"

/**
 * A concise context note prepended to a run when the session's worktree has saved
 * plan(s). It does two jobs: (1) anchor the agent to its worktree, and (2) hand it
 * the plan file path(s).
 *
 * (1) matters because the plan library lives OUTSIDE the worktree
 * (`~/starbase/.starbase/…`): without being told its working directory, an agent
 * that reads the plan file can mistake the plan's parent for the project root and
 * `cd` out of its worktree (even into the origin checkout) — corrupting the wrong
 * tree. So we state the worktree path explicitly and forbid treating the plan's
 * location as the repo. Phrased so the agent only acts on the plan when the turn
 * is actually about it.
 */
const planPointerNote = (worktreePath: string, planFiles: ReadonlyArray<string>): string =>
  [
    "<session-context>",
    `Working directory (this session's git worktree — the project root): ${worktreePath}`,
    "Do ALL work here: every file read/edit and shell command runs in this directory. Do NOT `cd` out of it, and never treat any other directory as the project — in particular, the plan file below lives OUTSIDE the project, so its parent directory is NOT the repo.",
    "",
    "Saved plan for this session (a read-only reference document, not part of the project):",
    ...planFiles.map((f) => `  - ${f}`),
    "If this message asks you to implement, continue, or pick up the plan, read that file to recall the full plan, then do the work in the working directory above. Otherwise ignore this note.",
    "</session-context>"
  ].join("\n")

/**
 * Does this turn open with a slash command (`/babysit-pr …`)?
 *
 * Harnesses only expand a command when it leads the message, so anything we
 * prepend silently demotes it to prose. Deliberately narrow: a bare `/` or a
 * path like `/Users/...` is not a command.
 */
export const isSlashCommand = (text: string): boolean => /^\/[A-Za-z][\w:-]*(\s|$)/.test(text.trimStart())

/** A gate awaiting the operator; the `Deferred` unblocks the paused agent. */
interface PendingGate {
  readonly sessionId: string
  readonly deferred: Deferred.Deferred<PermissionDecision>
  /** Token added to the session allowlist on an "always" decision. */
  readonly allowLabel: string | null
}

/** A question group awaiting the user's answers; the `Deferred` resumes the agent. */
interface PendingQuestion {
  readonly sessionId: string
  readonly deferred: Deferred.Deferred<ReadonlyArray<QuestionAnswer>>
}

/** A proposed plan awaiting the operator's decision; the `Deferred` resumes the agent. */
interface PendingPlan {
  readonly sessionId: string
  readonly deferred: Deferred.Deferred<PlanDecision>
}

/** An opaque per-run identity — object identity is the whole point. */
type RunToken = Record<never, never>

/** A session's in-flight run: the fiber to interrupt, and which run owns the slot. */
interface RunFiber {
  readonly fiber: Fiber.RuntimeFiber<void, never>
  readonly token: RunToken
}

/**
 * Live handles onto the in-flight run for a session, so the out-of-band plan RPCs
 * (comment / revise / approve) can read + mutate the plan part in the current
 * assistant turn — updating both the live accumulator and the persisted
 * transcript, and pushing a `PlanUpdated` so an attached renderer stays in sync.
 */
interface ActiveRun {
  readonly readPlan: (planId: string) => Effect.Effect<Plan | null>
  readonly applyPlan: (planId: string, f: (plan: Plan) => Plan) => Effect.Effect<void>
}

/** Windows separators → POSIX, so path comparison has one shape to reason about. */
const normalizePath = (p: string): string => p.replace(/\\/g, "/")

/**
 * Do two paths name the same file? One side is typically an absolute worktree
 * path (the tool's edit target), the other a repo-relative path (a plan step's
 * declared `files:`), so a suffix match is right — but ONLY anchored at a
 * separator. An unanchored `endsWith` makes "a.ts" match "src/schema.ts" and
 * ticks a step that had nothing to do with the edit.
 */
const samePath = (a: string, b: string): boolean =>
  a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)

const findPlan = (msg: Message, planId: string): Plan | null => {
  for (const p of msg.parts) if (p._tag === "Plan" && p.plan.id === planId) return p.plan
  return null
}

/** Bundle the operator's un-routed step comments into a plain revision instruction. */
const revisionText = (plan: Plan, comments: ReadonlyArray<PlanComment>): string => {
  const lines = [
    "I've reviewed the plan. Please revise it to address these comments, then call ExitPlanMode again with the updated plan:"
  ]
  for (const c of comments) {
    const step = plan.steps.find((s) => s.id === c.stepId)
    const where = step ? `Step ${step.number} (${step.title})` : "General"
    lines.push(`- ${where}: ${c.body}`)
  }
  return lines.join("\n")
}

/** The first two words of a command — the "Always allow …" token, e.g. "npm test". */
const allowLabelOf = (command: string): string => command.trim().split(/\s+/).slice(0, 2).join(" ")

const isAllowlisted = (allow: ReadonlySet<string>, command: string | null): boolean =>
  command !== null && [...allow].some((a) => command === a || command.startsWith(`${a} `))

const basename = (target: string | null): string => target?.split("/").pop() ?? "file"

/**
 * Decide whether a requested action runs (`"allow"`) or must pause for the
 * operator (`"gate"`), from the session's HITL mode + allowlist:
 * - `auto` — everything runs,
 * - `accept-edits` — edits run, commands gate (unless allowlisted),
 * - `ask` — edits and commands both gate (unless a command is allowlisted).
 */
const verdict = (
  mode: PermissionMode,
  allow: ReadonlySet<string>,
  req: PermissionRequest,
  planAutoRun: boolean = PLAN_AUTO_RUN_DEFAULT
): "allow" | "gate" => {
  if (mode === "auto") return "allow"
  if (isAllowlisted(allow, req.command)) return "allow"
  // Planning is a read-only phase: the harness refuses edits outright, so the
  // only thing left to approve is a command that cannot change the tree. Running
  // those unattended is the default; the operator can restore the prompts from
  // Settings. Edits are NOT covered — they fall through to the rule below and
  // gate exactly as they always did.
  if (mode === "plan" && planAutoRun && req.kind === "command") return "allow"
  if (req.kind === "edit") return mode === "accept-edits" ? "allow" : "gate"
  return "gate"
}

const buildGate = (id: string, req: PermissionRequest): ApprovalGate =>
  req.kind === "command"
    ? {
        id,
        kind: "command",
        title: "Approval needed · run a command",
        detail:
          "Not in your allowlist. Agents never run shell commands until you allow — any file edits above were applied under this mode.",
        command: req.command,
        allowLabel: req.command ? allowLabelOf(req.command) : null,
        status: "pending"
      }
    : {
        id,
        kind: "edit",
        title: `Approval needed · edit ${basename(req.target)}`,
        detail: "Review the change above, then approve to write it to disk.",
        command: null,
        allowLabel: null,
        status: "pending"
      }

type PromptEnv =
  | CliAdapter
  | ConfigService
  | SessionStore
  | TranscriptStore
  | BackgroundTaskStore
  | PlanStore
  | DiscoveryService
  | ContextManager
  | ConfigService
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

/**
 * Orchestrates a prompt against the selected harness. `prompt` returns a
 * `Stream<StreamEvent>` — the harness-agnostic seam the renderer subscribes to —
 * while, in-band, it applies the session's HITL mode, pauses on gates, folds each
 * event into the persisted transcript, and re-emits it. Gate/mode state lives in
 * this singleton service so `decideGate`/`setMode` (separate RPCs) can reach the
 * paused run.
 */
export class AgentRunner extends Effect.Service<AgentRunner>()("@starbase/AgentRunner", {
  effect: Effect.gen(function* () {
    // gateId → the pending gate (shared across prompt/decideGate/stop calls).
    const gates = yield* Ref.make(new Map<string, PendingGate>())
    // requestId → the pending question group (shared across prompt/answerQuestion/stop).
    const questions = yield* Ref.make(new Map<string, PendingQuestion>())
    // Per-session live HITL state, seeded from the Session record on first use.
    const modes = yield* Ref.make(new Map<string, PermissionMode>())
    const allowlists = yield* Ref.make(new Map<string, Set<string>>())
    // planId → the pending plan (shared across prompt/approve/revise/stop).
    const plans = yield* Ref.make(new Map<string, PendingPlan>())
    // sessionId → the exec mode to restore when a plan is approved (captured on
    // the switch into "plan").
    const priorModes = yield* Ref.make(new Map<string, PermissionMode>())
    // sessionId → the user's default exec mode (read from their claude/codex
    // config at run start). Used as the restore fallback when there's no prior
    // exec mode to fall back to — so approving a plan lands in the mode they
    // normally run in, not a hardcoded guess.
    const execDefaults = yield* Ref.make(new Map<string, PermissionMode>())
    // sessionId → live handles onto the current run, for the out-of-band plan RPCs.
    const active = yield* Ref.make(new Map<string, ActiveRun>())
    // sessionId → the fiber running the agent, so `stop` can interrupt it.
    // Interruption is the ONLY thing that reaches the underlying process: the
    // real adapter aborts its CLI in an `onInterrupt` finalizer. Nothing else
    // gets there — `CliAdapter.stop` is a no-op in every implementation, and a
    // client hanging up its stream does NOT tear the run down (verified: the run
    // survives its consumer). Without this handle a "stopped" agent keeps running.
    const fibers = yield* Ref.make(new Map<string, RunFiber>())
    // sessionId → a mutex serialising `stop` against `prompt`'s SETUP.
    //
    // Without it, a stop and the next turn race for the same `fibers` slot, and
    // the stop loses: the renderer fires `agentStop` and moves on, `prompt`
    // forks and registers run B over run A's entry, and only THEN does the
    // stop's `Ref.get` schedule — handing it run B's fiber to kill. The operator
    // sees their fresh message answered with a bare "Stopped." and re-sends.
    // (64 of 946 assistant turns in ~/starbase/transcripts are exactly that.)
    //
    // A token check alone cannot fix it: by the time the stop reads the map, the
    // only entry that ever existed for that read IS run B's. The read and the
    // registration have to be ordered, which is what this lock does.
    const locks = yield* Ref.make(new Map<string, Effect.Semaphore>())
    /** The session's mutex, created on first use. */
    const sessionLock = (sessionId: string) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(locks)).get(sessionId)
        if (existing !== undefined) return existing
        const made = yield* Effect.makeSemaphore(1)
        // `Ref.modify` is atomic, so two concurrent first-users agree on one
        // semaphore — the loser's freshly made one is simply dropped.
        return yield* Ref.modify(locks, (m) => {
          const current = m.get(sessionId)
          return current !== undefined ? [current, m] : [made, new Map(m).set(sessionId, made)]
        })
      })
    // Monotonic id source — deterministic (no Date.now/random) for stable tests.
    const counter = yield* Ref.make(0)
    const nextId = Ref.updateAndGet(counter, (n) => n + 1)

    const persistMode = (sessionId: string, mode: PermissionMode) =>
      SessionStore.setMode(sessionId, mode).pipe(Effect.ignore)

    const setMode = (sessionId: string, mode: PermissionMode) =>
      Effect.gen(function* () {
        // Entering plan mode: remember the exec mode to fall back to on approval.
        if (mode === "plan") {
          const current =
            (yield* Ref.get(modes)).get(sessionId) ??
            (yield* SessionStore.get(sessionId).pipe(
              Effect.map((s) => s.mode),
              Effect.orElseSucceed(() => undefined)
            ))
          const configDefault = (yield* Ref.get(execDefaults)).get(sessionId) ?? "accept-edits"
          const prior: PermissionMode = current && current !== "plan" ? current : configDefault
          yield* Ref.update(priorModes, (m) => new Map(m).set(sessionId, prior))
        }
        yield* Ref.update(modes, (m) => new Map(m).set(sessionId, mode))
        // Plan mode is TRANSIENT — never persist it to the session. If we did, a
        // restart (or any run with an empty in-memory `modes`) would resurrect
        // plan mode from `session.mode` with no `priorModes` captured, so
        // approving the plan would fall back to "accept-edits" and re-gate every
        // command. Keeping the real exec mode persisted means `session.mode` is
        // always the mode to restore on approval.
        if (mode !== "plan") yield* persistMode(sessionId, mode)
      })

    const decideGate = (sessionId: string, gateId: string, decision: GateDecision) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(gates)).get(gateId)
        if (entry === undefined || entry.sessionId !== sessionId) return
        if (decision === "always" && entry.allowLabel !== null) {
          const label = entry.allowLabel
          yield* Ref.update(allowlists, (m) => {
            const next = new Map(m)
            const set = new Set(next.get(sessionId) ?? [])
            set.add(label)
            next.set(sessionId, set)
            return next
          })
          yield* SessionStore.addAllowlist(sessionId, label).pipe(Effect.ignore)
        }
        yield* Deferred.succeed(entry.deferred, decision === "deny" ? "deny" : "allow")
      })

    /** Submit the user's answers to a pending question group, resuming the agent. */
    const answerQuestion = (
      sessionId: string,
      requestId: string,
      answers: ReadonlyArray<QuestionAnswer>
    ) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(questions)).get(requestId)
        if (entry === undefined || entry.sessionId !== sessionId) return
        // The answers are recorded onto the transcript inside `askQuestion` (which
        // owns the run's message accumulator); here we just resume the agent.
        yield* Deferred.succeed(entry.deferred, answers)
      })

    /** Resolve a session's pending plan `Deferred` (guards session ownership). */
    const resolvePlan = (sessionId: string, planId: string, decision: PlanDecision) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(plans)).get(planId)
        if (entry === undefined || entry.sessionId !== sessionId) return
        yield* Deferred.succeed(entry.deferred, decision)
      })

    /** Thread a comment onto a plan step (persisted + streamed); doesn't resume the agent. */
    const commentPlanStep = (sessionId: string, planId: string, stepId: string, body: string) =>
      Effect.gen(function* () {
        const run = (yield* Ref.get(active)).get(sessionId)
        if (run === undefined) return
        const cn = yield* nextId
        const now = yield* Effect.sync(() => new Date().toISOString())
        const comment: PlanComment = { id: `pc_${sessionId}_${cn}`, stepId, body, author: "user", createdAt: now, routed: false }
        yield* run.applyPlan(planId, (plan) => ({
          ...plan,
          comments: [...plan.comments, comment],
          steps: plan.steps.map((s) => (s.id === stepId ? { ...s, flagged: true } : s))
        }))
      })

    /** Route the open comments back to the agent as a revision and resume planning. */
    const revisePlan = (sessionId: string, planId: string) =>
      Effect.gen(function* () {
        const run = (yield* Ref.get(active)).get(sessionId)
        if (run === undefined) return
        const plan = yield* run.readPlan(planId)
        if (plan === null) return
        const open = plan.comments.filter((c) => !c.routed && c.author === "user")
        // Mark the plan under revision + flush its comments as routed.
        yield* run.applyPlan(planId, (p) => ({
          ...p,
          status: "revising",
          comments: p.comments.map((c) => (c.routed ? c : { ...c, routed: true }))
        }))
        yield* resolvePlan(sessionId, planId, PlanDecision.Revise({ feedback: revisionText(plan, open) }))
      })

    /** Approve a plan: mark it approved, restore the exec mode, and start execution. */
    const approvePlan = (sessionId: string, planId: string, executionMode?: ExecutionMode) =>
      Effect.gen(function* () {
        const run = (yield* Ref.get(active)).get(sessionId)
        if (run !== undefined) yield* run.applyPlan(planId, (p) => ({ ...p, status: "approved" }))
        // Engage the mode they were actually running this session in before
        // planning (`priorModes`, e.g. "auto") — that's their real intent for this
        // session. Fall back to their CLI-config default only when there's no prior
        // (e.g. a session started directly in plan mode), then a safe default.
        // NOTE: `priorModes` MUST win over `execDefaults` — the latter is derived
        // from the harness config file and is "accept-edits" for anyone who hasn't
        // set a config default, which would silently override the "auto" (or other
        // mode) the operator picked in the composer, re-gating every command.
        const mode =
          executionMode ??
          (yield* Ref.get(priorModes)).get(sessionId) ??
          (yield* Ref.get(execDefaults)).get(sessionId) ??
          "accept-edits"
        // Restore the exec mode live (canUseTool re-reads it) and persist it.
        yield* setMode(sessionId, mode)
        yield* resolvePlan(sessionId, planId, PlanDecision.Approve({ mode }))
      })

    /**
     * The user's configured default execution mode for a session (`auto` /
     * `accept-edits` / `ask`), read from their CLI config. `AppPaths.root` is
     * `~/starbase`, so its parent is $HOME. Never fails.
     */
    const resolveExecMode = (sessionId: string): Effect.Effect<PermissionMode, never, PromptEnv> =>
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId).pipe(
          Effect.map((s): Session | null => s),
          Effect.orElseSucceed(() => null)
        )
        const pathSvc = yield* Path.Path
        const appPaths = yield* AppPaths
        return yield* readDefaultMode(session?.cli ?? "claude", pathSvc.dirname(appPaths.root))
      })

    /** The plan with `planId` from a session's persisted transcript, or null. */
    const sessionPlan = (sessionId: string, planId: string): Effect.Effect<Plan | null, never, PromptEnv> =>
      TranscriptStore.list(sessionId).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<Message>),
        Effect.map((messages) => messages.reduce<Plan | null>((found, m) => findPlan(m, planId) ?? found, null))
      )

    /**
     * Approve a plan whose original run is gone (e.g. after an app restart, when
     * the plan is "stale"): there's no parked Deferred to resume, so re-drive
     * execution as a FRESH run. Set the session's default exec mode, then prompt
     * the agent with the plan embedded (the harness has no memory of the prior
     * planning conversation across a restart). Returns the run's event stream.
     */
    const resumePlan = (sessionId: string, planId: string): Stream.Stream<StreamEvent, never, PromptEnv> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const plan = yield* sessionPlan(sessionId, planId)
          if (plan === null) return Stream.empty
          // Restore the mode the operator actually runs this session in. Plan mode
          // is never persisted, so `session.mode` is their real exec mode (e.g.
          // "auto"); fall back to the CLI-config default only if it's absent or a
          // legacy "plan". This keeps a stale-plan re-drive from re-gating.
          const persisted = yield* SessionStore.get(sessionId).pipe(
            Effect.map((s) => s.mode),
            Effect.orElseSucceed(() => undefined)
          )
          const restore =
            persisted && persisted !== "plan" ? persisted : yield* resolveExecMode(sessionId)
          yield* setMode(sessionId, restore)
          return prompt(sessionId, resumePlanPrompt(plan))
        })
      )

    /**
     * Halt a session's agent: settle whatever it's blocked on, then interrupt the
     * run itself.
     *
     * Both halves are load-bearing. Denying the pending gate/question/plan lets
     * the paused agent-side code resume and clean up its own bookkeeping (and
     * records the denial/rejection in the transcript, which the operator should
     * see). Interrupting then kills the run for real — including the common case
     * where the agent is mid-stream and blocked on nothing, where denial alone
     * would be a no-op and the agent would just carry on.
     *
     * Deny-then-interrupt, in that order: the reverse would strand the pending
     * entries, since the code that clears them sits after the `Deferred.await`
     * we'd have just killed.
     */
    const stop = (sessionId: string) =>
      Effect.gen(function* () {
        const allGates = yield* Ref.get(gates)
        yield* Effect.forEach(
          [...allGates.values()].filter((g) => g.sessionId === sessionId),
          (g) => Deferred.succeed(g.deferred, "deny"),
          { discard: true }
        )
        const allQuestions = yield* Ref.get(questions)
        yield* Effect.forEach(
          [...allQuestions.values()].filter((q) => q.sessionId === sessionId),
          (q) => Deferred.succeed(q.deferred, []),
          { discard: true }
        )
        const allPlans = yield* Ref.get(plans)
        const run = (yield* Ref.get(active)).get(sessionId)
        yield* Effect.forEach(
          [...allPlans.entries()].filter(([, p]) => p.sessionId === sessionId),
          ([planId, p]) =>
            (run ? run.applyPlan(planId, (pl) => ({ ...pl, status: "rejected" })) : Effect.void).pipe(
              Effect.zipRight(Deferred.succeed(p.deferred, PlanDecision.Reject()))
            ),
          { discard: true }
        )
        // Now kill the run. `Fiber.interrupt` awaits the finalizers, so once this
        // returns the agent is genuinely stopped — not merely asked to stop.
        //
        // Read and interrupt under the session lock. `prompt` holds the SAME lock
        // across its whole setup — session load, the compaction swap, appending
        // the placeholder turns, and the fork+register — so the entry we read
        // here can only ever be a run that already existed when this stop began.
        // A turn the operator sends next queues behind us instead of being
        // silently killed by our interrupt.
        //
        // The token re-check is belt-and-braces for the one case the lock cannot
        // cover: a run that finishes and deregisters itself between our two
        // reads. Interrupting a fiber that already left the slot is harmless, but
        // comparing tokens says plainly which run we meant.
        //
        // The interrupt is time-capped. `Fiber.interrupt` waits for finalizers,
        // and the Claude adapter allows itself TEARDOWN_GRACE (15s) to unwind —
        // long enough that holding the lock for all of it would read as the app
        // ignoring the operator's next message. After the cap we stop WAITING;
        // the interrupt itself has already been delivered.
        const lock = yield* sessionLock(sessionId)
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const running = (yield* Ref.get(fibers)).get(sessionId)
            if (running === undefined) return
            const current = (yield* Ref.get(fibers)).get(sessionId)
            if (current?.token !== running.token) return
            yield* Fiber.interrupt(running.fiber).pipe(
              Effect.timeout(INTERRUPT_GRACE),
              Effect.ignore
            )
          })
        )
        // Kill any digest being prepared for this session too. It runs on a
        // DAEMON fiber, so interrupting the run leaves it alive — an operator who
        // stopped a session would otherwise keep paying for a summary of it, with
        // nothing on screen to say why.
        yield* ContextManager.cancel(sessionId).pipe(Effect.ignore)
      })

    /**
     * Everything a turn needs before it has a fiber: session load, CLI
     * discovery, the compaction swap, the placeholder turns, and the fork.
     *
     * Split out from `prompt` purely so the whole region can run under the
     * session lock. It completes the moment the mailbox stream is handed back,
     * so the permit covers setup only — never the life of the run.
     *
     * The placeholder append has to be inside the lock, not just the fork:
     * `TranscriptStore.patchLast` patches whatever message is last, so a stop
     * still unwinding while the next turn appended its placeholder would write
     * its "Stopped." note onto the NEW turn.
     */
    const promptSetup = (
      sessionId: string,
      text: string,
      images: ReadonlyArray<Attachment>
    ) =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const adapter = yield* CliAdapter
          const session: Session | null = yield* SessionStore.get(sessionId).pipe(
            Effect.map((s): Session | null => s),
            Effect.orElseSucceed(() => null)
          )

          const mode = (yield* Ref.get(modes)).get(sessionId) ?? session?.mode ?? "accept-edits"
          const allow = new Set<string>([
            ...((yield* Ref.get(allowlists)).get(sessionId) ?? []),
            ...(session?.allowlist ?? [])
          ])
          // `starbase` is not a harness that can run anything — it is us. A
          // session on the orchestrator runs on the ONE model the operator
          // configured for it (default Claude Opus), so general asks have a
          // predictable identity. Resolving it here, before the binary lookup
          // and the spec, means everything downstream sees a real harness and
          // needs no idea the orchestrator exists. Without this the dispatcher
          // falls through to the scripted stub and the session silently does
          // nothing.
          const sessionCli = session?.cli ?? "claude"
          const workspaceConfig = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          const orchestrator = resolveOrchestrator(workspaceConfig)
          // Read once per turn: plan mode's commands run unattended unless the
          // operator switched that off in Settings.
          const planAutoRun = workspaceConfig?.planAutoRun ?? PLAN_AUTO_RUN_DEFAULT
          // Read per turn, not per session: flipping ADHD mode in Settings takes
          // effect on the very next message of an already-running session.
          const adhdMode = workspaceConfig?.adhdMode ?? ADHD_MODE_DEFAULT
          const cli = sessionCli === "starbase" ? orchestrator.cli : sessionCli
          // Cache the user's configured default exec mode so approving a plan can
          // restore it.
          const execDefault = yield* resolveExecMode(sessionId)
          yield* Ref.update(execDefaults, (m) => new Map(m).set(sessionId, execDefault))
          // Resolve the harness binary; null → the dispatcher uses the scripted
          // fallback (also the path when the CLI isn't installed).
          const binPath =
            (yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => [])))
              .find((c) => c.kind === cli)?.binPath ?? null
          // The agent always runs in the session's isolated worktree.
          //
          // This comment used to claim an empty value "would fail loudly on a
          // missing worktree". It did the exact opposite: the adapters mapped
          // `"" || undefined` to *no* cwd, so the harness inherited the Electron
          // main process's working directory — in development, whichever worktree
          // `pnpm dev` was launched from. An agent for repo A would then read and
          // edit repo B, most likely Starbase's own source. The adapters now call
          // `requireWorktree`, which throws rather than inheriting.
          const worktreePath = session?.worktreePath ?? ""
          // Saved plans for this worktree, so a "implement/continue the plan" turn
          // can be pointed at the plan file on disk (best-effort — never blocks).
          const savedPlans =
            worktreePath.length > 0
              ? yield* PlanStore.list(worktreePath).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              : []
          /**
           * Consume a ready digest, if the context manager has one waiting.
           *
           * This is the entire swap. Compaction prepared in the background while
           * the user was reading the last answer, so applying it costs nothing
           * here — it only changes how the spec below is built. Sub-agents never
           * reach this code: they run inside the harness process, and this is the
           * top-level turn path.
           */
          const applied = yield* ContextManager.applyIfReady(sessionId)
          const digest = applied?.digest ?? null
          // The WORKING SET at the moment of the swap, straight from the manager.
          //
          // Deliberately NOT `session.tokens`: that is the session's lifetime
          // total (see `Session.contextTokens` in domain.ts) and only ever grows,
          // which is how the marker came to read "Context compacted from
          // 49894.2k" — ~49.9M lifetime tokens rendered as a working set. The
          // persisted `contextTokens` is the fallback for a session whose live
          // reading has not arrived yet; 0 hides the clause entirely.
          const compactedFrom =
            applied === null
              ? 0
              : applied.tokensBefore > 0
                ? applied.tokensBefore
                : session?.contextTokens ?? 0
          // Everything that landed after the digest was built is replayed
          // verbatim, so preparing in the background never races the user.
          const tail =
            digest === null
              ? []
              : tailAfter(
                  yield* TranscriptStore.list(sessionId).pipe(Effect.orElseSucceed(() => [])),
                  digest.throughMessageId
                )

          // Renamed from `planNote` when the plan-mode protocol note arrived: two
          // different plan-related prefixes with one name is a trap.
          const planPointer = savedPlans.length > 0 ? `${planPointerNote(worktreePath, savedPlans)}\n\n` : ""
          const primer = digest === null ? "" : `${renderPrimer(digest, tail)}\n\n`
          // ADHD mode rides in the same per-turn prefix as the primer and the plan
          // pointer. There is no system-prompt hook that every harness shares, and
          // a setting the operator can flip mid-session has to apply to the NEXT
          // turn — which a session-start injection could not do.
          const adhd = adhdMode ? `${adhdNote(cli)}\n\n` : ""
          // Not optional, and not a setting: an agent that asks in prose is an
          // agent whose question never reaches the operator. Claude has the
          // `AskUserQuestion` tool the adapter intercepts, Codex has the fenced
          // block the adapter parses — but nothing tells either of them to
          // prefer it, so both default to asking in chat text that renders as
          // an unanswerable paragraph. Rides the same per-turn prefix as ADHD
          // mode, for the same reason: no system-prompt hook is shared by every
          // harness, and this has to survive a mid-session harness switch.
          const ask = `${questionNote(cli)}\n\n`
          // How this harness submits a plan. Null for Claude — the adapter passes
          // `planModeInstructions` as a real SDK option there, and saying it twice
          // would compete with the `ExitPlanMode` tool the harness is steered
          // toward. Everything else is told to end its reply with the block.
          const planProtocol = mode === "plan" ? planNote(cli) : null
          const planning = planProtocol === null ? "" : `${planProtocol}\n\n`

          const spec: SessionSpec = {
            cli,
            repo: session?.repo ?? "",
            branch: session?.branch ?? "",
            cwd: worktreePath,
            // A slash command is only expanded by the harness when it is the FIRST
            // thing in the message. Prefixing a compaction primer or a plan pointer
            // turned `/babysit-pr …` into prose, and the turn came back instantly
            // with nothing to say — the empty "CLAUDE" block. When the operator
            // opens with a command, the context rides along AFTER it instead.
            prompt: isSlashCommand(text)
              ? `${text}\n\n${primer}${planPointer}${adhd}${ask}${planning}`.trimEnd()
              : `${primer}${planPointer}${adhd}${ask}${planning}${text}`,
            images,
            binPath,
            mode,
            model:
              sessionCli === "starbase"
                ? orchestrator.model
                : (session?.model ?? defaultModel(cli)),
            // The persisted harness session id, so the adapter resumes the full
            // conversation even after a restart cleared its in-memory resume map.
            //
            // On a compaction this is dropped: the whole point is to begin a NEW
            // harness conversation seeded with the summary. `fresh` is required
            // alongside it because the adapter prefers its in-memory resume map
            // over the spec, so a null id alone would silently resume anyway.
            resumeId: digest === null ? session?.resumeId ?? null : null,
            ...(digest === null ? {} : { fresh: true })
          }

          // Clear the PERSISTED id too, so a crash between here and the harness
          // reporting its new id can't leave the session pointing at a thread
          // whose context we have already decided to abandon.
          if (digest !== null) yield* SessionStore.clearResumeId(sessionId).pipe(Effect.ignore)

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            | TranscriptStore
            | SessionStore
            | PlanStore
            | BackgroundTaskStore
            // `emit` hands every context reading to the manager, which may fork a
            // digest run — so the manager's own dependencies (the adapter it
            // summarises through, the config holding the budget, the discovery
            // that finds the binary) have to be captured here too, or `emit`
            // stops being `R = never` and the whole fold fails to type.
            | ContextManager
            | ConfigService
            | CliAdapter
            | DiscoveryService
            | CommandExecutor.CommandExecutor
            | FileSystem.FileSystem
            | Path.Path
            | AppPaths
          >()

          const now = yield* Effect.sync(() => new Date().toISOString())
          // The id counter is in-memory and resets when the app restarts, but the
          // transcript persists — so seed it past any id already recorded for this
          // session, otherwise a run after a restart re-emits colliding ids
          // (`u_<sid>_1`, `a_<sid>_2`, …) and the virtualized transcript stacks
          // rows keyed by those ids. Deterministic: empty transcript → starts at 1.
          const priorMax = (yield* TranscriptStore.list(sessionId).pipe(Effect.orElseSucceed(() => [])))
            .reduce((max, m) => {
              const n = Number(m.id.split("_").pop())
              return Number.isFinite(n) && n > max ? n : max
            }, 0)
          yield* Ref.update(counter, (c) => Math.max(c, priorMax))
          const un = yield* nextId
          yield* TranscriptStore.append(sessionId, userMessage(`u_${sessionId}_${un}`, text, now, images))
          const an = yield* nextId
          const acc = yield* Ref.make(assistantMessage(`a_${sessionId}_${an}`, now))
          yield* TranscriptStore.append(sessionId, yield* Ref.get(acc))

          const out = yield* Mailbox.make<StreamEvent>()

          /**
           * ── Instrumentation: turns that end without settling ────────────────
           *
           * A turn's `streaming` flag is cleared by exactly two events, `Done`
           * and `Failed` (see `applyEvent` in core/conversation.ts). A run that
           * ends without emitting either leaves the turn spinning in the live UI
           * forever — the "turn died and never responded" report. It reads as
           * self-healing because `settleStreaming()` wipes stale flags whenever
           * the transcript is re-read, so a reload hides the evidence.
           *
           * Measured at 142 of 729 persisted assistant messages (~19.5%), so this
           * is common, not exotic — but which path skips both events is still
           * unknown, and interrupts are NOT uniformly to blame (one interrupted
           * turn settled with the stop note while another, same session, did not).
           *
           * So: record the shape of every unsettled exit, and let the next
           * occurrence say what it was. Purely observational — it changes no
           * behaviour and cannot fail a run (`Effect.ignore` at the call site).
           */
          const sawTerminal = yield* Ref.make(false)
          const eventCount = yield* Ref.make(0)
          const lastEvent = yield* Ref.make<string>("<none>")
          const wasInterrupted = yield* Ref.make(false)

          // toolUseId → the file an edit tool is writing, remembered at ToolStart so
          // its ToolEnd can mark the matching plan step done (see markPlanProgress).
          const editTargets = yield* Ref.make(new Map<string, string>())

          // The whole transcript, best-effort — the plan under execution usually
          // lives in an EARLIER message than this turn's accumulator.
          const allMessages: Effect.Effect<ReadonlyArray<Message>> = TranscriptStore.list(sessionId).pipe(
            Effect.provide(env),
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )

          // Find a plan and the message holding it. A plan part stays in the
          // message of the turn it was PROPOSED in, while execution runs on over
          // later turns — each with its own accumulator. So looking only at `acc`
          // finds the plan on the proposing turn and never again. Accumulator
          // first (it's the freshest copy of this turn's message), then the
          // persisted transcript.
          const locatePlan = (
            planId: string
          ): Effect.Effect<{ readonly plan: Plan; readonly messageId: string } | null> =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(acc)
              const inAcc = findPlan(cur, planId)
              if (inAcc !== null) return { plan: inAcc, messageId: cur.id }
              const msgs = yield* allMessages
              for (let i = msgs.length - 1; i >= 0; i--) {
                const found = findPlan(msgs[i]!, planId)
                if (found !== null) return { plan: found, messageId: msgs[i]!.id }
              }
              return null
            })

          // Read the current plan, wherever in the transcript it lives.
          const readPlan = (planId: string): Effect.Effect<Plan | null> =>
            Effect.map(locatePlan(planId), (located) => located?.plan ?? null)

          // Replace a plan part in place: update the accumulator + persisted
          // transcript, and push a `PlanUpdated` so an attached renderer syncs.
          // Addresses the plan's OWN message — `patchLast` would hit this turn's
          // message, which for a plan proposed on an earlier turn holds no plan.
          const applyPlan = (planId: string, f: (plan: Plan) => Plan): Effect.Effect<void> =>
            Effect.gen(function* () {
              const located = yield* locatePlan(planId)
              if (located === null) return
              const nextPlan = f(located.plan)
              const patch = (m: Message): Message => ({
                ...m,
                parts: m.parts.map((p) =>
                  p._tag === "Plan" && p.plan.id === planId ? { _tag: "Plan", plan: nextPlan } : p
                )
              })
              const cur = yield* Ref.get(acc)
              if (located.messageId === cur.id) {
                const next = patch(cur)
                yield* Ref.set(acc, next)
                yield* TranscriptStore.patchLast(sessionId, () => next).pipe(Effect.ignore)
              } else {
                // The plan is behind us: patch its message directly and leave the
                // accumulator alone (it holds a different, later message).
                yield* TranscriptStore.patchById(sessionId, located.messageId, patch).pipe(Effect.ignore)
              }
              yield* out.offer({ _tag: "PlanUpdated", plan: nextPlan })
            }).pipe(Effect.provide(env), Effect.asVoid)

          // When an edit lands during execution of an approved plan, mark the plan
          // step whose proposed files include the edited path as "done" — tying live
          // progress back to the plan. Path matching is suffix-based so an absolute
          // worktree path matches a step's repo-relative file.
          const markPlanProgress = (toolId: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const target = (yield* Ref.get(editTargets)).get(toolId)
              if (target === undefined) return
              // Accumulator first (the plan was proposed this turn), else the
              // transcript (it was proposed earlier and execution has moved on).
              const cur = yield* Ref.get(acc)
              const inAcc = cur.parts.find((p) => p._tag === "Plan" && p.plan.status === "approved")
              const executing =
                inAcc !== undefined && inAcc._tag === "Plan"
                  ? { plan: inAcc.plan, messageId: cur.id }
                  : findApprovedPlan(yield* allMessages)
              if (executing === null) return
              const t = normalizePath(target)
              const step = executing.plan.steps.find(
                (s) => s.status !== "done" && s.files.some((f) => samePath(t, normalizePath(f.path)))
              )
              if (step === undefined) return
              yield* applyPlan(executing.plan.id, (pl) => ({
                ...pl,
                steps: pl.steps.map((s) => (s.id === step.id ? { ...s, status: "done" as const } : s))
              }))
            })

          // Fold each event into the assistant message + persist, then surface it.
          // Runs on the single producer fiber, so transcript order is preserved.
          const emit = (event: StreamEvent): Effect.Effect<void> =>
            Effect.gen(function* () {
              // Tracked before the early returns below, so background-task and
              // sub-agent events still count toward "what did this run actually
              // emit" — a run that produced only sub-agent chatter and then
              // vanished is a different failure from one that emitted nothing.
              yield* Ref.update(eventCount, (n) => n + 1)
              yield* Ref.set(lastEvent, event._tag)
              if (event._tag === "Done" || event._tag === "Failed") {
                yield* Ref.set(sawTerminal, true)
              }
              // Background tasks are SESSION-level: they outlive this turn, so
              // they fold into the session's task registry (one statechart per
              // task) rather than into the transcript. Surfaced downstream too so
              // the dock updates live, but never persisted onto a message —
              // that would pin a still-running task to a finished turn.
              if (isBackgroundTaskEvent(event)) {
                yield* BackgroundTaskStore.ingest(sessionId, event).pipe(Effect.provide(env), Effect.ignore)
                yield* out.offer(event)
                return
              }
              // Sub-agent events drive live-only tabs, not the persisted main turn.
              // Surface them downstream (the renderer keeps per-sub-agent
              // transcripts) but never fold them into the main assistant message —
              // that would interleave unrelated agents' output into the transcript.
              if (isSubagentEvent(event)) {
                yield* out.offer(event)
                return
              }
              // Live tool output is stream-only. A main-turn `ToolDelta` is NOT a
              // sub-agent event, so without this it would fall through to
              // `patchLast` — which does a full-file read+decode+encode+rewrite of
              // the transcript on EVERY tick. Surface it to the renderer (which
              // folds it into the running card) and let `ToolEnd` persist the
              // authoritative final output.
              if (event._tag === "ToolDelta") {
                yield* out.offer(event)
                return
              }
              // A finished turn reports what it used. Accrued here rather than
              // in the adapters so every harness lands in one place — and so a
              // harness that reports nothing simply adds zero instead of needing
              // its own bookkeeping.
              if (event._tag === "Done") {
                yield* SessionStore.addUsage(sessionId, {
                  costUsd: event.costUsd,
                  tokens: event.tokens
                }).pipe(Effect.provide(env), Effect.ignore)
              }
              const next = applyStreamEvent(yield* Ref.get(acc), event)
              yield* Ref.set(acc, next)
              yield* TranscriptStore.patchLast(sessionId, () => next).pipe(Effect.ignore)
              // Persist the harness's actual model (reported on init) so the chip
              // reflects reality even when the session hadn't pinned one.
              if (event._tag === "Started" && event.model) {
                yield* SessionStore.setModel(sessionId, event.model).pipe(Effect.ignore)
              }
              // Persist the harness session id (carried on Started) so the NEXT
              // prompt resumes this conversation — even after an app restart wiped
              // the adapter's in-memory resume map. `event.sessionId` is the
              // harness's own id, not our `sessionId` (the Starbase session key).
              if (event._tag === "Started" && event.sessionId.length > 0) {
                yield* SessionStore.setResumeId(sessionId, event.sessionId).pipe(Effect.ignore)
              }
              // Remember an edit's target path so its ToolEnd can tie back to a step.
              if (event._tag === "ToolStart" && EDIT_TOOLS.has(event.name) && event.target) {
                yield* Ref.update(editTargets, (m) => new Map(m).set(event.id, event.target!))
              }
              yield* out.offer(event)
              // After the tool card lands, reconcile plan progress off a successful edit.
              if (event._tag === "ToolEnd" && event.status === "success") {
                yield* markPlanProgress(event.id)
              }
              // Hand every context reading to the manager, but only let a SETTLED
              // turn start a digest.
              //
              // Claude and opencode report usage per assistant message, so a turn
              // that uses tools reports several times before it ends. Summarising
              // from one of those mid-turn readings would capture a transcript
              // whose last message is still streaming, and the digest's
              // `throughMessageId` would then cause the rest of that same turn to
              // be skipped at swap time — neither summarised nor replayed.
              //
              // `Done` is the only point at which the transcript is coherent.
              if (event._tag === "Usage") {
                yield* ContextManager.observe(sessionId, event.tokens, event.window ?? null).pipe(
                  Effect.ignore
                )
              }
              // `Done` says WHEN to decide, never WHAT the context is. Its
              // `tokens` is the run's cumulative spend (see the Claude adapter),
              // which counts resident context once per tool call — reading it as
              // occupancy meant a long tool-using turn reported several times the
              // window size and compacted on every single turn, at a threshold
              // that moved with the tool count rather than the context. The
              // manager uses the latest `Usage` reading instead.
              if (event._tag === "Done") {
                yield* ContextManager.settle(sessionId).pipe(Effect.ignore)
              }
            }).pipe(Effect.provide(env), Effect.asVoid)

          const canUseTool = (req: PermissionRequest): Effect.Effect<PermissionDecision> =>
            Effect.gen(function* () {
              // Re-read the live mode each call so an in-run change (e.g. a plan
              // approval restoring the exec mode) takes effect on this same turn.
              const liveMode = (yield* Ref.get(modes)).get(sessionId) ?? mode
              if (verdict(liveMode, allow, req, planAutoRun) === "allow") return "allow" as const
              const gn = yield* nextId
              const gateId = `g_${sessionId}_${gn}`
              const gate = buildGate(gateId, req)
              const deferred = yield* Deferred.make<PermissionDecision>()
              yield* Ref.update(gates, (m) =>
                new Map(m).set(gateId, { sessionId, deferred, allowLabel: gate.allowLabel })
              )
              yield* emit({ _tag: "GateRequested", gate })
              const decision = yield* Deferred.await(deferred)
              yield* Ref.update(gates, (m) => {
                const next = new Map(m)
                next.delete(gateId)
                return next
              })
              return decision
            })

          const askQuestion = (
            request: QuestionRequest
          ): Effect.Effect<ReadonlyArray<QuestionAnswer>> =>
            Effect.gen(function* () {
              const deferred = yield* Deferred.make<ReadonlyArray<QuestionAnswer>>()
              yield* Ref.update(questions, (m) => new Map(m).set(request.id, { sessionId, deferred }))
              yield* emit({ _tag: "QuestionRequested", request })
              const answers = yield* Deferred.await(deferred)
              yield* Ref.update(questions, (m) => {
                const next = new Map(m)
                next.delete(request.id)
                return next
              })
              // Record the answers onto the assistant turn's question part — both
              // the live accumulator (so later emits don't clobber it) and the
              // persisted transcript (so a reload doesn't re-show the question).
              yield* Ref.update(acc, (m) => setQuestionAnswers(m, request.id, answers))
              yield* TranscriptStore.patchLast(sessionId, (m) => setQuestionAnswers(m, request.id, answers)).pipe(
                Effect.provide(env),
                Effect.ignore
              )
              return answers
            })

          const proposePlan = (plan: Plan): Effect.Effect<PlanDecision> =>
            Effect.gen(function* () {
              const deferred = yield* Deferred.make<PlanDecision>()
              yield* Ref.update(plans, (m) => new Map(m).set(plan.id, { sessionId, deferred }))
              yield* emit({ _tag: "PlanProposed", plan })
              // Persist the plan to the session's plan library so a later turn or
              // session can pick it back up — the next run points the agent at it.
              // Best-effort: a write failure never blocks plan review.
              if (worktreePath.length > 0) {
                yield* PlanStore.write(worktreePath, plan).pipe(Effect.provide(env), Effect.ignore)
              }
              const decision = yield* Deferred.await(deferred)
              yield* Ref.update(plans, (m) => {
                const nextMap = new Map(m)
                nextMap.delete(plan.id)
                return nextMap
              })
              return decision
            })

          // Publish live handles so comment/revise/approve can reach this run;
          // torn down when the run ends so out-of-band calls become no-ops.
          yield* Ref.update(active, (m) => new Map(m).set(sessionId, { readPlan, applyPlan }))

          /** Identifies THIS run, so its cleanup can't evict a successor's fiber. */
          const token: RunToken = {}

          // Publish this run's per-task stop handle. Registering also orphans
          // anything the previous harness process left running — the live set is
          // per-process, so those ids no longer resolve to anything stoppable.
          const registerBackgroundStop = (stop: StopBackgroundTask) =>
            BackgroundTaskStore.registerStop(sessionId, stop).pipe(Effect.provide(env), Effect.ignore)

          // Record the compaction on THIS turn, before the harness says anything.
          //
          // The transcript is never truncated — the user can still scroll back
          // through the whole conversation. This marker exists so that what the
          // model kept is legible: without it the context meter would simply drop
          // with no explanation, which is how `/compact` behaves today and exactly
          // why it feels like the app lost your history.
          if (digest !== null) {
            yield* emit({ _tag: "ContextCompacted", digest, tokensBefore: compactedFrom })
          }

          const run = adapter.run(sessionId, spec, {
            emit,
            canUseTool,
            askQuestion,
            proposePlan,
            registerBackgroundStop
          }).pipe(
            // An operator stop arrives as an interruption. Record it as the turn's
            // terminal event so the message settles (and the transcript says why)
            // rather than being left mid-stream forever. Finalizers run
            // uninterruptibly, so this emit completes before the mailbox closes.
            Effect.onInterrupt(() =>
              // Flagged BEFORE the emit, so the instrumentation still learns the
              // exit was an interrupt even in the case we most want to catch:
              // the one where this emit does not land.
              Ref.set(wasInterrupted, true).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    // Don't overwrite a reason the turn already has. The
                    // first-event watchdog settles the turn with a message that
                    // says what went wrong and THEN interrupts, so an
                    // unconditional emit here would bury it under a bare
                    // "Stopped." — telling the operator their own action halted a
                    // turn they never touched.
                    if (yield* Ref.get(sawTerminal)) return
                    yield* emit({ _tag: "Failed", message: STOPPED_NOTE })
                  })
                )
              )
            ),
            // A stop is not a crash — don't report the operator's own interrupt as
            // "the agent run failed" on top of the note we just wrote.
            Effect.catchAllCause((cause) => {
              if (Cause.isInterruptedOnly(cause)) return Effect.void
              const failure = Option.getOrUndefined(Cause.failureOption(cause))
              return emit({
                _tag: "Failed",
                message: failure instanceof CliExecError ? failure.message : "The agent run failed."
              })
            }),
            Effect.ensuring(
              Ref.update(active, (m) => {
                const nextMap = new Map(m)
                nextMap.delete(sessionId)
                return nextMap
              })
            ),
            Effect.ensuring(
              // Deregister THIS run only. A session's slot can already belong to a
              // NEWER run by the time this one finishes: "send now" interrupts the
              // current turn and starts the next without waiting for the stop to
              // land (the renderer fires it and moves on), so the two overlap.
              // Deleting by session id alone would evict the new run's fiber, and
              // the next stop would find nothing and quietly do nothing — leaving
              // a turn nobody can halt. The token is in scope here; the fiber
              // doesn't exist yet.
              //
              // Untested, deliberately: the obvious test can't reach this. This
              // finalizer runs BEFORE `out.end`, and a consumer only returns once
              // the stream ends — so any test that awaits run 1 before starting
              // run 2 has already missed the overlap, and passes with or without
              // the guard. Reproducing it needs run 1 still unwinding while run 2
              // registers, which is a timing construction, not a fact about the
              // code. Reviewed rather than pinned.
              Ref.update(fibers, (m) => {
                if (m.get(sessionId)?.token !== token) return m
                const nextMap = new Map(m)
                nextMap.delete(sessionId)
                return nextMap
              })
            ),
            /**
             * Record an exit that never settled the turn.
             *
             * Ordered INSIDE `out.end` (it is piped before it, so it runs first)
             * purely so the reading is taken while the run's state is still the
             * one that produced it; nothing here touches the mailbox.
             *
             * `exitInterrupted` is the field that should break the tie: if
             * unsettled exits are all interrupts, the stop path is racing its own
             * `Failed` emit; if they are not, something upstream is ending the
             * stream without a terminal event at all.
             */
            Effect.ensuring(
              Effect.gen(function* () {
                if (yield* Ref.get(sawTerminal)) return
                const fs = yield* FileSystem.FileSystem
                const paths = yield* AppPaths
                const record = {
                  at: new Date().toISOString(),
                  sessionId,
                  cli: session?.cli ?? null,
                  images: images.length,
                  events: yield* Ref.get(eventCount),
                  lastEvent: yield* Ref.get(lastEvent),
                  exitInterrupted: yield* Ref.get(wasInterrupted)
                }
                yield* fs.writeFileString(
                  `${paths.root}/unsettled-turns.jsonl`,
                  `${JSON.stringify(record)}\n`,
                  { flag: "a" }
                )
              }).pipe(Effect.provide(env), Effect.ignore)
            ),
            Effect.ensuring(out.end)
          )
          const fiber = yield* Effect.forkScoped(run)
          yield* Ref.update(fibers, (m) => new Map(m).set(sessionId, { fiber, token }))

          // Watchdog the FIRST event.
          //
          // A harness child that hangs before it says anything is invisible to
          // every guarantee we have: `drainRun` in the renderer only synthesises
          // a terminal event when the stream ends, `Effect.ensuring(out.end)`
          // only runs when `adapter.run` returns, and the unsettled-turn
          // instrumentation below is a FINALIZER — none of them can fire on a
          // run that neither emits nor exits. The operator is left with a
          // pulsing eyebrow over an empty message and no way to tell whether
          // anything is happening. Only a timer can see this.
          //
          // Deliberately checks `eventCount` rather than racing the run: a
          // harness that emitted even once is alive, and killing a slow-but-live
          // turn would be far worse than the bug. Interrupting reuses the
          // existing stop path, so the transcript settles the same way an
          // operator stop does — except we say why.
          yield* Effect.forkScoped(
            Effect.sleep(FIRST_EVENT_DEADLINE).pipe(
              Effect.zipRight(
                Effect.gen(function* () {
                  if ((yield* Ref.get(eventCount)) > 0) return
                  yield* emit({
                    _tag: "Failed",
                    message: `${session?.cli ?? "The agent"} produced no output for ${FIRST_EVENT_DEADLINE}. The turn was cancelled — send your message again.`
                  })
                  yield* Fiber.interrupt(fiber)
                })
              )
            )
          )
          return Mailbox.toStream(out)
        })
      )

    const prompt = (
      sessionId: string,
      text: string,
      images: ReadonlyArray<Attachment> = []
    ): Stream.Stream<StreamEvent, never, PromptEnv> =>
      Stream.unwrapScoped(
        Effect.flatMap(sessionLock(sessionId), (lock) =>
          lock.withPermits(1)(promptSetup(sessionId, text, images))
        )
      )

    return {
      /**
       * Whether any session is mid-run. Read by the learning daemon so a
       * background tick never contends for the rate limits the operator is
       * actively waiting on — the runner already owns this map, so exposing it
       * beats a second source of truth that could disagree.
       */
      anyRunning: Effect.map(Ref.get(fibers), (m) => m.size > 0),
      prompt,
      decideGate,
      answerQuestion,
      setMode,
      stop,
      commentPlanStep,
      revisePlan,
      approvePlan,
      resumePlan
    } as const
  })
}) {}
