import { describe, expect, it } from "vitest"
import { postableLines } from "./gh.js"

/**
 * `postableLines` is the guard standing between a language model's line numbers
 * and an all-or-nothing GitHub API. If it says a line is postable and GitHub
 * disagrees, the ENTIRE review 422s and every nit in the batch is lost — so the
 * behaviour that matters is: only NEW-side lines, correct numbering across
 * multiple hunks, and no false positives from diff-shaped content inside a diff.
 */

const lines = (diff: string, path: string): number[] =>
  [...(postableLines(diff).get(path) ?? [])].sort((a, b) => a - b)

describe("postableLines", () => {
  it("counts added and context lines, never removed ones", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1", // new line 1 — context
      "-const b = 2", // left side only — must NOT be postable
      "+const b = 3", // new line 2 — added
      " const c = 4" // new line 3 — context
    ].join("\n")
    expect(lines(diff, "src/a.ts")).toStrictEqual([1, 2, 3])
  })

  it("restarts numbering at each hunk header", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " one",
      "+two",
      "@@ -40,2 +41,2 @@",
      " forty",
      "+forty-one"
    ].join("\n")
    expect(lines(diff, "src/a.ts")).toStrictEqual([1, 2, 41, 42])
  })

  it("handles a hunk header with no line counts", () => {
    const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -7 +9 @@", "+only"].join("\n")
    expect(lines(diff, "src/a.ts")).toStrictEqual([9])
  })

  it("keeps numbering aligned across a blank context line", () => {
    // `gh pr diff` emits a context blank line as "" — its single space stripped.
    // Miscounting it shifts every later line in the hunk by one, which anchors a
    // comment to the wrong code rather than failing loudly.
    const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " one", "", "+three"].join(
      "\n"
    )
    expect(lines(diff, "src/a.ts")).toStrictEqual([1, 2, 3])
  })

  it("tracks each file in a multi-file diff separately", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+alpha",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -10 +10 @@",
      "+beta"
    ].join("\n")
    expect(lines(diff, "src/a.ts")).toStrictEqual([1])
    expect(lines(diff, "src/b.ts")).toStrictEqual([10])
  })

  it("yields nothing for a deleted file", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two"
    ].join("\n")
    expect(postableLines(diff).size).toBe(0)
  })

  /**
   * The subtle one. A PR that touches a .patch fixture — or this repo's own diff
   * tests — carries diff headers INSIDE a hunk body, where they arrive prefixed:
   * `+++ b/nested.ts` is an added line whose content is `++ b/nested.ts`. Reading
   * it as a file header would attribute every following line to a file the PR
   * never touched, and post comments into the void.
   */
  it("does not read diff headers inside a hunk body as real headers", () => {
    const diff = [
      "diff --git a/test/fixture.patch b/test/fixture.patch",
      "--- a/test/fixture.patch",
      "+++ b/test/fixture.patch",
      "@@ -1,3 +1,4 @@",
      "+--- a/nested.ts",
      "++++ b/nested.ts",
      "+@@ -1 +1 @@",
      "+-old"
    ].join("\n")
    const map = postableLines(diff)
    expect([...map.keys()]).toStrictEqual(["test/fixture.patch"])
    expect(lines(diff, "test/fixture.patch")).toStrictEqual([1, 2, 3, 4])
  })

  it("ignores a no-newline marker without consuming a line number", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " one",
      "+two",
      "\\ No newline at end of file"
    ].join("\n")
    expect(lines(diff, "src/a.ts")).toStrictEqual([1, 2])
  })

  it("is empty for an empty diff", () => {
    expect(postableLines("").size).toBe(0)
  })
})
