import { sep } from "node:path"
import { describe, expect, it } from "vitest"
import { isWorkspacePath } from "./git.js"

/**
 * The rule that decides whether a resolved `node_modules` entry is the repo's
 * OWN source (re-point it at the worktree) or an installed dependency (share the
 * origin's copy). Two separate bugs have turned on getting this wrong, so it is
 * tested directly rather than only through `createWorktree`.
 *
 * Note on Windows: the implementation uses `path.sep` rather than a hardcoded
 * "/", because `path.join` yields backslashes there and a "/"-terminated prefix
 * test is always false — which would classify every workspace package as
 * third-party and silently restore the origin-resolution bug. That path cannot
 * be exercised from a POSIX test run; these cases pin the platform-independent
 * rules, and the separator handling is correct by construction.
 */

const p = (...parts: ReadonlyArray<string>) => parts.join(sep)
const REPO = p("", "src", "repo")

describe("isWorkspacePath", () => {
  it("accepts repo source outside any node_modules", () => {
    expect(isWorkspacePath(REPO, p(REPO, "packages", "lib"))).toBe(true)
    expect(isWorkspacePath(REPO, p(REPO, "apps", "web"))).toBe(true)
  })

  it("rejects anything under the ROOT node_modules", () => {
    expect(isWorkspacePath(REPO, p(REPO, "node_modules", "left-pad"))).toBe(false)
  })

  it("rejects anything under a NESTED node_modules", () => {
    // pnpm gives each package its own install. A root-only test would call this
    // repo source and re-point it at a path holding no package at all.
    expect(isWorkspacePath(REPO, p(REPO, "packages", "lib", "node_modules", "dep"))).toBe(false)
    expect(isWorkspacePath(REPO, p(REPO, "node_modules", ".pnpm", "x", "node_modules", "y"))).toBe(false)
  })

  it("rejects a sibling directory that merely shares a name prefix", () => {
    // `/src/repo-backup` starts with `/src/repo` as TEXT but is a different
    // tree; treating it as contained would mirror another checkout's packages.
    expect(isWorkspacePath(REPO, p("", "src", "repo-backup", "packages", "lib"))).toBe(false)
  })

  it("rejects paths outside the repo, and the repo root itself", () => {
    expect(isWorkspacePath(REPO, p("", "elsewhere", "lib"))).toBe(false)
    // The root is not a package — re-pointing it would alias the whole tree.
    expect(isWorkspacePath(REPO, REPO)).toBe(false)
  })

  it("does not mistake a package NAMED like the marker for the marker", () => {
    // Only a full path SEGMENT counts. `node_modules_old` is an ordinary dir.
    expect(isWorkspacePath(REPO, p(REPO, "node_modules_old", "lib"))).toBe(true)
  })
})
