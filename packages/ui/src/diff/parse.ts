import parseDiff from "parse-diff"
import type { File as DiffFile } from "parse-diff"

/**
 * The diff engine flattens parsed files into a single list of rows so a
 * virtualizer can window over tens of thousands of lines cheaply — the same
 * approach GitHub / opencode's desktop diff viewer take.
 */
export type DiffRow =
  | {
      kind: "file"
      key: string
      path: string
      status: "modified" | "added" | "deleted" | "renamed"
      additions: number
      deletions: number
    }
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line"
      key: string
      type: "add" | "del" | "normal"
      oldLn: number | null
      newLn: number | null
      content: string
    }

function fileStatus(f: DiffFile): "modified" | "added" | "deleted" | "renamed" {
  if (f.new) return "added"
  if (f.deleted) return "deleted"
  if (f.from && f.to && f.from !== f.to) return "renamed"
  return "modified"
}

function filePath(f: DiffFile): string {
  return f.to && f.to !== "/dev/null" ? f.to : (f.from ?? "unknown")
}

/** Flatten already-parsed diff files into virtualizable rows. */
export function flattenFiles(files: ReadonlyArray<DiffFile>): DiffRow[] {
  const rows: DiffRow[] = []
  files.forEach((file, fi) => {
    const path = filePath(file)
    rows.push({
      kind: "file",
      key: `f${fi}`,
      path,
      status: fileStatus(file),
      additions: file.additions,
      deletions: file.deletions
    })
    file.chunks.forEach((chunk, ci) => {
      rows.push({ kind: "hunk", key: `f${fi}h${ci}`, header: chunk.content })
      chunk.changes.forEach((change, li) => {
        // parse-diff keeps the leading +/-/space marker on `content`.
        const content = change.content.length > 0 ? change.content.slice(1) : ""
        rows.push({
          kind: "line",
          key: `f${fi}h${ci}l${li}`,
          type: change.type,
          oldLn: change.type === "add" ? null : (change as { ln?: number; ln1?: number }).ln1 ?? (change as { ln?: number }).ln ?? null,
          newLn: change.type === "del" ? null : (change as { ln?: number; ln2?: number }).ln2 ?? (change as { ln?: number }).ln ?? null,
          content
        })
      })
    })
  })
  return rows
}

/** Parse a raw unified-diff/patch string into virtualizable rows. */
export function parseUnifiedDiff(patch: string): DiffRow[] {
  return flattenFiles(parseDiff(patch))
}
