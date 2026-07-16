import { describe, expect, it } from "vitest"
import { parseDiffHunk } from "./parse-diff-hunk.js"

/** The real `diffHunk` GitHub returned for the Greptile thread on starbase#36. */
const REAL_HUNK = `@@ -27,9 +28,19 @@ export function ConversationPane({
   onRestore?: (sessionId: string) => void
   /** Permanently delete this session (the banner). */
   onDelete?: (sessionId: string) => void
+  /** Notify once the composer has consumed the one-shot initial prompt. */
+  onInitialPromptConsumed?: (sessionId: string) => void
 }) {
   const convo = useConversation(session)

+  // The prefilled task is one-shot: the composer seeds from it on mount, then we
+  // clear it (backend + app state) so switching sessions never re-seeds.
+  useEffect(() => {`

describe("parseDiffHunk", () => {
  it("seeds both gutters from the @@ header and advances them per line type", () => {
    const lines = parseDiffHunk(REAL_HUNK, Infinity)
    // Header is `-27,9 +28,19`, so the first context line is old 27 / new 28.
    expect(lines[0]).toStrictEqual({
      type: "normal",
      oldLn: 27,
      newLn: 28,
      content: "  onRestore?: (sessionId: string) => void"
    })
    // An added line advances only the new side and has no old number.
    const firstAdd = lines.find((l) => l.type === "add")
    expect(firstAdd).toStrictEqual({
      type: "add",
      oldLn: null,
      newLn: 31,
      content: "  /** Notify once the composer has consumed the one-shot initial prompt. */"
    })
    // …and the context line after two adds keeps the old side where it was.
    const afterAdds = lines.find((l) => l.content === "}) {")
    expect(afterAdds).toMatchObject({ type: "normal", oldLn: 30, newLn: 33 })
  })

  it("advances only the old side on a deletion", () => {
    const lines = parseDiffHunk(`@@ -10,3 +10,2 @@\n ctx\n-gone\n after`, Infinity)
    expect(lines).toStrictEqual([
      { type: "normal", oldLn: 10, newLn: 10, content: "ctx" },
      { type: "del", oldLn: 11, newLn: null, content: "gone" },
      { type: "normal", oldLn: 12, newLn: 11, content: "after" }
    ])
  })

  it("truncates to the tail, the way GitHub renders a long hunk", () => {
    const long = ["@@ -1,20 +1,20 @@", ...Array.from({ length: 20 }, (_, i) => ` line${i + 1}`)].join("\n")
    const lines = parseDiffHunk(long)
    expect(lines).toHaveLength(8)
    // The tail, not the head — the anchor sits at the END of a diffHunk.
    expect(lines[0]?.content).toBe("line13")
    expect(lines.at(-1)?.content).toBe("line20")
    expect(parseDiffHunk(long, Infinity)).toHaveLength(20)
  })

  it("keeps blank context lines, which git emits with no leading space", () => {
    const lines = parseDiffHunk(`@@ -1,3 +1,3 @@\n a\n\n b`, Infinity)
    expect(lines.map((l) => l.content)).toStrictEqual(["a", "", "b"])
    expect(lines[1]).toMatchObject({ type: "normal", oldLn: 2, newLn: 2 })
  })

  it("skips the no-newline marker and tolerates a headerless or empty hunk", () => {
    expect(parseDiffHunk(`@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b`, Infinity)).toStrictEqual([
      { type: "del", oldLn: 1, newLn: null, content: "a" },
      { type: "add", oldLn: null, newLn: 1, content: "b" }
    ])
    expect(parseDiffHunk("")).toStrictEqual([])
    expect(parseDiffHunk("no header here\njust text")).toStrictEqual([])
  })
})
