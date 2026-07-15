/**
 * Bridges the Pull Request tab to the presentational `PullRequestView`. Mounted
 * (keyed by session id) when the PR tab is active; owns its data via
 * `usePullRequest`.
 */
import type { Session } from "@starbase/core"
import { PullRequestView } from "@starbase/ui"
import { usePullRequest } from "./use-pull-request.js"

export function PullRequestPane({
  session,
  connected,
  autoDetect,
  viewerLogin,
  onConnectGithub,
  onPrLinked
}: {
  session: Session
  connected: boolean
  autoDetect: boolean
  /** The authenticated GitHub login (to disable approving your own PR). */
  viewerLogin?: string | null
  onConnectGithub: () => void
  onPrLinked: (sessionId: string, prNumber: number) => void
}) {
  const {
    pr,
    busy,
    createError,
    createPr,
    mergePr,
    merging,
    mergeError,
    markReady,
    markingReady,
    markReadyError,
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    openOnGithub
  } = usePullRequest(session, { connected, autoDetect, onPrLinked })

  return (
    <PullRequestView
      pr={pr}
      connected={connected}
      busy={busy}
      viewerLogin={viewerLogin}
      createError={createError}
      sessionTitle={session.title}
      onCreatePr={createPr}
      onMerge={mergePr}
      merging={merging}
      mergeError={mergeError}
      onMarkReady={markReady}
      markingReady={markingReady}
      markReadyError={markReadyError}
      onConnectGithub={onConnectGithub}
      onSubmitReview={submitReview}
      onSendEntryToAgent={sendEntryToAgent}
      sentEntryIds={sentEntryIds}
      onOpenOnGithub={openOnGithub}
    />
  )
}
