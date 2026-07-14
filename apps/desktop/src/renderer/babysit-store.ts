/**
 * Idempotency guard for auto-babysitting a session's PR. When a run completes and
 * the app links a PR (App.tsx on-completion effect), it injects a one-shot
 * "babysit" turn that drives the PR to green. That babysit turn is itself a run
 * whose completion re-fires PR detection — so without a guard it would re-inject
 * babysit forever. We record which `${sessionId}:${prNumber}` pairs have already
 * been babysat and never fire twice for the same PR.
 *
 * A plain module Set (no React reactivity): nothing renders off this — it only
 * gates a side effect. `shouldBabysit` is a pure predicate so it's unit-testable.
 */
import type { Session } from "@starbase/core"

const babysat = new Set<string>()

const key = (sessionId: string, prNumber: number): string => `${sessionId}:${prNumber}`

/** True once this session's PR has had a babysit turn injected. */
export const wasBabysat = (sessionId: string, prNumber: number): boolean =>
  babysat.has(key(sessionId, prNumber))

/** Record that this session's PR has been babysat, so we never re-inject it. */
export const markBabysat = (sessionId: string, prNumber: number): void => {
  babysat.add(key(sessionId, prNumber))
}

/** Test-only: clear the record. */
export const resetBabysat = (): void => babysat.clear()

/**
 * Whether to inject a babysit turn for a freshly-linked PR: the setting is on
 * (default), GitHub is connected, the session isn't archived, and we haven't
 * already babysat this exact PR. Pure — the caller marks + injects on `true`.
 */
export const shouldBabysit = (input: {
  session: Session
  prNumber: number
  autoBabysitPr: boolean
  connected: boolean
}): boolean => {
  const { session, prNumber, autoBabysitPr, connected } = input
  return (
    autoBabysitPr &&
    connected &&
    !session.archived &&
    !wasBabysat(session.id, prNumber)
  )
}
