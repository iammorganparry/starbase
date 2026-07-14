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
  isSubagentEvent,
  resumePlanPrompt,
  setQuestionAnswers,
  userMessage
} from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Deferred, Effect, Mailbox, Ref, Stream } from "effect"
import { AppPaths } from "./app-paths.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import type { PermissionDecision, PermissionRequest, SessionSpec } from "./adapter.js"
import { readDefaultMode } from "./default-mode.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

/** Tools that write to disk — a successful one advances the matching plan step. */
const EDIT_TOOLS = new Set(["Write", "Edit", "Update", "MultiEdit", "NotebookEdit"])

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
  | SessionStore
  | TranscriptStore
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
        yield* persistMode(sessionId, mode)
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
        // Engage the mode they normally run in — their configured default (e.g.
        // "auto") first; else what they had before planning; else a safe default.
        const mode =
          (yield* Ref.get(execDefaults)).get(sessionId) ??
          (yield* Ref.get(priorModes)).get(sessionId) ??
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
          yield* setMode(sessionId, yield* resolveExecMode(sessionId))
          return prompt(sessionId, resumePlanPrompt(plan))
        })
      )

    /** Deny every pending gate + question + plan for a session — a graceful stop. */
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
          const cli = session?.cli ?? "claude"
          // Cache the user's configured default exec mode so approving a plan can
          // restore it.
          const execDefault = yield* resolveExecMode(sessionId)
          yield* Ref.update(execDefaults, (m) => new Map(m).set(sessionId, execDefault))
          // Resolve the harness binary; null → the dispatcher uses the scripted
          // fallback (also the path when the CLI isn't installed).
          const binPath =
            (yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => [])))
              .find((c) => c.kind === cli)?.binPath ?? null
          const spec: SessionSpec = {
            cli,
            repo: session?.repo ?? "",
            branch: session?.branch ?? "",
            cwd: session?.worktreePath ?? "",
            prompt: text,
            images,
            binPath,
            mode,
            model: session?.model ?? defaultModel(cli)
          }

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            TranscriptStore | SessionStore | FileSystem.FileSystem | Path.Path | AppPaths
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

          // Read the current plan from the live accumulator (for the out-of-band RPCs).
          const readPlan = (planId: string): Effect.Effect<Plan | null> =>
            Effect.map(Ref.get(acc), (m) => findPlan(m, planId))

          // Replace a plan part in place: update the accumulator + persisted
          // transcript, and push a `PlanUpdated` so an attached renderer syncs.
          const applyPlan = (planId: string, f: (plan: Plan) => Plan): Effect.Effect<void> =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(acc)
              const plan = findPlan(cur, planId)
              if (plan === null) return
              const nextPlan = f(plan)
              const next: Message = {
                ...cur,
                parts: cur.parts.map((p) =>
                  p._tag === "Plan" && p.plan.id === planId ? { _tag: "Plan", plan: nextPlan } : p
                )
              }
              yield* Ref.set(acc, next)
              yield* TranscriptStore.patchLast(sessionId, () => next).pipe(Effect.ignore)
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
              const cur = yield* Ref.get(acc)
              const executing = cur.parts.find((p) => p._tag === "Plan" && p.plan.status === "approved")
              if (executing === undefined || executing._tag !== "Plan") return
              const t = target.replace(/\\/g, "/")
              const step = executing.plan.steps.find(
                (s) =>
                  s.status !== "done" &&
                  s.files.some((f) => {
                    const fp = f.path.replace(/\\/g, "/")
                    return t === fp || t.endsWith(`/${fp}`) || fp.endsWith(t) || t.endsWith(fp)
                  })
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
              // Sub-agent events drive live-only tabs, not the persisted main turn.
              // Surface them downstream (the renderer keeps per-sub-agent
              // transcripts) but never fold them into the main assistant message —
              // that would interleave unrelated agents' output into the transcript.
              if (isSubagentEvent(event)) {
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

          const run = adapter.run(sessionId, spec, { emit, canUseTool, askQuestion, proposePlan }).pipe(
            Effect.catchAllCause(() => emit({ _tag: "Failed", message: "The agent run failed." })),
            Effect.ensuring(
              Ref.update(active, (m) => {
                const nextMap = new Map(m)
                nextMap.delete(sessionId)
                return nextMap
              })
            ),
            Effect.ensuring(out.end)
          )
          yield* Effect.forkScoped(run)
          return Mailbox.toStream(out)
        })
      )

    return {
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
