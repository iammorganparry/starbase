import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { gitOpWidget, parseGitOp } from "./git-op.js"

const ctx = (output: string | undefined, command = 'git commit -m "fix: guard webhook payload" && git push', status: "running" | "success" | "error" = "success") => ({
  command: parseCommand(command),
  output,
  status
})

const COMMIT = `[feat/oauth 3af12e9] fix: guard webhook payload
 3 files changed, 47 insertions(+), 12 deletions(-)
 create mode 100644 src/api/webhook.test.ts
`

const PUSH = `Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
To github.com:trigify/starbase.git
   3af12e9..9d4c1a2  feat/oauth -> feat/oauth
`

describe("classify", () => {
  const matches = (cmd: string) => gitOpWidget.match(parseCommand(cmd))

  it.each(["git commit -m x", "git push", "git status", "git rebase main", 'git commit -m "x" && git push'])(
    "routes %j to the git widget",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["gh pr create", "pnpm install", "vitest run", "git"])("leaves %j to another widget", (cmd) => {
    expect(matches(cmd)).toBe(false)
  })
})

describe("parseGitOp", () => {
  it("reads a commit and the push that followed it from one combined command", () => {
    const p = parseGitOp(ctx(`${COMMIT}\n${PUSH}`))!
    expect(p.branch).toBe("feat/oauth")
    expect(p.sha).toBe("3af12e9")
    expect(p.subject).toBe("fix: guard webhook payload")
    expect(p.filesChanged).toBe(3)
    expect(p.insertions).toBe(47)
    expect(p.deletions).toBe(12)
    expect(p.push).toEqual({ remote: "github.com:trigify/starbase.git", range: "3af12e9..9d4c1a2" })
  })

  it("summarises a commit with no push", () => {
    const p = parseGitOp(ctx(COMMIT, 'git commit -m "fix: guard webhook payload"'))!
    expect(p.sha).toBe("3af12e9")
    expect(p.push).toBeNull()
  })

  it("summarises a push with no commit, taking the branch from the ref line", () => {
    const p = parseGitOp(ctx(PUSH, "git push"))!
    expect(p.sha).toBeNull()
    expect(p.subject).toBeNull()
    expect(p.branch).toBe("feat/oauth")
    expect(p.filesChanged).toBeNull()
    expect(p.push!.range).toBe("3af12e9..9d4c1a2")
  })

  it("names the remote branch when the command named the remote", () => {
    const p = parseGitOp(ctx(PUSH, "git push -u origin feat/oauth"))!
    expect(p.push!.remote).toBe("origin/feat/oauth")
  })

  it("prefers the tracking ref git printed over anything inferred", () => {
    const out = `${PUSH}branch 'feat/oauth' set up to track 'upstream/feat/oauth'.\n`
    const p = parseGitOp(ctx(out, "git push -u origin feat/oauth"))!
    expect(p.push!.remote).toBe("upstream/feat/oauth")
  })

  it("has no range for a branch pushed for the first time", () => {
    const out = "To github.com:trigify/starbase.git\n * [new branch]      feat/oauth -> feat/oauth\n"
    const p = parseGitOp(ctx(out, "git push"))!
    expect(p.push).toEqual({ remote: "github.com:trigify/starbase.git", range: null })
  })

  it("renders no file rows when the command never asked for per-file stats", () => {
    expect(parseGitOp(ctx(COMMIT, "git commit -m x"))!.files).toHaveLength(0)
  })

  it("takes exact per-file counts from --numstat", () => {
    const out = `18\t4\tsrc/api/webhook.ts\n25\t8\tsrc/api/webhook.test.ts\n${COMMIT}`
    const p = parseGitOp(ctx(out, "git commit -m x"))!
    expect(p.files).toEqual([
      { path: "src/api/webhook.ts", added: 18, removed: 4 },
      { path: "src/api/webhook.test.ts", added: 25, removed: 8 }
    ])
  })

  it("reads an unscaled --stat histogram, where the glyphs are the real counts", () => {
    const out = ` src/api/webhook.ts | 6 ++++--\n${COMMIT}`
    const p = parseGitOp(ctx(out, "git commit --stat -m x"))!
    expect(p.files).toEqual([{ path: "src/api/webhook.ts", added: 4, removed: 2 }])
  })

  it("drops a scaled --stat bar rather than report the proportion as a count", () => {
    // git caps the bar at the terminal width, so 220 changes render as ~20 glyphs.
    const out = ` src/api/webhook.ts | 220 ++++++++--\n${COMMIT}`
    expect(parseGitOp(ctx(out, "git commit --stat -m x"))!.files).toHaveLength(0)
  })

  it("declines git sub-commands that print no summary, so the plain card shows them", () => {
    const status = "On branch feat/oauth\nnothing to commit, working tree clean\n"
    expect(parseGitOp(ctx(status, "git status"))).toBeNull()
  })

  it("declines when nothing has been printed yet", () => {
    expect(parseGitOp(ctx(undefined, "git push", "running"))).toBeNull()
  })

  it("declines a rejected push, which has no summary to redraw", () => {
    const out = " ! [rejected]        feat/oauth -> feat/oauth (fetch first)\nerror: failed to push some refs\n"
    expect(parseGitOp(ctx(out, "git push", "error"))).toBeNull()
  })

  it("declines an up-to-date push, which moved nothing", () => {
    expect(parseGitOp(ctx("Everything up-to-date\n", "git push"))).toBeNull()
  })
})
