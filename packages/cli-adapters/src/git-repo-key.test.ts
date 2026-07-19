import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { GitService } from "./git.js"

/**
 * Repo identity against REAL git, because this is the one thing that must hold
 * across machines: two teammates who clone the same repository have to derive
 * the same key, or their evidence silently shards into two half-empty knowledge
 * bases that look like sparse data rather than a bug.
 *
 * Unit tests cover the hashing; only real git can tell us whether the commands
 * behave the way the design assumes — particularly on a shallow clone.
 */

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, stdio: "ignore" })

let seq = 0

/**
 * An origin repo with two commits, so a shallow clone has something to truncate.
 *
 * `marker` makes each repo's root commit genuinely distinct. Caught by the
 * "different repos" test: a git commit SHA is derived from tree + author +
 * timestamp + message, so two fixtures built identically within the same second
 * produce the SAME root commit — and therefore the same repo key. That is
 * correct behaviour for a content-addressed identity (identical repos ARE
 * identical), but it makes for a fixture that asserts nothing.
 */
const makeOrigin = (): string => {
  const marker = `repo-${seq++}-${process.pid}`
  const path = temp("starbase-origin-")
  git(path, "init", "-q")
  git(path, "config", "user.email", "t@example.com")
  git(path, "config", "user.name", "T")
  writeFileSync(join(path, "a.txt"), `${marker}\n`)
  git(path, "add", "-A")
  git(path, "commit", "-qm", `first ${marker}`)
  writeFileSync(join(path, "b.txt"), "two\n")
  git(path, "add", "-A")
  git(path, "commit", "-qm", "second")
  return path
}

const keyFor = (repoPath: string) =>
  Effect.runPromise(
    GitService.repoKey(repoPath).pipe(
      Effect.provide(GitService.Default),
      Effect.provide(NodeContext.layer)
    )
  )

describe("GitService.repoKey", () => {
  it("gives two clones of one repo the SAME key, in differently-named folders", async () => {
    const origin = makeOrigin()
    const alice = join(temp("starbase-alice-"), "our-api")
    const bob = join(temp("starbase-bob-"), "api-checkout")
    execFileSync("git", ["clone", "-q", origin, alice], { stdio: "ignore" })
    execFileSync("git", ["clone", "-q", origin, bob], { stdio: "ignore" })

    const [a, b] = await Promise.all([keyFor(alice), keyFor(bob)])
    expect(a?.key).toBe(b?.key)
    expect(a?.strength).toBe("strong")
  })

  it("gives different repos different keys", async () => {
    const [a, b] = await Promise.all([keyFor(makeOrigin()), keyFor(makeOrigin())])
    expect(a?.key).not.toBe(b?.key)
  })

  it("survives a rename of the remote", async () => {
    const origin = makeOrigin()
    const clone = join(temp("starbase-clone-"), "api")
    execFileSync("git", ["clone", "-q", origin, clone], { stdio: "ignore" })
    const before = await keyFor(clone)
    // The repo moved host/name; the root commit did not change.
    git(clone, "remote", "set-url", "origin", "git@github.com:acme/renamed.git")
    expect((await keyFor(clone))?.key).toBe(before?.key)
  })

  it("falls back to a WEAK key on a shallow clone rather than a divergent strong one", async () => {
    // The trap: `rev-list --max-parents=0` on a shallow clone returns the
    // shallow BOUNDARY, which varies by depth. Trusting it would hand two
    // teammates different "strong" keys for the same repository.
    const origin = makeOrigin()
    const shallow = join(temp("starbase-shallow-"), "api")
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, shallow], {
      stdio: "ignore"
    })
    const key = await keyFor(shallow)
    expect(key?.strength).toBe("weak")

    // And it must not collide with the full clone's strong key.
    const full = join(temp("starbase-full-"), "api")
    execFileSync("git", ["clone", "-q", origin, full], { stdio: "ignore" })
    expect(key?.key).not.toBe((await keyFor(full))?.key)
  })

  it("returns null for a directory that is not a repo", async () => {
    expect(await keyFor(temp("starbase-notrepo-"))).toBeNull()
  })
})
