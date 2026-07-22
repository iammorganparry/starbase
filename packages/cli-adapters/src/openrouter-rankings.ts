import type { RoutingRankingModel, RoutingRankingSnapshot, TaskKind } from "@starbase/core"
import { TASK_KINDS } from "@starbase/core"
import { Effect, Ref, Schema } from "effect"
import { isScriptedEnv } from "./scripted.js"

const OPENROUTER_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/task-spend"
const MAX_RESPONSE_BYTES = 2_000_000
const REQUEST_TIMEOUT_MS = 5_000
export const RANKING_SUCCESS_TTL_MS = 6 * 60 * 60 * 1_000
export const RANKING_FAILURE_TTL_MS = 5 * 60 * 1_000

const RankingResponse = Schema.parseJson(
  Schema.Struct({
    data: Schema.Struct({
      spend: Schema.Struct({
        windowDays: Schema.Number,
        tasks: Schema.Array(
          Schema.Struct({
            tag: Schema.String,
            spendShareOfTotal: Schema.Number,
            models: Schema.Array(
              Schema.Struct({
                model: Schema.String,
                share: Schema.Number
              })
            )
          })
        )
      })
    })
  })
)

const ROUTING_TAGS: Readonly<Record<TaskKind, ReadonlyArray<string>>> = {
  frontend: ["code:frontend_ui", "code:general_impl"],
  backend: ["code:general_impl", "code:sql_database", "agent:workflow_execution"],
  schema: ["code:sql_database", "data:transformation", "data:extraction"],
  tests: ["code:debugging", "code:general_impl", "agent:workflow_execution"],
  refactor: ["code:repo_scan", "code:general_impl", "code:debugging"],
  infra: ["code:devops_config", "code:shell_execution", "devops"],
  docs: ["content_writing", "summarization", "research_report"],
  review: ["code:review_security", "code:repo_scan", "security_audit"]
}

type RankingFetch = (input: string, init?: RequestInit) => Promise<Response>

const responseText = async (response: Response): Promise<string> => {
  if (!response.ok) throw new Error(`OpenRouter rankings request failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("OpenRouter rankings response exceeded the size limit")
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("OpenRouter rankings response exceeded the size limit")
  }
  return text
}

export const parseOpenRouterRankings = (json: string, fetchedAt: string): RoutingRankingSnapshot => {
  const response = Schema.decodeUnknownSync(RankingResponse)(json)
  const tasks = response.data.spend.tasks.filter(
    (task) =>
      Number.isFinite(task.spendShareOfTotal) &&
      task.spendShareOfTotal > 0 &&
      task.models.length > 0
  )
  const modelScores = new Map<string, Partial<Record<TaskKind, number>>>()
  for (const taskKind of TASK_KINDS) {
    const selected = tasks.filter((task) => ROUTING_TAGS[taskKind].includes(task.tag))
    const totalWeight = selected.reduce((total, task) => total + task.spendShareOfTotal, 0)
    if (totalWeight <= 0) continue
    const weighted = new Map<string, number>()
    for (const task of selected) {
      for (const model of task.models) {
        if (!Number.isFinite(model.share) || model.share < 0 || model.share > 1) continue
        weighted.set(
          model.model,
          (weighted.get(model.model) ?? 0) + model.share * task.spendShareOfTotal
        )
      }
    }
    for (const [model, total] of weighted) {
      const scores = modelScores.get(model) ?? {}
      scores[taskKind] = total / totalWeight
      modelScores.set(model, scores)
    }
  }
  const models: ReadonlyArray<RoutingRankingModel> = [...modelScores]
    .map(([model, scores]) => ({ model, scores }))
    .sort((left, right) => left.model.localeCompare(right.model))
  if (models.length === 0) throw new Error("OpenRouter rankings contain no routable model data")
  return {
    source: "OpenRouter Rankings",
    windowDays: response.data.spend.windowDays,
    fetchedAt,
    models
  }
}

export const fetchOpenRouterRankings = async (
  fetcher: RankingFetch = globalThis.fetch,
  now: Date = new Date()
): Promise<RoutingRankingSnapshot> => {
  const response = await fetcher(OPENROUTER_RANKINGS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  return parseOpenRouterRankings(await responseText(response), now.toISOString())
}

interface RankingCache {
  readonly value: RoutingRankingSnapshot | null
  readonly expiresAt: number
}

/** Best-effort runtime evidence: network or schema drift never blocks a plan. */
export class RankingService extends Effect.Service<RankingService>()("@starbase/RankingService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const cache = yield* Ref.make<RankingCache>({ value: null, expiresAt: 0 })
    const latest = Effect.gen(function* () {
      // The scripted adapter is the hermetic test/e2e contract: no real harness
      // and no incidental network requests from a planning round.
      if (isScriptedEnv()) return null
      const now = Date.now()
      const cached = yield* Ref.get(cache)
      if (now < cached.expiresAt) return cached.value
      const fetched = yield* Effect.tryPromise(() => fetchOpenRouterRankings()).pipe(
        Effect.orElseSucceed(() => null)
      )
      const value = fetched ?? cached.value
      yield* Ref.set(cache, {
        value,
        expiresAt: now + (fetched === null ? RANKING_FAILURE_TTL_MS : RANKING_SUCCESS_TTL_MS)
      })
      return value
    })
    return { latest }
  })
}) {}
