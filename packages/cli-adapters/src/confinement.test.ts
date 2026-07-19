import { describe, expect, it } from "vitest"
import { escapingPath } from "./confinement.js"

const CWD = "/repos/widget"

describe("escapingPath", () => {
  it("allows paths inside the worktree", () => {
    expect(escapingPath(CWD, { file_path: "/repos/widget/src/a.ts" })).toBeNull()
    expect(escapingPath(CWD, { path: "/repos/widget" })).toBeNull()
  })

  it("catches the read that actually happened", () => {
    // A planning proposer inferred this path from the operator's user-level
    // CLAUDE.md and read 403 lines of an unrelated private repository.
    expect(escapingPath(CWD, { file_path: "/Users/someone/repos/clive/README.md" })).toBe(
      "/Users/someone/repos/clive/README.md"
    )
  })

  it("is not fooled by a sibling that shares a prefix", () => {
    // Without a separator check, `/repos/widget-secrets` reads as inside
    // `/repos/widget` — a string comparison that quietly leaks a whole repo.
    expect(escapingPath(CWD, { path: "/repos/widget-secrets/.env" })).toBe(
      "/repos/widget-secrets/.env"
    )
  })

  it("catches a traversal dressed up as an inside path", () => {
    expect(escapingPath(CWD, { file_path: "/repos/widget/../other/secret.txt" })).toBe(
      "/repos/widget/../other/secret.txt"
    )
  })

  it("leaves relative paths alone — they cannot escape by construction", () => {
    // They resolve against cwd, so judging them would only produce false
    // positives on ordinary tool calls.
    expect(escapingPath(CWD, { file_path: "src/a.ts" })).toBeNull()
  })

  it("treats /tmp and /private/tmp as the same place", () => {
    // macOS resolves one to the other and the two spellings mix freely, so a
    // cwd captured one way and a path reported the other must not read as an
    // escape from the directory it is actually in.
    expect(escapingPath("/tmp/wt", { file_path: "/private/tmp/wt/src/a.ts" })).toBeNull()
    expect(escapingPath("/private/tmp/wt", { file_path: "/tmp/wt/src/a.ts" })).toBeNull()
  })

  it("covers the search root, not just edit targets", () => {
    // Confining writes while leaving a repo-wide grep unrestricted would miss
    // the case actually seen.
    expect(escapingPath(CWD, { pattern: "secret", path: "/etc" })).toBe("/etc")
  })

  it("ignores tool calls with no path at all", () => {
    expect(escapingPath(CWD, { command: "ls" })).toBeNull()
    expect(escapingPath("", { file_path: "/anywhere" })).toBeNull()
  })
})

describe("what confinement does NOT cover", () => {
  it("does not inspect shell commands, which is why the flag is named for FILE tools", () => {
    // `Bash` takes a command string, not a path, so an agent that can run
    // commands reaches the whole filesystem regardless of this check. The plan
    // executor is the one caller that needs Bash — to build and test — so its
    // steps are confined for file tools and unconfined for shell.
    //
    // Pinned as a test rather than left as a comment because the previous name
    // (`confineToCwd`) implied a guarantee this never gave, and a reader who
    // assumes total confinement will make an unsafe decision somewhere else.
    // Confining the shell needs the harness's own sandbox, not string
    // inspection of commands.
    expect(escapingPath(CWD, { command: "cat /etc/passwd" })).toBeNull()
    expect(escapingPath(CWD, { command: "cd ~ && rm -rf notes" })).toBeNull()
  })
})
