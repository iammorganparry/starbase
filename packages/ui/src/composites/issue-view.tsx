import type { Issue } from "@starbase/core"
import { CircleDot, CheckCircle2, ExternalLink, Link2Off, MessageSquare } from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Markdown } from "../components/markdown.js"
import { Spinner } from "../components/loading.js"
import { relativeTime } from "../lib/relative-time.js"
import { IssueLabelChip } from "./issue-picker-list.js"

/**
 * The Issue tab — a recreation of the GitHub issue page for the session's linked
 * issue: an open/closed state pill, title + #, the author's opening comment
 * (markdown), label + assignee metadata, and the comment thread. Purely
 * presentational; data comes from `Github.issue`, actions are lifted to props.
 */
export function IssueView({
  issue,
  loading = false,
  onOpen,
  onUnlink
}: {
  issue: Issue | null
  loading?: boolean
  /** Open the issue in the system browser. */
  onOpen?: () => void
  /** Detach the issue from this session. */
  onUnlink?: () => void
}) {
  // Above every early return below — a hook that only runs on some renders is
  // the one thing React's hook order cannot survive.
  const tier = useWidthTier()

  if (loading && !issue) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner size={20} />
      </div>
    )
  }
  if (!issue) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <CircleDot size={24} className="text-line-strong" />
        <span className="text-[13px]">This issue couldn&apos;t be loaded.</span>
      </div>
    )
  }

  const open = issue.state === "open"
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className={cn("mx-auto w-full max-w-[820px] py-7", atLeast(tier, "mid") ? "px-8" : "px-4")}>
        {/* Title + number + actions */}
        <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight text-text-bright">
            {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
          </h1>
          <div className="flex flex-none items-center gap-1.5">
            {onOpen && (
              <button
                type="button"
                onClick={onOpen}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-text outline-none transition-colors hover:border-line-strong hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open on GitHub
                <ExternalLink size={12} />
              </button>
            )}
            {onUnlink && (
              <button
                type="button"
                onClick={onUnlink}
                title="Unlink this issue from the session"
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-line-strong hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Link2Off size={12} />
                Unlink
              </button>
            )}
          </div>
        </div>

        {/* State pill + meta */}
        <div className="mb-6 flex flex-wrap items-center gap-2.5 border-b border-hairline pb-5 text-[12.5px] text-muted-foreground">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
              open ? "bg-green/15 text-green" : "bg-purple/15 text-purple"
            )}
          >
            {open ? <CircleDot size={13} /> : <CheckCircle2 size={13} />}
            {open ? "Open" : "Closed"}
          </span>
          <span>
            <strong className="font-semibold text-text">{issue.author.login}</strong> opened this
            {issue.createdAt ? ` ${relativeTime(issue.createdAt)}` : ""}
          </span>
          {issue.comments.length > 0 && (
            <span className="flex items-center gap-1.5">
              <MessageSquare size={12} />
              {issue.comments.length} comment{issue.comments.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Labels + assignees */}
        {(issue.labels.length > 0 || issue.assignees.length > 0) && (
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            {issue.labels.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {issue.labels.map((l) => (
                  <IssueLabelChip key={l.name} name={l.name} color={l.color} />
                ))}
              </div>
            )}
            {issue.assignees.length > 0 && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span>Assignees:</span>
                {issue.assignees.map((a) => (
                  <span key={a.login} className="flex items-center gap-1.5 text-text">
                    <Avatar
                      initial={(a.login[0] ?? "?").toUpperCase()}
                      src={githubAvatarUrl(a.login, 32)}
                      size={16}
                    />
                    {a.login}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Opening comment (issue body) */}
        <IssueComment author={issue.author.login} createdAt={issue.createdAt} body={issue.body} opening />

        {/* Comment thread */}
        {issue.comments.map((c) => (
          <IssueComment
            key={`${c.author.login}-${c.createdAt}`}
            author={c.author.login}
            createdAt={c.createdAt}
            body={c.body}
          />
        ))}
      </div>
    </div>
  )
}

/** One issue comment card — GitHub-style header bar + markdown body. */
function IssueComment({
  author,
  createdAt,
  body,
  opening = false
}: {
  author: string
  createdAt: string
  body: string
  opening?: boolean
}) {
  return (
    <div className="mb-4 flex gap-3">
      <Avatar initial={(author[0] ?? "?").toUpperCase()} src={githubAvatarUrl(author, 48)} size={30} />
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line">
        <div
          className={cn(
            "flex items-center gap-2 border-b border-hairline px-3.5 py-2 text-[12px]",
            opening ? "bg-blue/[0.06]" : "bg-sunken"
          )}
        >
          <strong className="font-semibold text-text">{author}</strong>
          <span className="text-muted-foreground">
            commented{createdAt ? ` ${relativeTime(createdAt)}` : ""}
          </span>
        </div>
        <div className="px-3.5 py-3">
          {body.trim().length > 0 ? (
            <Markdown>{body}</Markdown>
          ) : (
            <span className="text-[12.5px] italic text-dim">No description provided.</span>
          )}
        </div>
      </div>
    </div>
  )
}
