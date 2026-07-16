/**
 * Renderer hook backing the adversarial review. react-query owns the stored-review
 * read and the run mutation; routing a finding to the working agent goes through
 * the session's persistent conversation actor (a normal turn), exactly as
 * `usePullRequest.sendEntryToAgent` does — so the agent's work and any approval
 * gates surface in the Conversation tab instead of a hidden run that stalls
 * forever with its gates rendered nowhere.
 */
import { useCallback, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AdversarialReview, ReviewFinding, Session } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { markRouted, useRoutedEntries } from "./routed-store.js"
import { resolveSentIds, routedKey } from "./review-routing.js"

const reviewKey = (sessionId: string) => ["review", sessionId] as const

/** Format a finding as the instruction handed to the session's agent. */
const findingPrompt = (finding: ReviewFinding): string => {
  const where =
    finding.path === null
      ? ""
      : ` in \`${finding.path}\`${finding.line === null ? "" : ` at line ${finding.line}`}`
  const fix = finding.suggestion === null ? "" : `\n\nSuggested fix: ${finding.suggestion}`
  return (
    `An adversarial code review raised a ${finding.severity} issue${where}:\n\n` +
    `${finding.title}\n\n${finding.rationale}${fix}\n\n` +
    `Please assess whether this is a real problem, and fix it if so. If you believe the ` +
    `reviewer is wrong, say why rather than changing the code.`
  )
}

export interface AdversarialReviewState {
  readonly review: AdversarialReview | null
  /** The stored review is still loading. */
  readonly loading: boolean
  /** A reviewer run is in flight. */
  readonly running: boolean
  /** The message from a failed run, or null. */
  readonly error: string | null
  /** Run a fresh review, ignoring the stored one for this head. */
  readonly runReview: () => Promise<void>
  /** Hand a finding to the session's agent to address. */
  readonly sendFindingToAgent: (findingId: string) => void
  /**
   * Ids of findings in the CURRENT review already routed to the agent (their
   * action stays "Sent"). Plain finding ids — the head-SHA namespacing that keeps
   * a new review's `f1` from inheriting the last one's "Sent" is this hook's
   * business, not the UI's.
   */
  readonly sentFindingIds: ReadonlySet<string>
}

export function useAdversarialReview(
  session: Session,
  opts: { connected: boolean }
): AdversarialReviewState {
  const qc = useQueryClient()
  const { connected } = opts
  const hasPr = session.prNumber != null

  const query = useQuery({
    queryKey: reviewKey(session.id),
    queryFn: () => rpc.reviewGet(session.id),
    // Nothing to read until there's a PR to have reviewed.
    enabled: hasPr && connected,
    // The auto-trigger publishes into this key via setQueryData. Without a
    // staleTime, a mount/focus refetch would immediately re-read the store and
    // could replace a review the user is looking at with null (e.g. if the
    // persist silently failed). A review only changes when someone runs one.
    staleTime: Infinity
  })

  // A manual run always forces: the user clicked the button *because* they want a
  // fresh opinion, and silently handing back a cached review would read as a bug.
  const runMutation = useMutation({
    mutationFn: () => rpc.reviewRun(session.id, true),
    onSuccess: (review) => qc.setQueryData(reviewKey(session.id), review)
  })

  const runReview = useCallback(
    () => runMutation.mutateAsync().then(() => undefined),
    [runMutation]
  )

  const review = query.data ?? null
  const routedKeys = useRoutedEntries(session.id)

  // Resolve the namespaced keys down to plain ids for THIS review, so the UI
  // never has to reconstruct a key format it doesn't own.
  const sentFindingIds = useMemo(
    () => resolveSentIds(review, routedKeys),
    [review, routedKeys]
  )

  const sendFindingToAgent = useCallback(
    (findingId: string) => {
      const finding = review?.findings.find((f) => f.id === findingId)
      if (!finding || review === null) return
      getConversationActor(session).send({ type: "SEND", text: findingPrompt(finding) })
      markRouted(session.id, routedKey(review.headSha, findingId))
    },
    [review, session]
  )

  return {
    review,
    loading: query.isPending && hasPr && connected,
    running: runMutation.isPending,
    error: runMutation.error
      ? ((runMutation.error as { message?: string }).message ?? "The adversarial review failed")
      : null,
    runReview,
    sendFindingToAgent,
    sentFindingIds
  }
}
