import { describe, expect, it } from "vitest"
import { teeLogPath, teeRewrite } from "./bash-tee.js"

describe("teeLogPath", () => {
  it("names a deterministic file under the given dir, keyed by the tool-use id", () => {
    expect(teeLogPath("toolu_abc123", "/tmp/x")).toBe("/tmp/x/starbase-tee-toolu_abc123.log")
  })

  it("strips characters that could escape the temp dir or break the shell", () => {
    // A `/` or `..` in the id must not walk out of the temp dir.
    expect(teeLogPath("../../etc/passwd", "/tmp/x")).toBe("/tmp/x/starbase-tee-______etc_passwd.log")
    expect(teeLogPath("a b;c", "/tmp/x")).toBe("/tmp/x/starbase-tee-a_b_c.log")
  })

  it("is stable across calls, so the watcher and the cleanup name the same file", () => {
    expect(teeLogPath("t1", "/d")).toBe(teeLogPath("t1", "/d"))
  })
})

describe("teeRewrite", () => {
  it("groups the whole command so a compound tees as one unit, and preserves the exit code", () => {
    expect(teeRewrite("a && b", "/tmp/x.log")).toBe(
      "{\na && b\n} 2>&1 | tee '/tmp/x.log'\n( exit ${PIPESTATUS[0]} )"
    )
  })

  it("merges stderr into the teed stream, so the card shows both", () => {
    // The `2>&1` sits on the group, before the pipe — so stderr is captured too.
    expect(teeRewrite("pnpm test", "/l")).toContain("} 2>&1 | tee ")
  })

  it("restores the command's real status rather than tee's success", () => {
    expect(teeRewrite("false", "/l")).toContain("( exit ${PIPESTATUS[0]} )")
  })

  it("single-quotes the log path and escapes an embedded quote", () => {
    expect(teeRewrite("x", "/tmp/o'brien.log")).toContain("tee '/tmp/o'\\''brien.log'")
  })

  it("delimits the group with newlines, so a command ending in a comment still runs", () => {
    // With `;` as the delimiter, `cmd # note ;` would comment out the closing brace.
    const rewritten = teeRewrite("echo hi # a note", "/l")
    expect(rewritten.startsWith("{\necho hi # a note\n}")).toBe(true)
  })
})
