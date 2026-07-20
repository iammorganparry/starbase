import type { QueryClient } from "@tanstack/react-query"
import type { AdversarialReview, Session } from "@starbase/core"
import { partitionFindings } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { markRouted } from "./routed-store.js"
import { agentBatchPrompt, reviewQueryKey, routedKey } from "./review-routing.js"

/**
 * Handing a finished review's critical/major findings to the session's agent,
 * automatically and exactly once per PR head.
 *
 * **Why the renderer and not main.** Routing goes through the session's
 * persistent conversation actor — the same path the composer uses — so the
 * agent's work and any approval gates land in the Conversation tab. A main-side
 * `agentRun` would spawn a parallel agent whose output reached no conversation
 * and whose gates rendered nowhere. Main can't reach the actor, so main posts to
 * the PR and the renderer routes to the agent.
 */

/**
 * Heads this renderer has claimed for routing, keyed by `sessionId:headSha`.
 *
 * Claimed BEFORE the send and released ONLY on failure, which is what makes it
 * cover two different races with one mechanism:
 *
 *  1. **Same tick.** `routeReviewToAgent` is called from effects, and the
 *     `routedAt` it checks only flips after an await. The Pull Request tab and
 *     the Code Review tab mounted on one session — or StrictMode double-invoking
 *     — would both see `routedAt: null` and both send.
 *  2. **A stale review object, minutes later.** The stamp is written with
 *     `setQueryData(reviewQueryKey(id))`, but App.tsx's auto-review poll caches
 *     its own copy under `["auto-review", id, prNumber]` — a DIFFERENT key that
 *     nothing backfills. That copy keeps `routedAt: null` until its next refetch
 *     (up to a minute), and TWO independent things re-fire the routing effect
 *     inside that window: its `combine` hands back a fresh array identity on
 *     every run, and the effect also depends on `sessions`, whose identity
 *     changes on every `SESSION_UPDATED`.
 *
 *     That second trigger is what makes this more than a one-off. A routed turn
 *     completing persists the session's settled status → `SESSION_UPDATED` →
 *     new `sessions` identity → the effect re-fires with the same stale
 *     `routedAt: null` review → another send, whose completion updates the
 *     session again. A guard released once the first call finished would leave
 *     that loop running until the next auto-review refetch closed it.
 *
 * Hence: claimed for the life of the renderer once the batch is away, and
 * released only when a failure dispatched NOTHING (see the catch). The persisted
 * `routedAt` covers the remaining case — a reload — where this set is empty.
 */
const claimed = new Set<string>()

/**
 * Route `review`'s critical/major findings to `session`'s agent, if they haven't
 * been already.
 *
 * Safe to call on every render and for every session — it is a no-op unless the
 * review is unrouted, which is what lets the auto-review poll fire it naively.
 *
 * Failures are swallowed deliberately. This runs on a timer with nobody's finger
 * on a button; a toast for a failed stamp would be noise about a thing the user
 * never asked for. What a failure must NOT do is re-send: a duplicate is a second
 * agent turn against the same worktree, editing the same files — so the retry is
 * scoped to failures that dispatched nothing (see the catch).
 */
export const routeReviewToAgent = async (
  session: Session,
  review: AdversarialReview,
  qc: QueryClient
): Promise<void> => {
  /**
   * The review must belong to the session it is about to be sent to.
   *
   * `session` and `review` arrive as independent arguments, so nothing in the
   * type system stops a caller pairing them wrongly — and one did: App.tsx zipped
   * sessions to review results by array index, and archiving a session shifted
   * that mapping by one. The cost of the mistake is not a bad render, it is an
   * irreversible agent turn against the wrong worktree, editing files on a branch
   * the findings never described.
   *
   * Cheap, total, and checked BEFORE the claim is staked, so a mispaired call
   * neither sends nor burns the guard key for the legitimate pairing.
   */
  if (review.sessionId !== session.id) return

  // Already routed for this head — the whole point of persisting the stamp.
  if (review.routedAt !== null) return

  const guard = `${session.id}:${review.headSha}`
  if (claimed.has(guard)) return
  claimed.add(guard)

  /**
   * Whether the batch actually reached the agent.
   *
   * The send is the irreversible half of this function and it happens BEFORE the
   * awaited stamp. Everything after it is bookkeeping, so a failure past this
   * point must not be treated as "nothing happened, try again".
   */
  let sent = false

  try {
    const { toAgent } = partitionFindings(review.findings)

    if (toAgent.length > 0) {
      getConversationActor(session).send({ type: "SEND", text: agentBatchPrompt(toAgent) })
      sent = true
      // Latch each finding's UI state. Namespaced by head SHA — finding ids are
      // positional (`f1`, `f2`), so a bare id would make the NEXT review's `f1`
      // render as already-sent the moment it arrived.
      for (const finding of toAgent) {
        markRouted(session.id, routedKey(review.headSha, finding.id))
      }
    }

    // Stamped even when nothing routed. A review with only nits is a settled
    // review — leaving it unstamped would make this re-evaluate it on every
    // poll tick forever, and (worse) a later re-render could route findings
    // the user has already seen resolved.
    const routedAt = await rpc.reviewMarkRouted(session.id)
    if (routedAt !== null) {
      qc.setQueryData(reviewQueryKey(session.id), { ...review, routedAt })
    }
  } catch {
    /**
     * Release the claim ONLY when nothing reached the agent.
     *
     * Never in a `finally`: on success the claim must outlive the call, or a
     * re-render holding a stale `routedAt: null` review re-sends the batch (see
     * `claimed`).
     *
     * And not on EVERY failure either — which is the subtle half. The throw we
     * can actually expect here is `rpc.reviewMarkRouted`, and by then the batch
     * is already with the agent. Releasing would "retry" the send, not the
     * stamp: a second full agent turn against the same worktree, which is the
     * exact harm this guard exists to prevent. Keeping the claim costs at most
     * one re-send after a reload (the stamp never persisted); releasing it costs
     * a guaranteed duplicate on the very next tick.
     *
     * So a failed stamp keeps the claim, and only a pre-send failure — nothing
     * dispatched, nothing to duplicate — is retryable.
     */
    if (!sent) claimed.delete(guard)
  }
}
