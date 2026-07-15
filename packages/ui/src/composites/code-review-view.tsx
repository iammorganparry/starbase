import { useCallback, useMemo, useRef } from "react"
import type { PrFileChange } from "@starbase/core"
import { Undo2 } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { ReviewDiff } from "./review-diff.js"
import { ReviewFileRow } from "./review-file-row.js"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"

/** Which diff the Code Review is showing — the PR, or the worktree's own changes. */
export type ReviewSource = "pr" | "local"

export interface CodeReviewViewProps {
  files: readonly PrFileChange[]
  /** The file currently in view (highlighted in the list; tracked by scroll). */
  activePath: string | null
  /** Every changed file's unified diff, in list order — rendered as one continuous scroll. */
  fileDiffs: readonly { readonly path: string; readonly diff: string }[]
  drafts: readonly ReviewDraft[]
  routeTargetSession: string | null
  connected: boolean
  /** Which source is shown, and whether each is available. */
  source: ReviewSource
  prAvailable: boolean
  localAvailable: boolean
  onSetSource: (source: ReviewSource) => void
  onSelectFile: (path: string) => void
  onToggleViewed: (path: string, viewed: boolean) => void
  onAddDraft: (draft: {
    path: string
    line: number
    endLine: number | null
    body: string
    routeToAgent: boolean
  }) => void
  onRemoveDraft: (id: string) => void
  onFinishReview: (mode: "comment_only" | "send_to_agent") => void
  onConnectGithub?: () => void
  /** Revert the selected lines — wired only for the uncommitted (local) source. */
  onRevertLines?: (range: { path: string; startLine: number; endLine: number }) => void
  /** Revert a whole file's uncommitted changes — the local source only. */
  onRevertFile?: (path: string) => void
}

/**
 * The Files-changed / Code Review tab — a file list, a selectable diff, and the
 * review tray. Reviewers select line ranges in the diff to draft inline comments,
 * then finish the review (comment-only, or routed to the session's agent).
 */
export function CodeReviewView({
  files,
  activePath,
  fileDiffs,
  drafts,
  routeTargetSession,
  connected,
  source,
  prAvailable,
  localAvailable,
  onSetSource,
  onSelectFile,
  onToggleViewed,
  onAddDraft,
  onRemoveDraft,
  onFinishReview,
  onConnectGithub,
  onRevertLines,
  onRevertFile
}: CodeReviewViewProps) {
  const added = files.reduce((sum, f) => sum + f.additions, 0)
  const removed = files.reduce((sum, f) => sum + f.deletions, 0)
  const viewed = files.filter((f) => f.viewed).length
  const isLocal = source === "local"

  const diffByPath = useMemo(
    () => new Map(fileDiffs.map((d) => [d.path, d.diff])),
    [fileDiffs]
  )

  // The continuous diff scroller and one anchor per file section, so scrolling can
  // track the current file and clicking a file can jump to its section.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const rafRef = useRef<number | null>(null)
  const setSectionRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) sectionRefs.current.set(path, el)
      else sectionRefs.current.delete(path)
    },
    []
  )

  // Scroll-spy: the active file is the last section whose top has scrolled to (or
  // above) the top of the viewport. rAF-throttled so it stays cheap while scrolling.
  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const container = scrollRef.current
      if (!container) return
      const top = container.getBoundingClientRect().top
      let current: string | null = null
      for (const f of files) {
        const el = sectionRefs.current.get(f.path)
        if (!el) continue
        if (el.getBoundingClientRect().top - top <= 60) current = f.path
        else break
      }
      if (current && current !== activePath) onSelectFile(current)
    })
  }, [files, activePath, onSelectFile])

  // Clicking a file in the list jumps the scroller to its section.
  const scrollToFile = useCallback(
    (path: string) => {
      const el = sectionRefs.current.get(path)
      const container = scrollRef.current
      if (el && container) {
        const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top
        container.scrollTo({ top: container.scrollTop + offset })
      }
      onSelectFile(path)
    },
    [onSelectFile]
  )

  // Persisted, drag-resizable widths for the two side panels.
  const fileList = useResizableWidth({ storageKey: "sb.review.files", initial: 212, min: 160, max: 440 })
  const tray = useResizableWidth({ storageKey: "sb.review.tray.v2", initial: 300, min: 260, max: 480 })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header — source toggle (PR vs local) + the review's "finish" action. */}
      <div className="flex h-10 flex-none items-center gap-3 border-b border-hairline px-[14px]">
        <SegmentedControl
          value={source}
          onChange={onSetSource}
          items={[
            { value: "pr", label: "Pull Request", disabled: !prAvailable },
            { value: "local", label: "Uncommitted", disabled: !localAvailable }
          ]}
        />
        <div className="flex-1" />
        {!isLocal && (
          <Button
            size="sm"
            disabled={drafts.length === 0}
            onClick={() => onFinishReview("send_to_agent")}
          >
            Finish review
            <span className="rounded-sm bg-editor/25 px-1.5 py-px font-mono text-[10px]">
              {drafts.length}
            </span>
          </Button>
        )}
      </div>

      {!isLocal && !connected && (
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-2.5">
          <Callout tone="blue" className="flex-1">
            Connect GitHub to post this review.
          </Callout>
          <Button variant="secondary" size="sm" onClick={onConnectGithub}>
            Connect GitHub
          </Button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* File list (resizable) */}
        <div
          style={{ width: fileList.width }}
          className="flex flex-none flex-col border-r border-hairline bg-panel"
        >
          <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[14px]">
            <span className="flex-1 text-[12px] font-semibold text-text-bright">Changed files</span>
            <span className="font-mono text-[10px] text-muted-foreground">{files.length}</span>
          </div>
          <div className="flex flex-1 flex-col gap-px overflow-auto p-2">
            {files.map((file) => (
              <ReviewFileRow
                key={file.path}
                file={file}
                active={file.path === activePath}
                onSelect={() => scrollToFile(file.path)}
                onToggleViewed={(v) => onToggleViewed(file.path, v)}
              />
            ))}
          </div>
          <div className="flex h-11 flex-none items-center gap-1.5 border-t border-hairline px-[14px] font-mono text-[10.5px] text-dim">
            <DiffStat added={added} removed={removed} className="text-[10.5px]" />
            <div className="flex-1" />
            <span>
              {viewed} / {files.length} viewed
            </span>
          </div>
        </div>

        <ResizeHandle onResize={fileList.adjust} aria-label="Resize file list" />

        {/* Diff center — one continuous scroll through every changed file. Each
            file gets a sticky header; scrolling tracks the current file in the
            list, and clicking a file jumps here. */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor"
        >
          {files.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-dim">
              No changes to review.
            </div>
          ) : (
            files.map((file) => (
              <div key={file.path} ref={setSectionRef(file.path)} className="flex flex-col">
                <div className="sticky top-0 z-10 flex h-[42px] flex-none items-center gap-2.5 border-b border-hairline bg-panel px-4">
                  <FileIcon path={file.path} size={13} />
                  <span className="truncate font-mono text-[12.5px] text-text-bright">
                    {file.path}
                  </span>
                  <DiffStat
                    added={file.additions}
                    removed={file.deletions}
                    className="flex-none text-[10.5px]"
                  />
                  <div className="min-w-[8px] flex-1" />
                  {isLocal
                    ? onRevertFile && (
                        <Button
                          variant="danger"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => onRevertFile(file.path)}
                        >
                          <Undo2 size={13} />
                          Revert file
                        </Button>
                      )
                    : (
                      <button
                        type="button"
                        onClick={() => onToggleViewed(file.path, !file.viewed)}
                        className="flex items-center gap-1.5 text-[11.5px] text-text"
                      >
                        <span
                          className={
                            file.viewed
                              ? "flex size-[15px] items-center justify-center rounded-[3px] border border-green/60 text-green"
                              : "size-[15px] rounded-[3px] border border-line"
                          }
                        >
                          {file.viewed && "✓"}
                        </span>
                        Viewed
                      </button>
                    )}
                </div>
                <ReviewDiff
                  path={file.path}
                  diff={diffByPath.get(file.path) ?? ""}
                  scroll={false}
                  connected={connected}
                  routeTargetSession={routeTargetSession}
                  onAddDraft={(d) =>
                    onAddDraft({
                      path: d.path,
                      line: d.startLine,
                      endLine: d.endLine > d.startLine ? d.endLine : null,
                      body: d.body,
                      routeToAgent: d.routeToAgent
                    })
                  }
                  onRevert={isLocal ? onRevertLines : undefined}
                />
              </div>
            ))
          )}
        </div>

        {/* Review tray (resizable) — drag left edge; moving right shrinks it. */}
        <ResizeHandle onResize={(dx) => tray.adjust(-dx)} aria-label="Resize review panel" />
        <div style={{ width: tray.width }} className="flex flex-none border-l border-hairline">
          <ReviewTray drafts={drafts} onRemoveDraft={onRemoveDraft} onFinishReview={onFinishReview} />
        </div>
      </div>
    </div>
  )
}
