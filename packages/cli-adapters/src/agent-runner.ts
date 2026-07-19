import type {
  ApprovalGate,
  Attachment,
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
  applyStreamEvent,
  assistantMessage,
  defaultModel,
  findApprovedPlan,
  isBackgroundTaskEvent,
  isSubagentEvent,
  normalizePath,
  resumePlanPrompt,
  samePath,
  setQuestionAnswers,
  STOPPED_NOTE,
  userMessage,
  resolveOrchestrator
} from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Cause, Deferred, Effect, Fiber, Mailbox, Ref, Stream } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import type { PermissionDecision, PermissionRequest, SessionSpec, StopBackgroundTask } from "./adapter.js"
import { readDefaultMode } from "./default-mode.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { PlanStore } from "./plan-store.js"

/** Tools that write to disk — a successful one advances the matching plan step. */
const EDIT_TOOLS = new Set(["Write", "Edit", "Update", "MultiEdit", "NotebookEdit"])

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
  req: PermissionRequest
): "allow" | "gate" => {
  if (mode === "auto") return "allow"
  if (isAllowlisted(allow, req.command)) return "allow"
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
    const approvePlan = (sessionId: string, planId: string) =>
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
        // KNOWN GAP: `prompt` does its setup (session load, CLI discovery, plan
        // lookup) BEFORE it forks, so a stop landing in that window finds no
        // fiber and no-ops — the agent then starts. It's narrow (the operator has
        // to hit stop within ~a tenth of a second of sending) and self-evident:
        // the run visibly continues and a second stop lands. Closing it properly
        // means forking first and moving the setup inside the fiber, so there's
        // always something to interrupt; a session flag can't fix it, since a
        // stop arriving with no run in flight is indistinguishable from a stale
        // one, and acting on it would kill the operator's NEXT turn instead.
        const running = (yield* Ref.get(fibers)).get(sessionId)
        if (running !== undefined) yield* Fiber.interrupt(running.fiber)
      })

    const prompt = (
      sessionId: string,
      text: string,
      images: ReadonlyArray<Attachment> = []
    ): Stream.Stream<StreamEvent, never, PromptEnv> =>
      Stream.unwrapScoped(
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
          const orchestrator = resolveOrchestrator(
            yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          )
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
          const spec: SessionSpec = {
            cli,
            repo: session?.repo ?? "",
            branch: session?.branch ?? "",
            cwd: worktreePath,
            prompt: savedPlans.length > 0 ? `${planPointerNote(worktreePath, savedPlans)}\n\n${text}` : text,
            images,
            binPath,
            mode,
            model:
              sessionCli === "starbase"
                ? orchestrator.model
                : (session?.model ?? defaultModel(cli)),
            // The persisted harness session id, so the adapter resumes the full
            // conversation even after a restart cleared its in-memory resume map.
            resumeId: session?.resumeId ?? null
          }

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            | TranscriptStore
            | SessionStore
            | PlanStore
            | BackgroundTaskStore
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
            }).pipe(Effect.provide(env), Effect.asVoid)

          const canUseTool = (req: PermissionRequest): Effect.Effect<PermissionDecision> =>
            Effect.gen(function* () {
              // Re-read the live mode each call so an in-run change (e.g. a plan
              // approval restoring the exec mode) takes effect on this same turn.
              const liveMode = (yield* Ref.get(modes)).get(sessionId) ?? mode
              if (verdict(liveMode, allow, req) === "allow") return "allow" as const
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
            Effect.onInterrupt(() => emit({ _tag: "Failed", message: STOPPED_NOTE })),
            // A stop is not a crash — don't report the operator's own interrupt as
            // "the agent run failed" on top of the note we just wrote.
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.void
                : emit({ _tag: "Failed", message: "The agent run failed." })
            ),
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
            Effect.ensuring(out.end)
          )
          const fiber = yield* Effect.forkScoped(run)
          yield* Ref.update(fibers, (m) => new Map(m).set(sessionId, { fiber, token }))
          return Mailbox.toStream(out)
        })
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
