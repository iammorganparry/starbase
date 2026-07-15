/**
 * Renderer hook backing the Pull Request tab. react-query owns the PR read
 * (`useQuery`) and the GitHub writes (`useMutation`, invalidating the read).
 * Anything handed to the agent — "Create pull request", routed review feedback —
 * goes through the session's persistent conversation actor (a normal turn), so
 * the work + any approval gates/questions surface in the Conversation tab.
 * Keeps `@starbase/ui`'s `PullRequestView` presentational.
 */
import { useCallback, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PullRequest, ReviewSubmitKind, Session } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { markRouted, useRoutedEntries } from "./routed-store.js"

/** Format a submitted review as an instruction fed to the session's agent. */
const reviewPrompt = (kind: ReviewSubmitKind, body: string): string => {
  const verb =
    kind === "request-changes" ? "requested changes" : kind === "approve" ? "approved" : "commented"
  return `A reviewer ${verb} on this pull request:\n\n${body}\n\nPlease address this feedback.`
}

/**
 * Instruction handed to the session's agent when the user clicks "Create pull
 * request" — the agent (which owns the worktree) commits, pushes, then opens
 * the PR, rather than the app shelling out to `gh` directly.
 */
const createPrPrompt = (base: string): string =>
  `Commit any outstanding changes in this worktree with a clear message, push the branch, ` +
  `then open a pull request against \`${base}\` using \`gh pr create\` (fill in a concise ` +
  `title and description summarising the changes).`

const prKey = (sessionId: string) => ["github", "pr", sessionId] as const

export interface PullRequestState {
  readonly pr: PullRequest | null
  readonly busy: boolean
  /** The message from a failed `gh pr create`, or null. */
  readonly createError: string | null
  readonly createPr: () => Promise<void>
  /** Merge the linked PR (merge commit). */
  readonly mergePr: () => Promise<void>
  /** A merge is in flight. */
  readonly merging: boolean
  /** The message from a failed `gh pr merge`, or null. */
  readonly mergeError: string | null
  /** Flip the linked draft PR to ready for review. */
  readonly markReady: () => Promise<void>
  /** A mark-ready is in flight. */
  readonly markingReady: boolean
  /** The message from a failed `gh pr ready`, or null. */
  readonly markReadyError: string | null
  readonly submitReview: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void>
  readonly sendEntryToAgent: (entryId: string) => Promise<void>
  /** Timeline entry ids already routed to the agent (their action stays "Sent"). */
  readonly sentEntryIds: ReadonlySet<string>
  readonly openOnGithub: () => void
}

export function usePullRequest(
  session: Session,
  opts: { connected: boolean; autoDetect: boolean; onPrLinked?: (sessionId: string, prNumber: number) => void }
): PullRequestState {
  const qc = useQueryClient()
  const [createError, setCreateError] = useState<string | null>(null)
  const { connected, autoDetect, onPrLinked } = opts

  const query = useQuery({
    queryKey: prKey(session.id),
    queryFn: async () => {
      // Auto-detect + link a PR open on the branch before the first read.
      if (session.prNumber == null && connected && autoDetect) {
        const n = await rpc.githubDetectPr(session.id).catch(() => null)
        if (n != null) onPrLinked?.(session.id, n)
      }
      return rpc.githubPr(session.id)
    }
  })

  // Route an instruction to the session's agent as a NORMAL conversation turn
  // (via the persistent actor), so its work + any approval gates / questions are
  // visible and answerable in the Conversation tab. A bare `rpc.agentRun` ran a
  // hidden turn whose gates rendered nowhere — so `gh pr create` (a gated command)
  // stalled it forever.
  const routeToAgent = useCallback(
    (text: string) => {
      getConversationActor(session).send({ type: "SEND", text })
    },
    [session]
  )

  // "Create pull request" hands the agent an instruction to commit outstanding
  // work and open the PR. It dispatches the turn and resolves right away — the
  // agent then works in the Conversation tab, and the PR read auto-detects +
  // links the PR once it's opened.
  const createPr = useCallback(async () => {
    setCreateError(null)
    routeToAgent(createPrPrompt(session.baseBranch ?? "main"))
  }, [routeToAgent, session.baseBranch])

  const reviewMutation = useMutation({
    mutationFn: (input: { body: string; kind: ReviewSubmitKind }) =>
      rpc.githubReview(session.id, input.kind, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })

  // "Merge pull request" merges the linked PR via `gh pr merge`. On success the
  // PR read is invalidated so the header flips to "Merged" (and the archive
  // sweep, which polls the PR state, retires the session).
  const mergeMutation = useMutation({
    mutationFn: () => rpc.githubMerge(session.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })
  // "Ready for review" flips a draft PR via `gh pr ready`. On success the PR
  // read is invalidated so the header + side panel leave the Draft state.
  const markReadyMutation = useMutation({
    mutationFn: () => rpc.githubMarkReady(session.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })
  const markReady = useCallback(
    () => markReadyMutation.mutateAsync().then(() => undefined),
    [markReadyMutation]
  )
  const mergePr = useCallback(
    () => mergeMutation.mutateAsync().then(() => undefined),
    [mergeMutation]
  )

  const submitReview = useCallback(
    async (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => {
      if (input.routeToAgent && input.body.trim().length > 0) {
        routeToAgent(reviewPrompt(input.kind, input.body))
      }
      await reviewMutation.mutateAsync({ body: input.body, kind: input.kind })
    },
    [reviewMutation, routeToAgent]
  )

  const pr = query.data ?? null
  const sentEntryIds = useRoutedEntries(session.id)
  const sendEntryToAgent = useCallback(
    async (entryId: string) => {
      const item = pr?.timeline.find((t) => t.id === entryId)
      if (!item) return
      const ref = item.path ? ` (on ${item.path}${item.line ? ` line ${item.line}` : ""})` : ""
      routeToAgent(`Review feedback from @${item.author}${ref}:\n\n${item.body}\n\nPlease address this.`)
      markRouted(session.id, entryId)
    },
    [pr, routeToAgent, session.id]
  )

  const openOnGithub = useCallback(() => {
    if (pr?.url) void window.starbase.openExternal(pr.url)
  }, [pr])

  return {
    pr,
    busy: query.isPending,
    createError,
    createPr,
    mergePr,
    merging: mergeMutation.isPending,
    mergeError: mergeMutation.error
      ? ((mergeMutation.error as { message?: string }).message ?? "Failed to merge pull request")
      : null,
    markReady,
    markingReady: markReadyMutation.isPending,
    markReadyError: markReadyMutation.error
      ? ((markReadyMutation.error as { message?: string }).message ?? "Failed to mark pull request ready")
      : null,
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    openOnGithub
  }
}
