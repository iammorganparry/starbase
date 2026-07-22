import { CliExecError } from "@starbase/core"

export type RouteFailureClassification =
  | "transient-provider"
  | "terminal-operator"
  | "terminal-execution"

export interface RouteFailure {
  readonly classification: RouteFailureClassification
  readonly message: string
  readonly kind: string | null
}

const TRANSIENT = [
  /\b429\b/i,
  /rate[ -]?limit/i,
  /too many requests/i,
  /overload/i,
  /capacity/i,
  /temporar(?:y|ily) unavailable/i,
  /service unavailable/i,
  /gateway timeout/i,
  /timed? out/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /network (?:error|failure)/i,
  /connection (?:reset|closed|failed)/i,
  /model (?:is )?(?:not found|unavailable|not deployed)/i,
  /deployment (?:is )?(?:missing|not found|unavailable)/i,
  /provider unavailable/i
]

const OPERATOR = [
  /auth(?:entication|orization)? failed/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /permission denied/i,
  /missing (?:api )?key/i,
  /api key/i,
  /credential/i,
  /sign in/i,
  /log in/i,
  /login/i,
  /user decision/i,
  /requires? approval/i,
  /invalid plan/i,
  /invalid request/i
]

const messageOf = (failure: unknown): { readonly message: string; readonly kind: string | null } => {
  if (failure instanceof CliExecError) return { message: failure.message, kind: failure.kind }
  if (failure instanceof Error) return { message: failure.message, kind: failure.name }
  if (typeof failure === "string") return { message: failure, kind: null }
  return { message: "The harness failed without an actionable error.", kind: null }
}

/** Conservative and deterministic: unknown failures never change providers. */
export const classifyProviderFailure = (failure: unknown): RouteFailure => {
  const normalized = messageOf(failure)
  if (OPERATOR.some((pattern) => pattern.test(normalized.message))) {
    return { ...normalized, classification: "terminal-operator" }
  }
  if (TRANSIENT.some((pattern) => pattern.test(normalized.message))) {
    return { ...normalized, classification: "transient-provider" }
  }
  return { ...normalized, classification: "terminal-execution" }
}

/**
 * A tool start can precede a crash, so the absence of a ToolEnd diff is not
 * evidence that nothing changed. Only a small read-only allowlist is safe;
 * shells and unknown tools are mutation-capable.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "find",
  "websearch",
  "webfetch",
  "todowrite",
  "todoread"
])

export const toolMayMutate = (name: string): boolean =>
  !READ_ONLY_TOOLS.has(name.replace(/[\s_-]/g, "").toLowerCase())
