/**
 * Renderer hook backing the adversarial review. react-query owns the stored-review
 * read and the run mutation; routing a finding to the working agent goes through
 * the session's persistent conversation actor (a normal turn), exactly as
 * `usePullRequest.sendEntryToAgent` does — so the agent's work and any approval
 * gates surface in the Conversation tab instead of a hidden run that stalls
 * forever with its gates rendered nowhere.
 */
import { useCallback, useEffect, useMemo } from "react"
import { useSelector } from "@xstate/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AdversarialReview, ReviewFinding, ReviewPhase, Session } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { markRouted, useRoutedEntries } from "./routed-store.js"
import { resolveSentIds, reviewQueryKey, routedKey } from "./review-routing.js"
import { routeReviewToAgent } from "./auto-route.js"

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
  /** A reviewer run is in flight — whoever started it. */
  readonly running: boolean
  /** Where the running reviewer has got to (meaningless unless `running`). */
  readonly phase: ReviewPhase
  /** Epoch ms the running review started, or null — drives the button's timer. */
  readonly startedAt: number | null
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
    queryKey: reviewQueryKey(session.id),
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
    onSuccess: (review) => {
      qc.setQueryData(reviewQueryKey(session.id), review)
      // Route here as well as from the auto-review poll: a manual run reaches
      // this callback directly, and the poll is only mounted when auto-review is
      // switched ON. Without this, clicking "Review again" with the toggle off
      // would find critical bugs and hand them to nobody. `routeReviewToAgent`
      // de-dupes, so the two paths overlapping is harmless.
      void routeReviewToAgent(session, review, qc)
    }
  })

  const runReview = useCallback(
    () => runMutation.mutateAsync().then(() => undefined),
    [runMutation]
  )

  // Live progress comes from the session's conversation actor, which watches the
  // reviewer's event stream for this session. Reading it here (rather than from
  // the mutation) is what lets the button report a review it did not start — the
  // auto-review poll runs one on a new head with nobody's finger on the button.
  const actor = useMemo(() => getConversationActor(session), [session.id])
  const phase = useSelector(actor, (s) => s.context.reviewPhase)
  const startedAt = useSelector(actor, (s) => s.context.reviewStartedAt)

  const review = query.data ?? null

  // Deliberately NO "route any unrouted stored review on mount" effect here.
  //
  // Routing to the agent is an unsupervised action, so it happens ONLY as the
  // direct result of a review the user asked for: a manual run (`onSuccess`
  // above) or the auto-review poll (App.tsx), which is gated on the
  // `autoAdversarialReview` toggle. Merely OPENING a session must not send
  // anything.
  //
  // An earlier version routed every `routedAt: null` review on mount to clear a
  // "Sending…" spinner. It fired for reviews the user never opted into — heads
  // that predate the upgrade (findings describing code that has since changed),
  // findings declined under the old manual flow, and sessions with auto-review
  // off. The spinner is gone by a different route: an unstamped finding now
  // reads "Send to agent" (see `outcomeOf`), which is the truth — it was not
  // sent, and here is how — and hands the choice back to the operator.

  // Attribute fixed findings to the commit that fixed them.
  //
  // Triggered on the agent going IDLE rather than on a timer, because that is
  // precisely when the thing being detected can have happened: commits land
  // during a turn, so a turn settling is the only moment new ones exist. The
  // effect also runs on mount, which covers a session reopened after the fixes
  // were already made — the query's `staleTime: Infinity` means nothing else
  // would ever re-read the store.
  //
  // Only publishes on a non-null answer. `Review.reconcile` returns null when it
  // attributed nothing, so the steady state is one cheap `git log` per turn and
  // no re-render at all.
  const agentBusy = useSelector(actor, (s) => s.context.runStartedAt !== null)
  useEffect(() => {
    if (!hasPr || !connected || agentBusy) return
    let cancelled = false
    void rpc
      .reviewReconcile(session.id)
      .then((next) => {
        if (!cancelled && next !== null) qc.setQueryData(reviewQueryKey(session.id), next)
      })
      // Best-effort: attribution is a nicety layered over a review that is already
      // readable, so a failure must leave the pane exactly as it was.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentBusy, hasPr, connected, session.id, qc])

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
    // Either half alone is a lie: the mutation misses an auto-review entirely, and
    // the stream is silent for the beat between the click and the agent spawning.
    running: runMutation.isPending || startedAt !== null,
    phase,
    startedAt,
    error: runMutation.error
      ? ((runMutation.error as { message?: string }).message ?? "The adversarial review failed")
      : null,
    runReview,
    sendFindingToAgent,
    sentFindingIds
  }
}
