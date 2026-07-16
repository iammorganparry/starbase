/** One line of a parsed hunk, carrying BOTH gutters (GitHub shows old + new). */
export interface ThreadHunkLine {
  type: "add" | "del" | "normal"
  /** Line number in the pre-image, or null on an added line. */
  oldLn: number | null
  /** Line number in the post-image, or null on a deleted line. */
  newLn: number | null
  content: string
}

/** `@@ -27,9 +28,19 @@ optional section heading` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * GitHub renders only the tail of a thread's hunk — the lines immediately around
 * the comment's anchor, not the whole hunk. Real hunks run long (a thread on
 * starbase#36 carries a 137-line `diffHunk`), so without this a single thread
 * would dwarf the conversation it belongs to.
 */
const DEFAULT_TAIL = 8

/**
 * Parse a GitHub `diffHunk` string into dual-gutter lines.
 *
 * The `@@ -a,b +c,d @@` header seeds both counters; context lines advance both,
 * `+` only the new side, `-` only the old. Lines before the header (there
 * shouldn't be any) and the `\ No newline at end of file` marker are skipped.
 *
 * Returns the LAST `tail` lines, mirroring GitHub — pass `Infinity` for all.
 */
export const parseDiffHunk = (hunk: string, tail: number = DEFAULT_TAIL): ReadonlyArray<ThreadHunkLine> => {
  const lines: Array<ThreadHunkLine> = []
  let oldLn = 0
  let newLn = 0
  let seenHeader = false

  for (const raw of hunk.split("\n")) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      oldLn = Number(header[1])
      newLn = Number(header[2])
      seenHeader = true
      continue
    }
    if (!seenHeader) continue
    if (raw.startsWith("\\")) continue // "\ No newline at end of file"

    const marker = raw[0]
    const content = raw.slice(1)
    if (marker === "+") {
      lines.push({ type: "add", oldLn: null, newLn, content })
      newLn += 1
    } else if (marker === "-") {
      lines.push({ type: "del", oldLn, newLn: null, content })
      oldLn += 1
    } else {
      // A context line — including the empty string, which is a blank context
      // line whose leading space git omits.
      lines.push({ type: "normal", oldLn, newLn, content })
      oldLn += 1
      newLn += 1
    }
  }

  return tail === Infinity || lines.length <= tail ? lines : lines.slice(-tail)
}
