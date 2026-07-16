import * as React from "react"
import { cn } from "../lib/cn.js"
import { parseUnifiedDiff, type DiffRow } from "../diff/parse.js"
import { InlineCommentComposer } from "./inline-comment-composer.js"

interface Selection {
  /** Anchor + head row indices into the rendered line rows (drag origin + current). */
  anchor: number
  head: number
}

const lo = (s: Selection) => Math.min(s.anchor, s.head)
const hi = (s: Selection) => Math.max(s.anchor, s.head)
const inRange = (s: Selection | null, i: number) => s !== null && i >= lo(s) && i <= hi(s)

type LineRow = Extract<DiffRow, { kind: "line" }>

/** The line number a comment anchors to for a row (new side preferred, else old). */
const lineNoOf = (r: LineRow): number => r.newLn ?? r.oldLn ?? 0

/**
 * A single-file unified-diff renderer with line-range selection. Click a line to
 * select it, drag to extend a block, or shift-click to extend from the anchor.
 * The inline comment composer opens only once the drag ends (so it never blocks
 * the drag), anchored below the selection. Non-virtualized — one file is small.
 */
export function ReviewDiff({
  path,
  diff,
  connected,
  routeTargetSession = null,
  onAddDraft,
  onRevert,
  scroll = true
}: {
  path: string
  diff: string
  connected: boolean
  routeTargetSession?: string | null
  onAddDraft: (draft: {
    path: string
    startLine: number
    endLine: number
    body: string
    routeToAgent: boolean
  }) => void
  /** Revert the selected lines (only offered for a session's own uncommitted diff). */
  onRevert?: (range: { path: string; startLine: number; endLine: number }) => void
  /**
   * When true (default) the renderer owns its own scroll area. Set false to render
   * inline at natural height so an outer container scrolls all files continuously.
   */
  scroll?: boolean
}) {
  const rows = React.useMemo(() => parseUnifiedDiff(diff).filter((r) => r.kind !== "file"), [diff])

  const [selection, setSelection] = React.useState<Selection | null>(null)
  // The composer opens only after a drag/click completes — never mid-drag, or it
  // would inject a tall element between the lines you're trying to drag across.
  const [open, setOpen] = React.useState(false)
  const dragging = React.useRef(false)

  // End a drag wherever the pointer is released, and open the composer then.
  React.useEffect(() => {
    const stop = () => {
      if (dragging.current) {
        dragging.current = false
        setOpen(true)
      }
    }
    window.addEventListener("pointerup", stop)
    return () => window.removeEventListener("pointerup", stop)
  }, [])

  // A fresh file clears any in-progress selection.
  React.useEffect(() => {
    setSelection(null)
    setOpen(false)
  }, [path])

  const clear = () => {
    setSelection(null)
    setOpen(false)
  }

  const rangeOf = (s: Selection) => {
    const a = rows[lo(s)] as LineRow
    const b = rows[hi(s)] as LineRow
    const startLine = lineNoOf(a)
    const endLine = lineNoOf(b)
    return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) }
  }

  const submit = (draft: { body: string; routeToAgent: boolean }) => {
    if (selection === null) return
    onAddDraft({ path, ...rangeOf(selection), ...draft })
    clear()
  }

  const revert = () => {
    if (selection === null || !onRevert) return
    onRevert({ path, ...rangeOf(selection) })
    clear()
  }

  const composerAnchor = selection === null ? null : hi(selection)

  // Size to the widest line (`w-max`) but never narrower than the viewport
  // (`min-w-full`) so every row's background + selection highlight spans the full
  // line — not just the visible width — when scrolled horizontally.
  const body = (
    <div className="w-max min-w-full">
      {rows.map((row, i) => {
        if (row.kind === "hunk") {
          return (
            <div
              key={row.key}
              className="w-full border-y border-hairline bg-sunken px-4 py-[5px] font-mono text-[10.5px] text-blue"
            >
              {row.header}
            </div>
          )
        }
        return (
          <React.Fragment key={row.key}>
            <DiffLine
              row={row}
              selected={inRange(selection, i)}
              onPointerDown={(e) => {
                // Suppress native text selection so the drag selects lines cleanly.
                e.preventDefault()
                setOpen(false)
                if (e.shiftKey && selection !== null) {
                  setSelection({ anchor: selection.anchor, head: i })
                  dragging.current = true
                } else {
                  setSelection({ anchor: i, head: i })
                  dragging.current = true
                }
              }}
              onPointerEnter={() => {
                if (!dragging.current) return
                setSelection((sel) => (sel === null ? sel : { ...sel, head: i }))
              }}
            />
            {open && composerAnchor === i && selection !== null && (
              <div className="py-3 pl-[100px] pr-4">
                <InlineCommentComposer
                  path={path}
                  startLine={rangeOf(selection).startLine}
                  endLine={rangeOf(selection).endLine}
                  connected={connected}
                  routeTargetSession={routeTargetSession}
                  onCancel={clear}
                  onAddToReview={submit}
                  onCommentAndSend={submit}
                  onRevert={onRevert ? revert : undefined}
                />
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )

  // `scroll`: own the vertical scroll (single-file view) vs render inline so an
  // outer container scrolls every file continuously.
  return scroll ? <div className="min-h-0 flex-1 overflow-auto">{body}</div> : body
}

function DiffLine({
  row,
  selected,
  onPointerDown,
  onPointerEnter
}: {
  row: LineRow
  selected: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerEnter: () => void
}) {
  const add = row.type === "add"
  const del = row.type === "del"
  const bg = selected ? "bg-blue/[0.08]" : add ? "bg-green/[0.13]" : del ? "bg-red/[0.12]" : ""
  const fg = add ? "text-green" : del ? "text-red" : "text-muted-foreground"
  const gutter = selected
    ? "text-blue"
    : add
      ? "text-[#4e6b45]"
      : del
        ? "text-[#6b4a4e]"
        : "text-line-strong"
  const sign = add ? "+ " : del ? "- " : "  "

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cn(
        "flex w-full cursor-pointer select-none border-l-2 font-mono text-[12px] leading-[1.85]",
        selected ? "border-blue" : "border-transparent",
        bg
      )}
    >
      <span className={cn("w-[42px] flex-none select-none pr-3 text-right tabular-nums", gutter)}>
        {row.oldLn ?? ""}
      </span>
      <span className={cn("w-[42px] flex-none select-none pr-3 text-right tabular-nums", gutter)}>
        {row.newLn ?? ""}
      </span>
      <span className={cn("flex-1 whitespace-pre pl-3.5", fg)}>
        {sign}
        {row.content}
      </span>
    </div>
  )
}
