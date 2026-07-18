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

  /**
   * The one that bites in production but never in a `.join("\n")` fixture. Real
   * `gh pr diff` output ends with a newline, so `split("\n")` yields a trailing
   * "" while still inside the last hunk. Counting it admits a phantom line one
   * past the file's end — and a finding the model mis-anchors there (the classic
   * end-of-file off-by-one) would 422 the ENTIRE review. The hunk header's
   * declared length is what bounds it out.
   */
  it("does not count the trailing newline's empty element as a line", () => {
    // `@@ -1 +1,2 @@` → new side is lines 1–2 only. The trailing \n must NOT
    // produce a postable line 3.
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n"
    expect(lines(diff, "a.ts")).toStrictEqual([1, 2])
  })

  it("counts identically whether or not the diff ends in a newline", () => {
    const body = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " one", "+two", " three"]
    expect(lines(body.join("\n"), "a.ts")).toStrictEqual(lines(body.join("\n") + "\n", "a.ts"))
  })

  /**
   * The general form of the same guard: a body line beyond the header's declared
   * new-side length is outside the hunk, so it must not be counted — even a
   * well-formed-looking `+` line. (A malformed diff, but the whole point of this
   * function is not to trust its input.)
   */
  it("stops counting once the hunk's declared new-side length is spent", () => {
    const diff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      "+three-should-not-count" // one past the declared +1,2
    ].join("\n")
    expect(lines(diff, "a.ts")).toStrictEqual([1, 2])
  })

  it("counts trailing removals within the hunk without inventing a new-side line", () => {
    // `@@ -1,3 +1,1 @@`: new side is line 1 only; two removals follow, then a
    // trailing newline. None of those may add to the postable set.
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,1 @@\n one\n-two\n-three\n"
    expect(lines(diff, "a.ts")).toStrictEqual([1])
  })

  it("handles a no-newline marker followed by the trailing newline", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+only\n\\ No newline at end of file\n"
    expect(lines(diff, "a.ts")).toStrictEqual([1])
  })
})
