import type {
  PermissionMode,
  Question,
  QuestionAnswer,
  ReasoningEffort
} from "@starbase/core"
import { CliExecError, resumePlanPrompt } from "@starbase/core"
import { Effect, Runtime } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import {
  codexAppServerMessageToStreamEvents,
  completedAgentReply,
  completedTurn,
  makeCodexAppServerEventState
} from "./codex-app-server-events.js"
import {
  type CodexAppServerConnection,
  type JsonRpcId,
  type JsonRpcMessage,
  startCodexAppServer
} from "./codex-app-server-client.js"
import { stageCodexInput, toCodexAppServerInput } from "./codex-input.js"
import { requireWorktree } from "./cwd.js"
import { hasPlanBlock, parsePlan } from "./plan-parse.js"
import { formatQuestionAnswers, parseQuestionBlock } from "./question-prompt.js"
import { harnessEnv, hasSubscriptionAuth } from "./subscription.js"
import { worktreeEnv } from "./worktree-env.js"

const MAX_QUESTION_ROUNDS = 4
const MAX_PLAN_ROUNDS = 6
const EMERGENCY_COMPACTION_RATIO = 0.9
const RESUME_REPLAY_WAIT_MS = 1_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const recordAt = (
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const stringAt = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" ? value : null
}

const rpcId = (message: JsonRpcMessage): JsonRpcId | null => {
  const id = message.id
  return typeof id === "number" || typeof id === "string" ? id : null
}

export const mapCodexAppServerReasoning = (
  effort: ReasoningEffort | undefined
): string | undefined => {
  switch (effort) {
    case "off":
      // GPT-5.6 Sol/Terra/Luna expose `low` as their lightest supported effort;
      // sending the SDK-era `minimal` value makes app-server reject the turn.
      return "low"
    case "think":
      return "medium"
    case "think-hard":
      return "high"
    case "ultrathink":
      return "xhigh"
    default:
      return
  }
}

const policy = (
  mode: PermissionMode,
  readOnly: boolean,
  unattended: boolean
): { readonly sandbox: string; readonly approvalPolicy: string } =>
  readOnly || mode === "plan"
    ? { sandbox: "read-only", approvalPolicy: "never" }
    : mode === "auto" && !unattended
      ? { sandbox: "danger-full-access", approvalPolicy: "never" }
      : mode === "ask"
        ? { sandbox: "read-only", approvalPolicy: "never" }
        : { sandbox: "workspace-write", approvalPolicy: "never" }

const threadIdFromResponse = (response: unknown): string | null => {
  if (!isRecord(response)) return null
  const thread = recordAt(response, "thread")
  return thread === null ? null : stringAt(thread, "id")
}

const turnIdFromResponse = (response: unknown): string | null => {
  if (!isRecord(response)) return null
  const turn = recordAt(response, "turn")
  return turn === null ? null : stringAt(turn, "id")
}

const nativeQuestions = (params: Record<string, unknown>): ReadonlyArray<{
  readonly id: string
  readonly question: Question
}> => {
  const raw = params.questions
  if (!Array.isArray(raw)) return []
  const questions: Array<{ readonly id: string; readonly question: Question }> = []
  for (const value of raw) {
    if (!isRecord(value)) continue
    const id = stringAt(value, "id")
    const header = stringAt(value, "header")
    const question = stringAt(value, "question")
    const rawOptions = value.options
    if (id === null || header === null || question === null || !Array.isArray(rawOptions)) {
      continue
    }
    const options = rawOptions.flatMap((option) => {
      if (!isRecord(option)) return []
      const label = stringAt(option, "label")
      const description = stringAt(option, "description")
      return label === null || description === null ? [] : [{ label, description }]
    })
    if (options.length < 2) continue
    questions.push({
      id,
      question: { question, header, options, multiSelect: false }
    })
  }
  return questions
}

const nativeQuestionResponse = (
  questions: ReadonlyArray<{ readonly id: string }>,
  answers: ReadonlyArray<QuestionAnswer>
): Record<string, unknown> => ({
  answers: Object.fromEntries(
    questions.map((question, index) => {
      const answer = answers[index]
      const values = [...(answer?.selected ?? [])]
      if (answer?.other !== null && answer?.other !== undefined) values.push(answer.other)
      return [question.id, { answers: values }]
    })
  )
})

const handleServerRequest = async (
  connection: CodexAppServerConnection,
  message: JsonRpcMessage,
  ctx: AgentContext,
  runP: <A>(effect: Effect.Effect<A>) => Promise<A>,
  sessionId: string
): Promise<boolean> => {
  const id = rpcId(message)
  const method = stringAt(message, "method")
  const params = recordAt(message, "params")
  if (id === null || method === null || params === null) return false

  if (method === "item/tool/requestUserInput") {
    const questions = nativeQuestions(params)
    if (questions.length === 0) {
      connection.respond(id, { answers: {} })
      return true
    }
    const answers = await runP(
      ctx.askQuestion({
        id: stringAt(params, "itemId") ?? `q_${sessionId}_native`,
        questions: questions.map((entry) => entry.question)
      })
    )
    connection.respond(id, nativeQuestionResponse(questions, answers))
    return true
  }

  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    const commandValue = params.command
    const command = Array.isArray(commandValue)
      ? commandValue.filter((part): part is string => typeof part === "string").join(" ")
      : typeof commandValue === "string"
        ? commandValue
        : ""
    const decision = await runP(
      ctx.canUseTool({
        kind: "command",
        tool: "Bash",
        target: command.length > 0 ? command : null,
        command: command.length > 0 ? command : null
      })
    )
    connection.respond(
      id,
      method === "execCommandApproval"
        ? { decision: decision === "allow" ? "approved" : { denied: { rejection: "Denied by the operator." } } }
        : { decision: decision === "allow" ? "accept" : "decline" }
    )
    return true
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const decision = await runP(
      ctx.canUseTool({
        kind: "edit",
        tool: "Edit",
        target: stringAt(params, "grantRoot"),
        command: null
      })
    )
    connection.respond(
      id,
      method === "applyPatchApproval"
        ? { decision: decision === "allow" ? "approved" : { denied: { rejection: "Denied by the operator." } } }
        : { decision: decision === "allow" ? "accept" : "decline" }
    )
    return true
  }

  if (method === "mcpServer/elicitation/request") {
    connection.respond(id, { action: "decline", content: null, _meta: null })
    return true
  }

  if (method === "currentTime/read") {
    connection.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
    return true
  }

  connection.respondError(id, -32601, `Unsupported Codex server request: ${method}`)
  return true
}

const usageRatio = (
  message: JsonRpcMessage,
  expectedThreadId: string
): number | null => {
  if (message.method !== "thread/tokenUsage/updated") return null
  const params = recordAt(message, "params")
  if (params === null || params.threadId !== expectedThreadId) return null
  const usage = recordAt(params, "tokenUsage")
  if (usage === null) return null
  const last = recordAt(usage, "last")
  const tokens = last?.totalTokens
  const window = usage.modelContextWindow
  return typeof tokens === "number" &&
    typeof window === "number" &&
    Number.isFinite(tokens) &&
    Number.isFinite(window) &&
    window > 0
    ? tokens / window
    : null
}

const cumulativeUsage = (
  message: JsonRpcMessage,
  expectedThreadId: string
): number | null => {
  if (message.method !== "thread/tokenUsage/updated") return null
  const params = recordAt(message, "params")
  if (params === null || params.threadId !== expectedThreadId) return null
  const usage = recordAt(params, "tokenUsage")
  const total = usage === null ? null : recordAt(usage, "total")
  const tokens = total?.totalTokens
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
    ? tokens
    : null
}

/**
 * Run Codex through app-server so resident context is observable during turns.
 */
export const runCodexAppServer = (
  sessionId: string,
  spec: SessionSpec,
  ctx: AgentContext,
  resume: Map<string, string>,
  onActivated?: () => void
): Effect.Effect<void, CliExecError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runP = <A>(effect: Effect.Effect<A>): Promise<A> =>
      Runtime.runPromise(runtime)(effect)
    const abort = new AbortController()
    let connection: CodexAppServerConnection | null = null
    let activeThreadId: string | null = null
    let activeTurnId: string | null = null

    yield* Effect.tryPromise({
      try: async () => {
        const cwd = requireWorktree(spec.cwd, `session ${sessionId}`)
        const env = harnessEnv(
          "codex",
          worktreeEnv(process.env, cwd),
          hasSubscriptionAuth("codex")
        )
        connection = await startCodexAppServer({ binPath: spec.binPath, env })
        const staged = await stageCodexInput(spec.prompt, spec.images)
        try {
          const prior =
            spec.fresh === true
              ? undefined
              : (resume.get(sessionId) ?? spec.resumeId ?? undefined)
          let activePolicy = policy(
            spec.mode,
            spec.readOnly ?? false,
            spec.unattended ?? false
          )
          const threadParams = {
            cwd,
            ...(spec.model ? { model: spec.model } : {}),
            sandbox: activePolicy.sandbox,
            approvalPolicy: activePolicy.approvalPolicy
          }
          const threadResponse =
            prior === undefined
              ? await connection.request("thread/start", {
                  ...threadParams,
                  ephemeral: spec.fresh === true
                })
              : await connection.request("thread/resume", {
                  threadId: prior,
                  ...threadParams
                })
          activeThreadId = threadIdFromResponse(threadResponse)
          if (activeThreadId === null) {
            throw new Error("Codex app-server returned no thread id")
          }
          onActivated?.()
          if (spec.fresh !== true) resume.set(sessionId, activeThreadId)
          await runP(ctx.emit({ _tag: "Started", sessionId: activeThreadId }))

          let turnInput = toCodexAppServerInput(staged.input)
          let baselineSpend: number | null = prior === undefined ? 0 : null
          let latestSpend = baselineSpend ?? 0
          if (prior !== undefined) {
            const resumedThreadId = activeThreadId
            // `thread/resume` replays its last token reading after its response.
            // The response and notification may arrive in separate stdout chunks,
            // so use a bounded protocol wait rather than an event-loop tick.
            const replayState = makeCodexAppServerEventState()
            let replayUsageSeen = false
            let replayRequiresCompaction = false
            const consumeReplay = async (message: JsonRpcMessage): Promise<void> => {
              for (const event of codexAppServerMessageToStreamEvents(
                message,
                resumedThreadId,
                replayState
              )) {
                await runP(ctx.emit(event))
              }
              const cumulative = cumulativeUsage(message, resumedThreadId)
              if (cumulative !== null) {
                replayUsageSeen = true
                if (baselineSpend === null) baselineSpend = cumulative
                latestSpend = cumulative
              }
              const ratio = usageRatio(message, resumedThreadId)
              if (ratio !== null) replayUsageSeen = true
              if (ratio !== null && ratio >= 0.75) replayRequiresCompaction = true
            }
            for (const message of connection.drainMessages()) {
              await consumeReplay(message)
            }
            const replayDeadline = Date.now() + RESUME_REPLAY_WAIT_MS
            while (!replayUsageSeen) {
              const remaining = replayDeadline - Date.now()
              if (remaining <= 0) break
              const message = await connection.nextMessageWithin(remaining)
              if (message === null) break
              await consumeReplay(message)
            }
            if (replayRequiresCompaction) {
              await connection
                .request("thread/compact/start", { threadId: resumedThreadId })
                .catch(() => undefined)
            }
          }
          let questionRound = 0
          let planRound = 0
          for (;;) {
            const state = makeCodexAppServerEventState()
            let followUp: string | null = null
            let emergencyCompactRequested = false
            const turnResponse = await connection.request("turn/start", {
              threadId: activeThreadId,
              input: turnInput,
              cwd,
              ...(spec.model ? { model: spec.model } : {}),
              ...(mapCodexAppServerReasoning(spec.reasoningEffort)
                ? { effort: mapCodexAppServerReasoning(spec.reasoningEffort) }
                : {})
            })
            activeTurnId = turnIdFromResponse(turnResponse)
            if (activeTurnId === null) {
              throw new Error("Codex app-server returned no turn id")
            }

            let terminal: ReturnType<typeof completedTurn> = null
            while (terminal === null) {
              if (abort.signal.aborted) throw new Error("Codex run interrupted")
              const message = await connection.nextMessage()
              if (message === null) throw new Error("Codex app-server closed during the turn")
              if (await handleServerRequest(connection, message, ctx, runP, sessionId)) {
                continue
              }

              const reply = followUp === null ? completedAgentReply(message) : null
              const asked =
                reply !== null && questionRound < MAX_QUESTION_ROUNDS
                  ? parseQuestionBlock(reply)
                  : null
              if (asked !== null) {
                if (asked.stripped.length > 0) {
                  await runP(ctx.emit({ _tag: "Assistant", text: asked.stripped }))
                }
                const answers = await runP(
                  ctx.askQuestion({
                    id: `q_${sessionId}_${questionRound}`,
                    questions: asked.questions
                  })
                )
                questionRound += 1
                followUp = formatQuestionAnswers(asked.questions, answers)
                continue
              }

              const proposed =
                reply !== null &&
                spec.mode === "plan" &&
                planRound < MAX_PLAN_ROUNDS &&
                hasPlanBlock(reply)
                  ? reply
                  : null
              if (proposed !== null) {
                planRound += 1
                const plan = parsePlan(proposed, `plan_${sessionId}_${planRound}`)
                const decision = await runP(ctx.proposePlan(plan))
                if (decision._tag === "Revise") {
                  followUp = decision.feedback
                } else if (decision._tag === "Approve") {
                  activePolicy = policy(
                    decision.mode,
                    spec.readOnly ?? false,
                    spec.unattended ?? false
                  )
                  await connection.request("thread/resume", {
                    threadId: activeThreadId,
                    cwd,
                    ...(spec.model ? { model: spec.model } : {}),
                    sandbox: activePolicy.sandbox,
                    approvalPolicy: activePolicy.approvalPolicy
                  })
                  followUp = resumePlanPrompt(plan)
                }
                continue
              }

              for (const event of codexAppServerMessageToStreamEvents(
                message,
                activeThreadId,
                state
              )) {
                await runP(ctx.emit(event))
              }

              const cumulative = cumulativeUsage(message, activeThreadId)
              if (cumulative !== null) {
                if (baselineSpend === null) baselineSpend = cumulative
                latestSpend = cumulative
              }
              const ratio = usageRatio(message, activeThreadId)
              if (
                ratio !== null &&
                ratio >= EMERGENCY_COMPACTION_RATIO &&
                !emergencyCompactRequested
              ) {
                emergencyCompactRequested = true
                await connection
                  .request("thread/compact/start", { threadId: activeThreadId })
                  .catch(() => undefined)
              }
              const completed = completedTurn(message, activeThreadId)
              terminal =
                completed?.turnId === activeTurnId ? completed : null
            }

            activeTurnId = null
            if (terminal.status === "failed") {
              await runP(
                ctx.emit({
                  _tag: "Failed",
                  message: terminal.error ?? "Codex turn failed"
                })
              )
              break
            }
            if (followUp === null) {
              await runP(
                ctx.emit({
                  _tag: "Done",
                  costUsd: 0,
                  tokens: Math.max(0, latestSpend - (baselineSpend ?? latestSpend))
                })
              )
              break
            }
            turnInput = [{ type: "text", text: followUp, text_elements: [] }]
          }
        } finally {
          await staged.cleanup()
          connection.close()
        }
      },
      catch: (cause) =>
        new CliExecError({
          kind: spec.cli,
          message: cause instanceof Error ? cause.message : String(cause)
        })
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          abort.abort()
          if (
            connection !== null &&
            activeThreadId !== null &&
            activeTurnId !== null
          ) {
            await connection
              .request("turn/interrupt", {
                threadId: activeThreadId,
                turnId: activeTurnId
              })
              .catch(() => undefined)
          }
          connection?.close()
        })
      )
    )
  })
