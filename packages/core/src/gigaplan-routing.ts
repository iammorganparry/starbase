import type { CliKind } from "./domain.js"
import type {
  Plan,
  PlanStep,
  PlanStepAssignee,
  PlanStepRouting,
  RouteCandidate,
  RouteDecision,
  RouteEffort,
  RouteProvenance,
  RouteRejection,
  RouteRisk
} from "./conversation.js"
import type { ProviderModels } from "./models.js"
import type { TaskKind } from "./task-kind.js"
import type { ProviderUsage, Usage, UsageWindow } from "./usage.js"

/** Bump whenever profile order or route eligibility changes. */
export const GIGAPLAN_ROUTING_POLICY_VERSION = "gigaplan-routing-v3"

export type RoutingMode = "shadow" | "active"

export interface RouteOverride {
  readonly taskKind: TaskKind
  readonly routes: ReadonlyArray<RouteCandidate>
}

/** Evidence is accepted only when both gates pass; it is non-controlling by default. */
export interface RouteAffinity {
  readonly candidate: RouteCandidate
  readonly taskKind: TaskKind
  readonly observations: number
  readonly confidence: number
  readonly score: number
}

export interface RoutingContext {
  readonly catalog: ReadonlyArray<ProviderModels>
  readonly mode?: RoutingMode
  readonly overrides?: ReadonlyArray<RouteOverride>
  readonly systemDefault?: RouteCandidate | null
  readonly ranking?: RoutingRankingSnapshot | null
  /** Fresh local harness limits; absent/unavailable data deliberately fails open. */
  readonly usage?: Usage | null
  readonly affinity?: ReadonlyArray<RouteAffinity>
  readonly affinityEnabled?: boolean
  readonly minimumAffinityObservations?: number
  readonly minimumAffinityConfidence?: number
}

export interface RoutingRankingModel {
  readonly model: string
  readonly scores: Readonly<Partial<Record<TaskKind, number>>>
}

/** Immutable input fetched outside core; the resolver remains pure and replayable. */
export interface RoutingRankingSnapshot {
  readonly source: string
  readonly windowDays: number
  readonly fetchedAt: string
  readonly models: ReadonlyArray<RoutingRankingModel>
}

export interface UnresolvedRoute {
  readonly stepId: string
  readonly stepNumber: string
  readonly reason: string
  readonly rejected: ReadonlyArray<RouteRejection>
}

export interface PlanRouteResolution {
  readonly plan: Plan
  readonly unresolved: ReadonlyArray<UnresolvedRoute>
}

export interface RouteAttemptSummary {
  readonly routedSteps: number
  readonly attempts: number
  readonly divergences: number
  readonly blocked: number
  readonly failed: number
  readonly completed: number
}

interface CandidateEntry {
  readonly candidate: RouteCandidate
  readonly provenance: RouteProvenance
  readonly reason: string
}

export type RouteQuotaStatus = "ok" | "nearing" | "limited" | "unknown"

const CLI_ORDER: ReadonlyArray<CliKind> = ["claude", "codex", "opencode", "cursor", "starbase"]

/**
 * Starbase-owned, deliberately small domain profile. It names harness families,
 * not upstream model ids, so live discovery remains authoritative.
 */
const TASK_CLI_ORDER: Readonly<Record<TaskKind, ReadonlyArray<CliKind>>> = {
  frontend: ["claude", "codex", "opencode"],
  backend: ["codex", "claude", "opencode"],
  schema: ["codex", "claude", "opencode"],
  tests: ["codex", "claude", "opencode"],
  refactor: ["codex", "claude", "opencode"],
  infra: ["codex", "claude", "opencode"],
  docs: ["claude", "codex", "opencode"],
  review: ["claude", "codex", "opencode"]
}

const candidateKey = (candidate: RouteCandidate): string =>
  `${candidate.cli}\u0000${candidate.model}`

const sameCandidate = (left: RouteCandidate, right: RouteCandidate): boolean =>
  left.cli === right.cli && left.model === right.model

const normalizedQuotaScope = (window: UsageWindow): string | null => {
  const separator = window.label.indexOf("·")
  if (separator === -1) return null
  const scope = normalizedModel(window.label.slice(separator + 1))
  return scope.length === 0 || scope === "all-models" ? null : scope
}

const quotaWindowApplies = (
  candidate: RouteCandidate,
  provider: ProviderUsage,
  window: UsageWindow
): boolean => {
  const scope = normalizedQuotaScope(window)
  if (scope === null || scope === normalizedModel(provider.name) || scope === provider.cli) {
    return true
  }
  const modelTokens = routeModelTail(candidate).split("-")
  return containsEveryToken(modelTokens, scope.split("-"))
}

/**
 * The strongest applicable local limit for one exact route.
 *
 * Provider data is allowed to be absent: usage APIs are best-effort, so unknown
 * must never make a live catalogue route disappear. Model-scoped windows such
 * as "Weekly · Opus" affect Opus without needlessly suppressing Sonnet.
 */
export const routeQuotaStatus = (
  candidate: RouteCandidate,
  usage: Usage | null | undefined
): RouteQuotaStatus => {
  const provider = usage?.providers.find((item) => item.cli === candidate.cli)
  if (provider === undefined || !provider.available) return "unknown"
  const windows = provider.windows.filter((window) =>
    quotaWindowApplies(candidate, provider, window)
  )
  if (windows.some((window) => window.status === "limited")) return "limited"
  if (windows.some((window) => window.status === "nearing")) return "nearing"
  if (windows.some((window) => window.status === "ok")) return "ok"
  return "unknown"
}

const uniqueEntries = (entries: ReadonlyArray<CandidateEntry>): ReadonlyArray<CandidateEntry> => {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = candidateKey(entry.candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Stable regardless of provider response or object insertion order. */
export const canonicalRouteCandidates = (
  catalog: ReadonlyArray<ProviderModels>
): ReadonlyArray<RouteCandidate> =>
  catalog
    .flatMap((provider) =>
      provider.models.map((model): RouteCandidate => ({
        cli: provider.cli,
        model: model.id
      }))
    )
    // `starbase` re-enters the orchestrator; cursor has no real headless adapter.
    .filter((candidate) => candidate.cli !== "starbase" && candidate.cli !== "cursor")
    .sort((left, right) => {
      const cli = CLI_ORDER.indexOf(left.cli) - CLI_ORDER.indexOf(right.cli)
      return cli === 0 ? left.model.localeCompare(right.model) : cli
    })
    .filter(
      (candidate, index, all) =>
        index === 0 || candidateKey(candidate) !== candidateKey(all[index - 1]!)
    )

const rejected = (
  candidate: RouteCandidate,
  provenance: RouteProvenance,
  reason: string
): RouteRejection => ({ candidate, provenance, reason })

const eligibleEntries = (
  entries: ReadonlyArray<CandidateEntry>,
  live: ReadonlySet<string>,
  rejections: Array<RouteRejection>
): ReadonlyArray<CandidateEntry> =>
  uniqueEntries(entries).filter((entry) => {
    if (live.has(candidateKey(entry.candidate))) return true
    rejections.push(rejected(entry.candidate, entry.provenance, "not in the live model catalogue"))
    return false
  })

const quotaEligibleEntries = (
  entries: ReadonlyArray<CandidateEntry>,
  usage: Usage | null,
  rejections: Array<RouteRejection>
): ReadonlyArray<CandidateEntry> =>
  uniqueEntries(entries).filter((entry) => {
    if (routeQuotaStatus(entry.candidate, usage) !== "limited") return true
    rejections.push(
      rejected(entry.candidate, entry.provenance, "local provider usage is at its limit")
    )
    return false
  })

/** Stable partition: unknown data fails open; only a known nearing limit moves back. */
const preferQuotaHeadroom = (
  entries: ReadonlyArray<CandidateEntry>,
  usage: Usage | null
): ReadonlyArray<CandidateEntry> => {
  const unique = uniqueEntries(entries)
  return [
    ...unique.filter((entry) => routeQuotaStatus(entry.candidate, usage) !== "nearing"),
    ...unique.filter((entry) => routeQuotaStatus(entry.candidate, usage) === "nearing")
  ]
}

const plannerEntry = (assignee: PlanStepAssignee | undefined): CandidateEntry | null =>
  assignee === undefined
    ? null
    : {
        candidate: { cli: assignee.cli, model: assignee.model },
        provenance: "planner-preference",
        reason: assignee.reason || "the planner preferred this route"
      }

const overrideEntries = (
  taskKind: TaskKind,
  overrides: ReadonlyArray<RouteOverride>
): ReadonlyArray<CandidateEntry> =>
  overrides
    .filter((override) => override.taskKind === taskKind)
    .flatMap((override) =>
      override.routes.map((candidate): CandidateEntry => ({
        candidate,
        provenance: "user-override",
        reason: `workspace override for ${taskKind} work`
      }))
    )

const affinityEntries = (
  taskKind: TaskKind,
  context: RoutingContext
): ReadonlyArray<CandidateEntry> => {
  if (context.affinityEnabled !== true) return []
  const observations = context.minimumAffinityObservations ?? 5
  const confidence = context.minimumAffinityConfidence ?? 0.8
  return (context.affinity ?? [])
    .filter(
      (item) =>
        item.taskKind === taskKind &&
        item.observations >= observations &&
        item.confidence >= confidence
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        candidateKey(left.candidate).localeCompare(candidateKey(right.candidate))
    )
    .map((item): CandidateEntry => ({
      candidate: item.candidate,
      provenance: "affinity",
      reason: `${item.observations} observations at ${Math.round(item.confidence * 100)}% confidence`
    }))
}

const normalizedModel = (model: string): string =>
  model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const routeModelTail = (candidate: RouteCandidate): string => {
  const segments = candidate.model.split("/").filter((segment) => segment.length > 0)
  return normalizedModel(segments[segments.length - 1] ?? candidate.model)
}

const containsEveryToken = (
  available: ReadonlyArray<string>,
  required: ReadonlyArray<string>
): boolean => {
  const remaining = [...available]
  return required.every((token) => {
    const index = remaining.indexOf(token)
    if (index === -1) return false
    remaining.splice(index, 1)
    return true
  })
}

const rankingMatchQuality = (candidate: RouteCandidate, rankedModel: string): number => {
  const route = routeModelTail(candidate)
  const rankedSegments = rankedModel.split("/").filter((segment) => segment.length > 0)
  const ranked = normalizedModel(rankedSegments[rankedSegments.length - 1] ?? rankedModel)
  if (route === ranked) return 3
  if (route.length >= 5 && ranked.startsWith(`${route}-`)) return 2
  const routeTokens = route.split("-")
  const rankedTokens = ranked.split("-")
  if (routeTokens.length >= 3 && containsEveryToken(rankedTokens, routeTokens)) return 2
  if (
    candidate.cli === "claude" &&
    ["opus", "sonnet", "haiku"].includes(route) &&
    rankedTokens.includes(route)
  ) {
    return 1
  }
  return 0
}

const modelNumbers = (model: string): ReadonlyArray<number> =>
  normalizedModel(model)
    .split("-")
    .map((part) => Number(part))
    .filter(Number.isFinite)

const compareModelFreshness = (left: string, right: string): number => {
  const a = modelNumbers(left)
  const b = modelNumbers(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (b[index] ?? -1) - (a[index] ?? -1)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

const taskRankingScore = (taskKind: TaskKind, model: RoutingRankingModel): number | null => {
  const score = model.scores[taskKind]
  return score === undefined || !Number.isFinite(score) ? null : score
}

const rankingEntries = (
  taskKind: TaskKind,
  canonical: ReadonlyArray<RouteCandidate>,
  snapshot: RoutingRankingSnapshot | null
): ReadonlyArray<CandidateEntry> => {
  if (snapshot === null) return []
  return canonical
    .flatMap((candidate): ReadonlyArray<CandidateEntry & { readonly score: number }> => {
      const matched = snapshot.models
        .map((model) => ({
          model,
          quality: rankingMatchQuality(candidate, model.model),
          score: taskRankingScore(taskKind, model)
        }))
        .filter(
          (item): item is { model: RoutingRankingModel; quality: number; score: number } =>
            item.quality > 0 && item.score !== null
        )
        .sort(
          (left, right) =>
            right.quality - left.quality ||
            compareModelFreshness(left.model.model, right.model.model) ||
            right.score - left.score
        )[0]
      if (matched === undefined) return []
      return [
        {
          candidate,
          provenance: "runtime-ranking",
          reason:
            `${snapshot.source} ${snapshot.windowDays}-day ${taskKind} usage at ` +
            `${snapshot.fetchedAt.slice(0, 10)}; share ` +
            `${(matched.score * 100).toFixed(1)}%; matched ${matched.model.model}`,
          score: matched.score
        }
      ]
    })
    .sort(
      (left, right) =>
        right.score - left.score || candidateKey(left.candidate).localeCompare(candidateKey(right.candidate))
    )
}

const profileEntries = (
  taskKind: TaskKind,
  effort: RouteEffort,
  risk: RouteRisk,
  canonical: ReadonlyArray<RouteCandidate>,
  systemDefault: RouteCandidate | null
): ReadonlyArray<CandidateEntry> => {
  const byDomain = TASK_CLI_ORDER[taskKind].flatMap((cli) =>
    canonical
      .filter((candidate) => candidate.cli === cli)
      .map((candidate): CandidateEntry => ({
        candidate,
        provenance: "policy-profile",
        reason: `${taskKind} · ${effort} effort · ${risk} risk profile`
      }))
  )
  // The configured orchestrator is documented as a flagship. Deep or high-risk
  // work may prefer it, but only when it is an exact live candidate.
  if ((effort === "deep" || risk === "high") && systemDefault !== null) {
    return [
      {
        candidate: systemDefault,
        provenance: "policy-profile",
        reason: `${effort === "deep" ? "deep" : "high-risk"} work prefers the configured flagship`
      },
      ...byDomain
    ]
  }
  return byDomain
}

const systemEntries = (
  canonical: ReadonlyArray<RouteCandidate>,
  configured: RouteCandidate | null
): ReadonlyArray<CandidateEntry> => {
  const preferred = configured === null ? [] : [configured]
  return [...preferred, ...canonical].map((candidate): CandidateEntry => ({
    candidate,
    provenance: "system-default",
    reason:
      configured !== null && sameCandidate(candidate, configured)
        ? "configured Gigaplan orchestrator"
        : "first live candidate in canonical order"
  }))
}

const decisionFrom = (
  entries: ReadonlyArray<CandidateEntry>,
  selectedIndex = 0
): RouteDecision | null => {
  const selected = entries[selectedIndex]
  if (selected === undefined) return null
  return {
    ...selected.candidate,
    provenance: selected.provenance,
    reason: selected.reason,
    alternatives: entries
      .filter((_, index) => index !== selectedIndex)
      .map((entry) => entry.candidate)
  }
}

const routeStep = (
  step: PlanStep,
  context: RoutingContext
): {
  readonly routing: PlanStepRouting | null
  readonly rejected: ReadonlyArray<RouteRejection>
} => {
  const taskKind = step.taskKind ?? "backend"
  const effort = step.effort ?? "standard"
  const risk = step.risk ?? "medium"
  const mode = context.mode ?? "shadow"
  const canonical = canonicalRouteCandidates(context.catalog)
  const live = new Set(canonical.map(candidateKey))
  const rejections: Array<RouteRejection> = []
  const systemDefault = context.systemDefault ?? null
  const usage = context.usage ?? null

  const overrides = quotaEligibleEntries(
    eligibleEntries(overrideEntries(taskKind, context.overrides ?? []), live, rejections),
    usage,
    rejections
  )
  const planner = plannerEntry(step.assignee)
  const plannerCandidates = quotaEligibleEntries(
    eligibleEntries(planner === null ? [] : [planner], live, rejections),
    usage,
    rejections
  )
  const rankings = quotaEligibleEntries(
    eligibleEntries(
      rankingEntries(taskKind, canonical, context.ranking ?? null),
      live,
      rejections
    ),
    usage,
    rejections
  )
  const affinities = quotaEligibleEntries(
    eligibleEntries(affinityEntries(taskKind, context), live, rejections),
    usage,
    rejections
  )
  const profiles = quotaEligibleEntries(
    eligibleEntries(
      profileEntries(taskKind, effort, risk, canonical, systemDefault),
      live,
      rejections
    ),
    usage,
    rejections
  )
  const defaults = quotaEligibleEntries(
    eligibleEntries(systemEntries(canonical, systemDefault), live, rejections),
    usage,
    rejections
  )

  // Shadow deliberately excludes the prompt-authored preference: it is the
  // counterfactual semantic route we want to compare with legacy behaviour.
  const semantic = uniqueEntries([
    ...overrides,
    ...preferQuotaHeadroom([...rankings, ...affinities, ...profiles, ...defaults], usage)
  ])
  const semanticDecision = decisionFrom(semantic)

  const effectiveEntries =
    mode === "shadow"
      ? uniqueEntries([...plannerCandidates, ...defaults])
      : uniqueEntries([
          ...overrides,
          ...preferQuotaHeadroom(
            [...rankings, ...plannerCandidates, ...affinities, ...profiles, ...defaults],
            usage
          )
        ])
  const decision = decisionFrom(effectiveEntries)
  if (decision === null) return { routing: null, rejected: rejections }

  return {
    routing: {
      effort,
      risk,
      policyVersion: GIGAPLAN_ROUTING_POLICY_VERSION,
      mode,
      decision,
      ...(mode === "shadow" && semanticDecision !== null
        ? { shadowDecision: semanticDecision }
        : {}),
      rejected: rejections,
      attempts: []
    },
    rejected: rejections
  }
}

/** Normalize every runnable step without I/O or ambient state. */
export const resolvePlanRoutes = (plan: Plan, context: RoutingContext): PlanRouteResolution => {
  const unresolved: Array<UnresolvedRoute> = []
  const steps = plan.steps.map((step): PlanStep => {
    if (step.kind !== "step") return step
    const taskKind = step.taskKind ?? "backend"
    const effort = step.effort ?? "standard"
    const risk = step.risk ?? "medium"
    const result = routeStep(step, context)
    if (result.routing === null) {
      unresolved.push({
        stepId: step.id,
        stepNumber: step.number,
        reason: "no live model can run this step",
        rejected: result.rejected
      })
      return { ...step, taskKind, effort, risk }
    }
    return { ...step, taskKind, effort, risk, routing: result.routing }
  })
  return { plan: { ...plan, steps }, unresolved }
}

/** Local, anonymized rollout counters derived from the persisted plan itself. */
export const summarizeRouteAttempts = (plan: Plan): RouteAttemptSummary =>
  plan.steps.reduce<RouteAttemptSummary>(
    (summary, step) => {
      const routing = step.routing
      if (routing === undefined) return summary
      const divergences = routing.attempts.filter(
        (attempt) =>
          attempt.candidate.cli !== routing.decision.cli ||
          attempt.candidate.model !== routing.decision.model
      ).length
      return {
        routedSteps: summary.routedSteps + 1,
        attempts: summary.attempts + routing.attempts.length,
        divergences: summary.divergences + divergences,
        blocked:
          summary.blocked + routing.attempts.filter((attempt) => attempt.outcome === "blocked").length,
        failed:
          summary.failed + routing.attempts.filter((attempt) => attempt.outcome === "failed").length,
        completed:
          summary.completed + (routing.attempts.some((attempt) => attempt.outcome === "done") ? 1 : 0)
      }
    },
    { routedSteps: 0, attempts: 0, divergences: 0, blocked: 0, failed: 0, completed: 0 }
  )
