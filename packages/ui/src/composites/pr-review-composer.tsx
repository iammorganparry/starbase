import * as React from "react"
import type { ReviewSubmitKind } from "@starbase/core"
import { AsyncButton } from "../components/async-button.js"
import { Callout } from "../components/callout.js"
import { Toggle } from "../components/toggle.js"

/**
 * The sticky bottom review composer for the Pull Request tab — a comment draft,
 * a "route to agent" switch, and the three GitHub review actions (each with async
 * feedback while it posts).
 */
export function PrReviewComposer({
  connected,
  selfAuthored = false,
  onSubmit
}: {
  connected: boolean
  /**
   * The viewer authored this PR. GitHub forbids approving / requesting changes on
   * your own pull request, so those actions are disabled (Comment stays allowed).
   */
  selfAuthored?: boolean
  onSubmit: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void> | void
}) {
  const [body, setBody] = React.useState("")
  const [routeToAgent, setRouteToAgent] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (kind: ReviewSubmitKind) => {
    if (!connected) return
    setError(null)
    try {
      await onSubmit({ body: body.trim(), kind, routeToAgent })
      setBody("")
    } catch (e) {
      // Surface the real reason (e.g. "Can not approve your own pull request")
      // instead of the button's silent shake.
      setError(e instanceof Error ? e.message : "Failed to submit review.")
      throw e // let the AsyncButton show its error state too
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a review comment…"
        rows={2}
        className="w-full resize-none bg-transparent px-[14px] py-[11px] text-[13.5px] text-text-body outline-none placeholder:text-dim"
      />
      {!connected && (
        <div className="px-[14px] pb-[11px]">
          <Callout tone="blue">Connect GitHub to post reviews.</Callout>
        </div>
      )}
      {error && (
        <div className="px-[14px] pb-[11px]">
          <Callout tone="red">{error}</Callout>
        </div>
      )}
      <div className="flex items-center gap-[9px] border-t border-hairline px-[14px] py-[11px]">
        <label className="flex items-center gap-2 text-[11.5px] text-text">
          <Toggle checked={routeToAgent} onCheckedChange={setRouteToAgent} />
          Route to agent
        </label>
        <div className="flex-1" />
        <AsyncButton
          variant="secondary"
          disabled={!connected}
          pendingLabel="Posting…"
          successLabel="Commented"
          onClick={() => submit("comment")}
        >
          Comment
        </AsyncButton>
        {/* Approve / request-changes are hidden on your own PR — GitHub forbids
            self-approval, so only Comment is offered. */}
        {!selfAuthored && (
          <>
            <AsyncButton
              variant="danger"
              disabled={!connected}
              pendingLabel="Requesting…"
              successLabel="Requested"
              onClick={() => submit("request-changes")}
            >
              Request changes
            </AsyncButton>
            <AsyncButton
              variant="primary"
              disabled={!connected}
              pendingLabel="Approving…"
              successLabel="Approved"
              onClick={() => submit("approve")}
            >
              Approve
            </AsyncButton>
          </>
        )}
      </div>
    </div>
  )
}
