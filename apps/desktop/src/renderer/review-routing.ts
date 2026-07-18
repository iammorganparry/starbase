import type { AdversarialReview, ReviewFinding } from "@starbase/core"
import { findingLocation } from "@starbase/core"

/**
 * Which adversarial-review findings have been handed to the working agent, and
 * what we say to the agent when we hand them over.
 *
 * A standalone, dependency-free module on purpose. The logic belongs to
 * `use-adversarial-review`, but that hook imports the RPC client, which touches
 * `window` at module load — so importing it from a test drags the whole renderer
 * bridge into a Node process and throws `ReferenceError: window is not defined`.
 * Keeping the pure seam in its own file is how the renderer's other testable
 * logic lives here (`pr-refresh.ts`, `retitle-triggers.ts`). The impure half —
 * actually sending, and stamping the review — lives in `auto-route.ts`.
 */

/**
 * The react-query key a session's stored review lives under.
 *
 * One definition, because THREE places have to agree on it: the `useQuery` that
 * reads it (`use-adversarial-review`), the `setQueryData` that publishes an
 * auto-review result (`App.tsx`), and the `setQueryData` that stamps a review
 * routed (`auto-route`). They fail silently when they drift — a write to a key
 * nothing reads is not an error, it's a no-op, and the visible symptom is a card
 * stuck on "Sending…" while routing re-fires on every poll tick.
 *
 * Here rather than in either hook because `auto-route` and `use-adversarial-review`
 * import each other's neighbourhood; this module is the shared, dependency-free
 * seam both already reach for.
 */
export const reviewQueryKey = (sessionId: string) => ["review", sessionId] as const

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

/** One finding, as it appears in the batch handed to the agent. */
const findingBlock = (finding: ReviewFinding, index: number): string => {
  const where = findingLocation(finding)
  const head = `${index + 1}. [${finding.severity}]${where === null ? "" : ` \`${where}\``} — ${finding.title}`
  return finding.suggestion === null
    ? `${head}\n${finding.rationale}`
    : `${head}\n${finding.rationale}\nSuggested fix: ${finding.suggestion}`
}

/**
 * The single prompt carrying a review's whole critical/major batch to the agent.
 *
 * **One prompt, not one per finding.** Each send is a full agent turn against the
 * same worktree: N sends means N agents editing the same files concurrently,
 * racing each other and re-reading half-applied work. Batching also lets the
 * agent see the findings together, which matters when two of them are the same
 * bug reported from different angles.
 *
 * The "push back if the reviewer is wrong" clause is load-bearing now that this
 * is automatic. The reviewer is prompted to argue AGAINST the diff and to report
 * everything it finds including what it's unsure of — some of it is wrong. With a
 * human clicking Send, they were the filter. Nobody is now, so the instruction to
 * assess before acting is the only thing standing between a false positive and
 * an agent confidently "fixing" correct code.
 */
export const agentBatchPrompt = (findings: ReadonlyArray<ReviewFinding>): string =>
  [
    `An adversarial code review of this pull request raised ${findings.length} ` +
      `${findings.length === 1 ? "issue" : "issues"} it rated critical or major.`,
    "",
    "For each one: assess whether it is a real problem, and fix it if so. If you believe the",
    "reviewer is wrong, say why rather than changing the code — it was asked to argue against",
    "this diff and to report everything it found, so some findings will not hold up.",
    "",
    findings.map(findingBlock).join("\n\n")
  ].join("\n")
