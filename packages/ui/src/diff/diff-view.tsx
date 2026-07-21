import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Undo2, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import type { DiffRow } from "./parse.js"
import { parseUnifiedDiff } from "./parse.js"
import type { Token } from "./highlight.js"
import { HighlightedLine, useMultiFileHighlight } from "./use-highlight.js"

const ROW_HEIGHT = { file: 34, hunk: 26, line: 21 } as const

const statusColor: Record<string, string> = {
  modified: "text-yellow",
  added: "text-green",
  deleted: "text-red",
  renamed: "text-blue"
}
const statusLetter: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R"
}

/** Optional interactions for a live worktree diff (the Changes rail). */
export interface DiffActions {
  /** Revert the uncommitted changes in the selected line range. */
  onRevertLines: (path: string, startLine: number, endLine: number) => void
  /** Revert all uncommitted changes to a file. */
  onRevertFile: (path: string) => void
  /** Send a comment about the selected lines to the session's agent. */
  onComment: (path: string, startLine: number, endLine: number, body: string) => void
}

export interface DiffViewProps {
  /** Pre-parsed rows, or provide `patch`. */
  rows?: ReadonlyArray<DiffRow>
  /** Raw unified-diff string (parsed internally). */
  patch?: string
  className?: string
  /** Extra overscan for smoother fast scrolling over huge diffs. */
  overscan?: number
  /** When provided, lines are selectable and can be reverted / commented on. */
  actions?: DiffActions
}

type Selection = { anchor: number; head: number }
const loOf = (s: Selection) => Math.min(s.anchor, s.head)
const hiOf = (s: Selection) => Math.max(s.anchor, s.head)

/**
 * A virtualized unified-diff viewer. Only the visible rows are mounted, so it
 * renders diffs with tens of thousands of lines without jank — the scroll
 * container is the sole source of layout, rows are absolutely positioned. When
 * `actions` is given, dragging over lines selects a range (anchored to one file)
 * that can be reverted or commented on via a floating bar; file rows get a
 * per-file revert.
 */
export function DiffView({ rows, patch, className, overscan = 24, actions }: DiffViewProps) {
  const parsed = useMemo<ReadonlyArray<DiffRow>>(
    () => rows ?? (patch ? parseUnifiedDiff(patch) : []),
    [rows, patch]
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  // The file path each row belongs to (carry the last `file` row forward).
  const rowFile = useMemo(() => {
    const out: Array<string | null> = []
    let cur: string | null = null
    for (const r of parsed) {
      if (r.kind === "file") cur = r.path
      out.push(cur)
    }
    return out
  }, [parsed])

  // Syntax highlighting, one grammar run per FILE in the changeset.
  //
  // Hoisted here rather than done in the row: the rows are virtualized, so a
  // per-row hook would re-tokenize on every scroll — and a line inside a
  // template literal is only a string because of a line above it, which a row
  // that only sees itself can never know.
  const rowContent = useMemo(
    () => parsed.map((r) => (r.kind === "line" ? r.content : null)),
    [parsed]
  )
  const highlighted = useMultiFileHighlight(rowContent, rowFile)

  const [selection, setSelection] = useState<Selection | null>(null)
  const [body, setBody] = useState("")
  const dragging = useRef(false)

  // End a drag wherever the pointer is released.
  useEffect(() => {
    const stop = () => {
      dragging.current = false
    }
    window.addEventListener("pointerup", stop)
    return () => window.removeEventListener("pointerup", stop)
  }, [])

  // A changed diff (new content, or a revert landed) clears the selection.
  useEffect(() => {
    setSelection(null)
    setBody("")
  }, [parsed])

  const virtualizer = useVirtualizer({
    count: parsed.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ROW_HEIGHT[parsed[i]!.kind],
    overscan
  })

  const clear = () => {
    setSelection(null)
    setBody("")
  }

  // The concrete file + line range of the current selection (same file only).
  const range = useMemo(() => {
    if (selection === null) return null
    const path = rowFile[selection.anchor]
    if (!path) return null
    const nums: Array<number> = []
    for (let i = loOf(selection); i <= hiOf(selection); i++) {
      const r = parsed[i]
      if (r && r.kind === "line" && rowFile[i] === path) nums.push(r.newLn ?? r.oldLn ?? 0)
    }
    const valid = nums.filter((n) => n > 0)
    if (valid.length === 0) return null
    return { path, startLine: Math.min(...valid), endLine: Math.max(...valid) }
  }, [selection, parsed, rowFile])

  const selectedRow = (i: number) =>
    selection !== null &&
    i >= loOf(selection) &&
    i <= hiOf(selection) &&
    rowFile[i] === rowFile[selection.anchor]

  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={scrollRef}
        className={cn("h-full overflow-auto bg-editor font-mono text-[11px] leading-[1.85]", className)}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = parsed[item.index]!
            return (
              <div
                key={row.key}
                className="absolute left-0 top-0 w-full"
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <DiffRowView
                  row={row}
                  tokens={highlighted[item.index]}
                  selected={selectedRow(item.index)}
                  onRevertFile={actions?.onRevertFile}
                  onPointerDown={
                    actions && row.kind === "line"
                      ? (e) => {
                          e.preventDefault()
                          dragging.current = true
                          setBody("")
                          setSelection({ anchor: item.index, head: item.index })
                        }
                      : undefined
                  }
                  onPointerEnter={
                    actions && row.kind === "line"
                      ? () => {
                          if (dragging.current) setSelection((s) => (s === null ? s : { ...s, head: item.index }))
                        }
                      : undefined
                  }
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Floating action bar for the current selection. */}
      {actions && range && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 border-t border-hairline bg-panel p-2.5 shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.6)]">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="truncate font-mono text-blue">
              {range.path.split("/").pop()} L{range.startLine}
              {range.endLine > range.startLine ? `–${range.endLine}` : ""}
            </span>
            <div className="flex-1" />
            <button type="button" aria-label="Cancel" onClick={clear} className="text-dim hover:text-text">
              <X size={13} />
            </button>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Ask the agent to fix this…"
            rows={2}
            className="w-full resize-none rounded-md border border-line bg-sunken px-2 py-1.5 font-sans text-[12px] text-text-body outline-none placeholder:text-dim focus-visible:border-blue"
          />
          {/* Wraps rather than overflows: two nowrap buttons and a spacer in a
              diff column that can be a couple of hundred pixels wide. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                actions.onRevertLines(range.path, range.startLine, range.endLine)
                clear()
              }}
            >
              <Undo2 size={12} />
              Revert
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              className="gap-1.5"
              disabled={body.trim().length === 0}
              onClick={() => {
                actions.onComment(range.path, range.startLine, range.endLine, body.trim())
                clear()
              }}
            >
              <ClaudeGlyph />
              Send to agent
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function DiffRowView({
  row,
  tokens,
  selected = false,
  onRevertFile,
  onPointerDown,
  onPointerEnter
}: {
  row: DiffRow
  /** This line's themed runs, or undefined while the grammar loads. */
  tokens?: ReadonlyArray<Token>
  selected?: boolean
  onRevertFile?: (path: string) => void
  onPointerDown?: (e: ReactPointerEvent) => void
  onPointerEnter?: () => void
}) {
  if (row.kind === "file") {
    return (
      <div className="group flex h-full items-center gap-2 border-y border-hairline bg-surface px-3 text-muted-foreground">
        <span className={statusColor[row.status]}>{statusLetter[row.status]}</span>
        <span className="truncate text-text-bright">{row.path}</span>
        <div className="flex-1" />
        {onRevertFile && (
          <button
            type="button"
            title="Revert file"
            aria-label={`Revert ${row.path}`}
            onClick={() => onRevertFile(row.path)}
            className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-red opacity-80 hover:bg-red/10 group-hover:flex"
          >
            <Undo2 size={11} />
            Revert
          </button>
        )}
        {row.additions > 0 && <span className="text-green">+{row.additions}</span>}
        {row.deletions > 0 && <span className="text-red">−{row.deletions}</span>}
      </div>
    )
  }
  if (row.kind === "hunk") {
    return (
      <div className="flex h-full items-center bg-sunken px-3 text-[10.5px] text-cyan">{row.header}</div>
    )
  }
  const bg = selected
    ? "bg-blue/[0.14]"
    : row.type === "add"
      ? "bg-green/[0.13]"
      : row.type === "del"
        ? "bg-red/[0.12]"
        : ""
  // The SIGN is green/red. The code is not — see the same note in
  // `review-diff.tsx`. Add/remove is carried by the background wash so the text
  // colour is free to say what each token IS.
  const signFg = row.type === "add" ? "text-green" : row.type === "del" ? "text-red" : "text-line-strong"
  const gutter = selected
    ? "text-blue"
    : row.type === "add"
      ? "text-[#4e6b45]"
      : row.type === "del"
        ? "text-[#6b4a4e]"
        : "text-line-strong"
  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " "
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cn(
        "flex h-full items-stretch border-l-2",
        selected ? "border-blue" : "border-transparent",
        onPointerDown && "cursor-pointer select-none",
        bg
      )}
    >
      <span className={cn("w-10 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
        {row.oldLn ?? ""}
      </span>
      <span className={cn("w-10 shrink-0 select-none pr-2 text-right tabular-nums", gutter)}>
        {row.newLn ?? ""}
      </span>
      <span className={cn("w-4 shrink-0 select-none text-center", signFg)}>{sign}</span>
      <span className="whitespace-pre text-text-body">
        <HighlightedLine text={row.content} tokens={tokens} />
      </span>
    </div>
  )
}
