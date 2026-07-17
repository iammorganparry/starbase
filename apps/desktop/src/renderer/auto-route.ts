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
 *     (up to a minute), and its `combine` hands back a fresh array identity on
 *     every render, so the routing effect re-fires with the stale object. A
 *     guard released once the first call finished would let that re-send.
 *
 * Hence: released only when routing FAILED, so a genuine failure still retries on
 * the next tick, while success is remembered for the life of the renderer. The
 * persisted `routedAt` covers the third case — a reload — where this is empty.
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
 * never asked for. The cost of losing one is that the batch may be re-sent on the
 * next tick, which is the safe direction — the agent is idempotent about being
 * told twice, whereas silently never routing is invisible.
 */
export const routeReviewToAgent = async (
  session: Session,
  review: AdversarialReview,
  qc: QueryClient
): Promise<void> => {
  // Already routed for this head — the whole point of persisting the stamp.
  if (review.routedAt !== null) return

  const guard = `${session.id}:${review.headSha}`
  if (claimed.has(guard)) return
  claimed.add(guard)

  try {
    const { toAgent } = partitionFindings(review.findings)

    if (toAgent.length > 0) {
      getConversationActor(session).send({ type: "SEND", text: agentBatchPrompt(toAgent) })
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
    // Release the claim ONLY here. Not in a `finally`: on success the claim must
    // outlive the call, or a re-render holding a stale `routedAt: null` review
    // re-sends the batch (see `claimed`). Releasing on failure is what keeps a
    // genuine failure retryable on the next tick.
    claimed.delete(guard)
  }
}
