import type { AdversarialReview } from "@starbase/core"

/**
 * Which adversarial-review findings have been handed to the working agent.
 *
 * A standalone, dependency-free module on purpose. The logic belongs to
 * `use-adversarial-review`, but that hook imports the RPC client, which touches
 * `window` at module load — so importing it from a test drags the whole renderer
 * bridge into a Node process and throws `ReferenceError: window is not defined`.
 * Keeping the pure seam in its own file is how the renderer's other testable
 * logic lives here (`pr-refresh.ts`, `retitle-triggers.ts`).
 */

/**
 * The routed-store key for a finding.
 *
 * Namespaced by the reviewed head SHA because finding ids are only unique WITHIN
 * a review — they're positional (`f1`, `f2`, …). A bare id would make the next
 * review's `f1` render as already-sent the moment it arrived.
 */
export const routedKey = (headSha: string, findingId: string): string =>
  `review:${headSha}:${findingId}`

/** Stable empty set, so `resolveSentIds` keeps a stable identity when there's no review. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/**
 * The routed-store keys, resolved down to plain ids for `review`'s own findings.
 *
 * Both sets are `ReadonlySet<string>`, so the compiler cannot tell a key set from
 * an id set — handing the raw keys to the UI type-checks cleanly and silently
 * leaves every "Sent to agent" button un-latched. That is exactly what happened
 * once; the tests below pin it.
 */
export const resolveSentIds = (
  review: AdversarialReview | null,
  routedKeys: ReadonlySet<string>
): ReadonlySet<string> =>
  review === null
    ? EMPTY_IDS
    : new Set(
        review.findings
          .filter((f) => routedKeys.has(routedKey(review.headSha, f.id)))
          .map((f) => f.id)
      )
