/**
 * Bridges the Issue tab to the presentational `IssueView`. Mounted (keyed by
 * session id) when the Issue tab is active; fetches the full linked issue via
 * `Github.issue` and renders the GitHub-style page.
 */
import type { Session } from "@starbase/core"
import { IssueView } from "@starbase/ui"
import { useQuery } from "@tanstack/react-query"
import { rpc } from "./rpc-client.js"

export function IssuePane({
  session,
  onUnlink
}: {
  session: Session
  /** Detach the linked issue from this session. */
  onUnlink?: (sessionId: string) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["issue", session.id, session.issueNumber],
    queryFn: () => rpc.githubIssue(session.id),
    enabled: session.issueNumber != null,
    staleTime: 30_000
  })
  return (
    <IssueView
      issue={data ?? null}
      loading={isLoading}
      onOpen={
        session.issueUrl ? () => void window.starbase.openExternal(session.issueUrl!) : undefined
      }
      onUnlink={onUnlink ? () => onUnlink(session.id) : undefined}
    />
  )
}
