/**
 * Renderer hook backing the Pull Request tab. react-query owns the PR read
 * (`useQuery`) and the GitHub writes (`useMutation`, invalidating the read);
 * routing review feedback into the session's agent stays a streaming side-effect.
 * Keeps `@starbase/ui`'s `PullRequestView` presentational.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PullRequest, ReviewSubmitKind, Session } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { markRouted, useRoutedEntries } from "./routed-store.js"

/** Format a submitted review as an instruction fed to the session's agent. */
const reviewPrompt = (kind: ReviewSubmitKind, body: string): string => {
  const verb =
    kind === "request-changes" ? "requested changes" : kind === "approve" ? "approved" : "commented"
  return `A reviewer ${verb} on this pull request:\n\n${body}\n\nPlease address this feedback.`
}

const prKey = (sessionId: string) => ["github", "pr", sessionId] as const

export interface PullRequestState {
  readonly pr: PullRequest | null
  readonly busy: boolean
  /** The message from a failed `gh pr create`, or null. */
  readonly createError: string | null
  /** A routed review is being worked on by the agent right now. */
  readonly routing: boolean
  readonly createPr: () => Promise<void>
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
  const [routing, setRouting] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)
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

  // Stop any in-flight routed run when the pane unmounts.
  useEffect(() => () => cancelRef.current?.(), [])

  const routeToAgent = useCallback(
    (text: string) => {
      cancelRef.current?.()
      setRouting(true)
      cancelRef.current = rpc.agentRun(session.id, text, (event) => {
        if (event._tag === "Done" || event._tag === "Failed") setRouting(false)
      })
    },
    [session.id]
  )

  const createMutation = useMutation({
    mutationFn: () =>
      rpc.githubCreatePr({
        sessionId: session.id,
        title: session.title,
        body: "",
        base: session.baseBranch ?? "main",
        draft: false
      }),
    onSuccess: (n) => {
      onPrLinked?.(session.id, n)
      void qc.invalidateQueries({ queryKey: prKey(session.id) })
    }
  })

  const reviewMutation = useMutation({
    mutationFn: (input: { body: string; kind: ReviewSubmitKind }) =>
      rpc.githubReview(session.id, input.kind, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id) })
  })

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

  const createError = createMutation.error
    ? ((createMutation.error as { message?: string }).message ?? "Failed to create pull request")
    : null

  return {
    pr,
    busy: query.isPending || createMutation.isPending,
    createError,
    routing,
    createPr: () => createMutation.mutateAsync().then(() => undefined),
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    openOnGithub
  }
}
