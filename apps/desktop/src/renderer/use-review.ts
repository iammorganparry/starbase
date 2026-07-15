/**
 * Renderer hook backing the Code Review tab. Owns two diff sources — the PR
 * (`gh pr diff`) and the session worktree's uncommitted changes (`git diff HEAD`)
 * — plus the "your review" draft tray. On the local source it also drives reverts
 * (line-range + whole-file) against the worktree, refetching after each.
 */
import { useCallback, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { PrFileChange, Session } from "@starbase/core"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"

/** Which diff the Code Review is showing. */
export type ReviewSource = "pr" | "local"

/**
 * Extract a single file's section from a full unified diff (which concatenates
 * every changed file). The diff renderer expects only the active file's diff, so
 * we slice on `diff --git` boundaries.
 */
const sliceDiffForFile = (diff: string, path: string | null): string => {
  if (!path || diff.length === 0) return ""
  const blocks: Array<string> = []
  let current: Array<string> | null = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) blocks.push(current.join("\n"))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) blocks.push(current.join("\n"))
  return blocks.find((b) => b.includes(` b/${path}`) || b.includes(`+++ b/${path}`)) ?? ""
}

/** Parse a full unified diff into per-file change entries (for the file list). */
const parseDiffFiles = (diff: string): ReadonlyArray<PrFileChange> => {
  if (diff.length === 0) return []
  const files: Array<PrFileChange> = []
  let cur: { path: string; additions: number; deletions: number } | null = null
  const push = () => {
    if (cur) files.push({ ...cur, commentCount: 0, viewed: false })
  }
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      push()
      const m = line.match(/ b\/(.+)$/)
      cur = { path: m?.[1] ?? "", additions: 0, deletions: 0 }
    } else if (cur) {
      if (line.startsWith("+") && !line.startsWith("+++")) cur.additions += 1
      else if (line.startsWith("-") && !line.startsWith("---")) cur.deletions += 1
    }
  }
  push()
  return files
}

export interface ReviewDraft {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly endLine: number | null
  readonly body: string
  readonly routeToAgent: boolean
}

const draftLabel = (d: ReviewDraft): string =>
  `${d.path} ${d.endLine && d.endLine > d.line ? `L${d.line}-${d.endLine}` : `L${d.line}`}`

export interface ReviewState {
  readonly source: ReviewSource
  readonly setSource: (source: ReviewSource) => void
  readonly prAvailable: boolean
  readonly localAvailable: boolean
  readonly files: ReadonlyArray<PrFileChange>
  /** The active file's unified diff (sliced from the active source's full diff). */
  readonly fileDiff: string
  /** Every changed file's unified diff, in list order — for the continuous scroll view. */
  readonly fileDiffs: ReadonlyArray<{ readonly path: string; readonly diff: string }>
  readonly activePath: string | null
  readonly drafts: ReadonlyArray<ReviewDraft>
  readonly busy: boolean
  readonly selectFile: (path: string) => void
  readonly toggleViewed: (path: string, viewed: boolean) => void
  readonly addDraft: (d: { path: string; line: number; endLine: number | null; body: string; routeToAgent: boolean }) => void
  readonly removeDraft: (id: string) => void
  readonly finishReview: (mode: "comment_only" | "send_to_agent") => void
  readonly revertLines: (range: { path: string; startLine: number; endLine: number }) => void
  readonly revertFile: (path: string) => void
}

const localKey = (sessionId: string) => ["local", "diff", sessionId] as const

/** localStorage key for the set of paths marked "viewed" in a session's review. */
const viewedStorageKey = (sessionId: string) => `sb.review.viewed.${sessionId}`

const readViewed = (sessionId: string): ReadonlySet<string> => {
  try {
    const raw = localStorage.getItem(viewedStorageKey(sessionId))
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

export function useReview(session: Session): ReviewState {
  const qc = useQueryClient()
  const [source, setSourceRaw] = useState<ReviewSource>("pr")
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyArray<ReviewDraft>>([])
  const [viewedPaths, setViewedPaths] = useState<ReadonlySet<string>>(() => readViewed(session.id))
  const seq = useRef(0)

  // "Viewed" is a reviewer-local marker (gh/git don't report it) — persist it per
  // session in localStorage so ticking a file off survives tab switches + reloads.
  const toggleViewed = useCallback(
    (path: string, viewed: boolean) => {
      setViewedPaths((prev) => {
        const next = new Set(prev)
        if (viewed) next.add(path)
        else next.delete(path)
        try {
          localStorage.setItem(viewedStorageKey(session.id), JSON.stringify([...next]))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [session.id]
  )

  const prQuery = useQuery({
    queryKey: ["github", "review", session.id],
    queryFn: async () => {
      const [files, diff] = await Promise.all([rpc.githubFiles(session.id), rpc.githubDiff(session.id)])
      return { files, diff }
    }
  })
  const localQuery = useQuery({
    queryKey: localKey(session.id),
    queryFn: () => rpc.sessionsDiff(session.id)
  })

  const prFiles = prQuery.data?.files ?? []
  const prDiff = prQuery.data?.diff ?? ""
  const localDiff = localQuery.data ?? ""
  const localFiles = useMemo(() => parseDiffFiles(localDiff), [localDiff])

  const prAvailable = prFiles.length > 0
  const localAvailable = localFiles.length > 0

  // Fall back to whichever source actually has data.
  const effective: ReviewSource =
    source === "local" && !localAvailable && prAvailable
      ? "pr"
      : source === "pr" && !prAvailable && localAvailable
        ? "local"
        : source

  const sourceFiles = effective === "local" ? localFiles : prFiles
  // Overlay the reviewer's local "viewed" markers onto the source's file list.
  const files = useMemo(
    () => sourceFiles.map((f) => (viewedPaths.has(f.path) ? { ...f, viewed: true } : f)),
    [sourceFiles, viewedPaths]
  )
  const fullDiff = effective === "local" ? localDiff : prDiff
  const activePath = selectedPath ?? files[0]?.path ?? null
  const fileDiff = useMemo(() => sliceDiffForFile(fullDiff, activePath), [fullDiff, activePath])
  // Every file's diff, sliced once from the full diff — the continuous scroll
  // view renders them all stacked rather than one active file at a time.
  const fileDiffs = useMemo(
    () => files.map((f) => ({ path: f.path, diff: sliceDiffForFile(fullDiff, f.path) })),
    [files, fullDiff]
  )

  const setSource = useCallback((s: ReviewSource) => {
    setSourceRaw(s)
    setSelectedPath(null) // reset to the first file of the new source
  }, [])

  const addDraft = useCallback(
    (d: { path: string; line: number; endLine: number | null; body: string; routeToAgent: boolean }) => {
      seq.current += 1
      setDrafts((ds) => [...ds, { id: `d_${seq.current}`, ...d }])
    },
    []
  )

  const removeDraft = useCallback((id: string) => {
    setDrafts((ds) => ds.filter((x) => x.id !== id))
  }, [])

  const finishReview = useCallback(
    (mode: "comment_only" | "send_to_agent") => {
      const current = drafts
      if (current.length === 0) return
      const summary = current.map((d) => `- ${draftLabel(d)}: ${d.body}`).join("\n")
      if (mode === "send_to_agent") {
        // Route through the session's persistent conversation actor (a SEND
        // event) — the SAME path the composer uses — so the turn is appended to
        // the transcript and its response streams into the conversation pane.
        // Calling `rpc.agentRun` directly (with a throwaway event callback) ran a
        // parallel agent whose output never reached this conversation.
        getConversationActor(session).send({
          type: "SEND",
          text: `Please address these code review comments:\n\n${summary}`
        })
      } else {
        void rpc.githubComment(session.id, `**Code review**\n\n${summary}`, true).catch(() => {})
      }
      setDrafts([])
    },
    [drafts, session.id]
  )

  const refetchLocal = () => qc.invalidateQueries({ queryKey: localKey(session.id) })
  const revertLines = useCallback(
    (range: { path: string; startLine: number; endLine: number }) => {
      void rpc
        .workspaceRevertLines(session.id, range.path, range.startLine, range.endLine)
        .then(refetchLocal)
        .catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  )
  const revertFile = useCallback(
    (path: string) => {
      void rpc.workspaceRevertFile(session.id, path).then(refetchLocal).catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  )

  return {
    source: effective,
    setSource,
    prAvailable,
    localAvailable,
    files,
    fileDiff,
    fileDiffs,
    activePath,
    drafts,
    busy: prQuery.isPending || localQuery.isPending,
    selectFile: setSelectedPath,
    toggleViewed,
    addDraft,
    removeDraft,
    finishReview,
    revertLines,
    revertFile
  }
}
