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
import type { PrMergeMethod, PullRequest, ReviewSubmitKind, Session } from "@starbase/core"
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
  /** Merge the PR. Defaults to a merge commit; the side panel offers the choice. */
  readonly mergePr: (method?: PrMergeMethod) => Promise<void>
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
  /** Merge the base into the PR's head (clears a `BEHIND` merge state). */
  readonly updateBranch: () => Promise<void>
  /** A branch update is in flight. */
  readonly updatingBranch: boolean
  /** The message from a failed `gh pr update-branch`, or null. */
  readonly updateBranchError: string | null
  readonly submitReview: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void>
  readonly sendEntryToAgent: (entryId: string) => Promise<void>
  /** Timeline entry ids already routed to the agent (their action stays "Sent"). */
  readonly sentEntryIds: ReadonlySet<string>
  /** Resolve / unresolve an inline review thread. */
  readonly resolveThread: (threadId: string, resolved: boolean) => Promise<void>
  /** Reply into an inline review thread (`commentId` = the REST databaseId). */
  readonly replyToThread: (commentId: number, body: string) => Promise<void>
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
    mutationFn: (method: PrMergeMethod) => rpc.githubMerge(session.id, method),
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
  // "Update branch" merges the base into the PR head on GitHub, clearing a
  // `BEHIND` merge state. The re-read is what drops the blocker from the box.
  const updateBranchMutation = useMutation({
    mutationFn: () => rpc.githubUpdateBranch(session.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })
  const updateBranch = useCallback(
    () => updateBranchMutation.mutateAsync().then(() => undefined),
    [updateBranchMutation]
  )
  const mergePr = useCallback(
    (method: PrMergeMethod = "merge") => mergeMutation.mutateAsync(method).then(() => undefined),
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

  // Resolve / unresolve an inline review thread, then re-read the PR so the
  // thread's badge and collapsed state follow GitHub.
  const resolveThreadMutation = useMutation({
    mutationFn: (input: { threadId: string; resolved: boolean }) =>
      rpc.githubResolveThread(session.id, input.threadId, input.resolved),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })
  const resolveThread = useCallback(
    (threadId: string, resolved: boolean) =>
      resolveThreadMutation.mutateAsync({ threadId, resolved }).then(() => undefined),
    [resolveThreadMutation]
  )

  // Reply into an inline review thread; the re-read brings the new comment back.
  const replyToThreadMutation = useMutation({
    mutationFn: (input: { commentId: number; body: string }) =>
      rpc.githubReplyToThread(session.id, input.commentId, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })
  const replyToThread = useCallback(
    (commentId: number, body: string) =>
      replyToThreadMutation.mutateAsync({ commentId, body }).then(() => undefined),
    [replyToThreadMutation]
  )

  const pr = query.data ?? null
  const sentEntryIds = useRoutedEntries(session.id)
  const sendEntryToAgent = useCallback(
    async (entryId: string) => {
      // An id is either a top-level timeline entry or a comment inside an inline
      // review thread — the latter carries its code reference on the thread.
      const item = pr?.timeline.find((t) => t.id === entryId)
      const thread = pr?.reviewThreads.find((t) => t.comments.some((c) => c.id === entryId))
      const comment = thread?.comments.find((c) => c.id === entryId)
      const found = item
        ? { author: item.author, body: item.body, path: item.path, line: item.line }
        : thread && comment
          ? {
              author: comment.author,
              body: comment.body,
              path: thread.path,
              // GitHub nulls the live anchor once the thread is outdated.
              line: thread.line ?? thread.originalLine
            }
          : null
      if (!found) return
      const ref = found.path ? ` (on ${found.path}${found.line ? ` line ${found.line}` : ""})` : ""
      routeToAgent(`Review feedback from @${found.author}${ref}:\n\n${found.body}\n\nPlease address this.`)
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
    updateBranch,
    updatingBranch: updateBranchMutation.isPending,
    updateBranchError: updateBranchMutation.error
      ? ((updateBranchMutation.error as { message?: string }).message ?? "Failed to update the branch")
      : null,
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    resolveThread,
    replyToThread,
    openOnGithub
  }
}
