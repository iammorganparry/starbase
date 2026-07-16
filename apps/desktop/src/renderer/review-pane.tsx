/**
 * Bridges the Code Review tab to the presentational `CodeReviewView`. Mounted
 * (keyed by session id) when the Code Review tab is active; owns its data via
 * `useReview` (both the PR diff and the worktree's uncommitted diff + reverts).
 */
import type { Session } from "@starbase/core"
import { CodeReviewView } from "@starbase/ui"
import { useReview } from "./use-review.js"

export function ReviewPane({
  session,
  connected,
  onConnectGithub
}: {
  session: Session
  connected: boolean
  onConnectGithub: () => void
}) {
  const review = useReview(session)

  return (
    <CodeReviewView
      files={review.files}
      activePath={review.activePath}
      fileDiffs={review.fileDiffs}
      drafts={review.drafts}
      routeTargetSession={session.title}
      connected={connected}
      source={review.source}
      prAvailable={review.prAvailable}
      localAvailable={review.localAvailable}
      onSetSource={review.setSource}
      onSelectFile={review.selectFile}
      onToggleViewed={review.toggleViewed}
      onAddDraft={review.addDraft}
      onRemoveDraft={review.removeDraft}
      onFinishReview={review.finishReview}
      onConnectGithub={onConnectGithub}
      onRevertLines={review.revertLines}
      onRevertFile={review.revertFile}
    />
  )
}
