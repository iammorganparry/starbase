import { describe, expect, it } from "vitest"
import type { Hasher } from "./repo-key.js"
import { normaliseRemote, repoKeyFrom, repoKeyFromRemote, repoKeyFromRoots } from "./repo-key.js"

/**
 * A stand-in digest. The real one is injected by `GitService` (core is bundled
 * into the renderer, so it cannot reach for `node:crypto`). These tests are
 * about WHICH anchor is chosen and how it is normalised — the decisions two
 * teammates must agree on — not about the digest, so a deterministic fake keeps
 * them readable.
 */
const hash: Hasher = (input) => {
  let h = 0
  for (const ch of input) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(16).padStart(64, "0")
}

const ROOT_A = "9f2c1b7e4a6d8f0c3e5b7a9d1f3c5e7a9b1d3f5c"
const ROOT_B = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"

describe("repoKeyFromRoots", () => {
  it("gives the same key for the same root, however the clone was made", () => {
    // The property team sharing lives on: two machines, one repo, one key.
    expect(repoKeyFromRoots([ROOT_A], hash)).toStrictEqual(repoKeyFromRoots([ROOT_A], hash))
  })

  it("gives different keys for different repos", () => {
    expect(repoKeyFromRoots([ROOT_A], hash)?.key).not.toBe(repoKeyFromRoots([ROOT_B], hash)?.key)
  })

  it("is order-independent across multiple roots", () => {
    // Grafted or merged histories have several roots and `git rev-list` does not
    // guarantee a stable order across versions. An unstable pick would give two
    // teammates different keys for one repo — the exact failure this prevents.
    expect(repoKeyFromRoots([ROOT_A, ROOT_B], hash)).toStrictEqual(repoKeyFromRoots([ROOT_B, ROOT_A], hash))
  })

  it("never leaks the commit it hashed", () => {
    const key = repoKeyFromRoots([ROOT_A], hash)!.key
    expect(key).not.toContain(ROOT_A)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is null with no roots, rather than inventing an identity", () => {
    expect(repoKeyFromRoots([], hash)).toBeNull()
    expect(repoKeyFromRoots(["", "   "], hash)).toBeNull()
  })

  it("marks a root-derived key strong", () => {
    expect(repoKeyFromRoots([ROOT_A], hash)?.strength).toBe("strong")
  })
})

describe("normaliseRemote", () => {
  it("collapses every way of writing the same remote", () => {
    // Without this, the fallback key would differ between teammates purely by
    // how they happened to clone.
    const expected = "github.com/acme/api"
    for (const remote of [
      "git@github.com:acme/api.git",
      "https://github.com/acme/api",
      "https://github.com/acme/api.git",
      "ssh://git@github.com/acme/api/",
      "HTTPS://GitHub.com/Acme/API.git"
    ]) {
      expect(normaliseRemote(remote)).toBe(expected)
    }
  })

  it("keeps different repos distinct", () => {
    expect(normaliseRemote("git@github.com:acme/api.git")).not.toBe(
      normaliseRemote("git@github.com:acme/web.git")
    )
  })

  it("handles a path-style remote, which has no host at all", () => {
    // Local clones and submodules produce these, and a `file://` URL becomes one
    // once its scheme is stripped. A host-first parse silently returned "".
    expect(normaliseRemote("file:///srv/git/api.git")).toBe("/srv/git/api")
    expect(normaliseRemote("/srv/git/api/")).toBe("/srv/git/api")
  })

  it("keeps a port out of the identity", () => {
    expect(normaliseRemote("ssh://git@git.internal:2222/acme/api.git")).toBe(
      "git.internal/acme/api"
    )
  })
})

describe("repoKeyFromRemote", () => {
  it("marks a remote-derived key WEAK", () => {
    // Repo names are guessable, so a hashed remote is a far weaker pseudonym
    // than a hashed root commit. Recorded so a caller can decline to share on it.
    expect(repoKeyFromRemote("git@github.com:acme/api.git", hash)?.strength).toBe("weak")
  })

  it("agrees across clone styles", () => {
    expect(repoKeyFromRemote("git@github.com:acme/api.git", hash)?.key).toBe(
      repoKeyFromRemote("https://github.com/acme/api", hash)?.key
    )
  })

  it("is null for an empty remote", () => {
    expect(repoKeyFromRemote("", hash)).toBeNull()
  })
})

describe("repoKeyFrom", () => {
  it("prefers the root commit when one is available", () => {
    const key = repoKeyFrom({ roots: [ROOT_A], remote: "git@github.com:acme/api.git" }, hash)
    expect(key?.strength).toBe("strong")
    expect(key?.key).toBe(repoKeyFromRoots([ROOT_A], hash)?.key)
  })

  it("falls back to the remote for a shallow clone, and says it is weak", () => {
    // A shallow clone's `--max-parents=0` returns the shallow boundary, which
    // varies by depth — falling back is what stops two teammates deriving
    // different "strong" keys for one repo.
    const key = repoKeyFrom({ roots: [], remote: "git@github.com:acme/api.git" }, hash)
    expect(key?.strength).toBe("weak")
  })

  it("returns null when neither is available", () => {
    // A local-only shallow clone has no stable identity. Inventing one (a path
    // hash, say) would differ per machine while looking authoritative.
    expect(repoKeyFrom({ roots: [], remote: null }, hash)).toBeNull()
  })

  it("keeps the strong and weak keys for one repo distinct", () => {
    // They are not interchangeable, and a caller comparing them must not think
    // the same repo changed identity.
    const strong = repoKeyFrom({ roots: [ROOT_A], remote: "git@github.com:acme/api.git" }, hash)
    const weak = repoKeyFrom({ roots: [], remote: "git@github.com:acme/api.git" }, hash)
    expect(strong?.key).not.toBe(weak?.key)
  })
})
