/**
 * A repository's identity, derived identically on every teammate's machine.
 *
 * Learnings are scored per repository, and pooled across a team working on the
 * same one. That only works if two people independently produce the SAME key —
 * and nothing already in the app can do that. `Session.repo` is the local folder
 * name (see `CreateSessionInput.repoName`, "the repo's folder name"), so
 * teammates who cloned into differently-named directories would silently shard
 * their evidence into two half-empty knowledge bases. That failure looks exactly
 * like sparse data rather than a bug, which is what makes it worth this much
 * care.
 *
 * The root commit is the right anchor:
 *  - identical across every clone, however it was made
 *  - survives repo renames and remote moves
 *  - ~160 bits of entropy, so it cannot be guessed
 *  - **computable only by someone who already has the repository**
 *
 * That last property is the privacy story: a server can pool a team's evidence
 * without ever learning a repo's name, and nobody can probe for whether a given
 * project is in the system unless they already have the code.
 */

/**
 * How trustworthy a key is as a shared identity.
 *
 * `weak` keys come from a normalised remote URL, used when a shallow clone has
 * no reachable root commit. Repo names are guessable, so a hashed remote is a
 * far weaker pseudonym than a hashed root commit — it is recorded rather than
 * hidden so a caller can decline to share on one.
 */
export type RepoKeyStrength = "strong" | "weak"

export interface RepoKey {
  readonly key: string
  readonly strength: RepoKeyStrength
}

/**
 * The hash a key is built with, supplied by the caller.
 *
 * `core` is bundled into the RENDERER as well as the main process, so it cannot
 * reach for `node:crypto`. Injecting the primitive keeps this module
 * environment-agnostic while it still owns the part that actually matters — WHICH
 * anchor is chosen, how a remote is normalised, and how trustworthy the result
 * is. Those are the decisions two teammates must agree on; the digest is not.
 */
export type Hasher = (input: string) => string

/**
 * The key for a repo with reachable root commits.
 *
 * A repository can have more than one root — grafted histories, or two projects
 * merged with unrelated histories. Sorting and taking the first makes the choice
 * deterministic; `git rev-list` does not guarantee a stable order across
 * versions, and an unstable pick would give two teammates different keys for the
 * same repo, which is the exact failure this module exists to prevent.
 */
export const repoKeyFromRoots = (
  roots: ReadonlyArray<string>,
  hash: Hasher
): RepoKey | null => {
  const cleaned = roots.map((r) => r.trim()).filter((r) => r.length > 0)
  if (cleaned.length === 0) return null
  return { key: hash([...cleaned].sort()[0]!), strength: "strong" }
}

/**
 * Normalise a git remote so every way of writing the same remote agrees.
 *
 * `git@github.com:acme/api.git`, `https://github.com/acme/api` and
 * `ssh://git@github.com/acme/api/` must all collapse to one string, or the
 * fallback key would differ between teammates purely by how they happened to
 * clone.
 */
export const normaliseRemote = (remote: string): string => {
  const withoutScheme = remote.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "")
  // Strip `user@`, but only a bare userinfo segment — no slash, no colon. An
  // unanchored `[^@/]+@` also eats a HOST containing an `@`.
  const withoutUser = withoutScheme.replace(/^[^@/:]+@/, "")
  // Parse ONCE rather than chaining replacements. Layered regexes were not
  // idempotent — `github.com:::` rewrote a different colon on each pass — and a
  // normaliser whose output doesn't survive re-normalising is a normaliser that
  // can disagree with itself about which repo it is looking at.
  // A path-style remote (`/srv/git/api`, or a `file://` URL once its scheme is
  // gone) has no host at all. Caught by the shallow-clone test, which clones
  // over `file://`: the host-first parse below cannot match a leading slash and
  // returned the empty string, losing the key entirely. Local remotes are real —
  // submodules and local clones both produce them.
  if (withoutUser.startsWith("/")) {
    const path = withoutUser.replace(/\.git$/, "").replace(/\/+$/, "").trim()
    return path.length > 0 ? path : ""
  }
  const m = /^([^/:]+)(?::(\d+))?[:/]?(.*)$/.exec(withoutUser)
  if (m === null) return ""
  const host = m[1] ?? ""
  const path = (m[3] ?? "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "")
    .trim()
  return path.length > 0 ? `${host}/${path}` : host
}

/** The fallback key, for a clone with no reachable root commit. */
export const repoKeyFromRemote = (remote: string, hash: Hasher): RepoKey | null => {
  const normalised = normaliseRemote(remote)
  if (normalised.length === 0) return null
  return { key: hash(normalised), strength: "weak" }
}

/**
 * Resolve a repo key from whatever git could tell us.
 *
 * Prefers the root commit and falls back to the remote. Returns null when
 * neither is available — a local-only shallow clone has no stable identity at
 * all, and inventing one (a path hash, say) would produce a key that differs per
 * machine while looking authoritative.
 */
export const repoKeyFrom = (
  input: { readonly roots: ReadonlyArray<string>; readonly remote: string | null },
  hash: Hasher
): RepoKey | null =>
  repoKeyFromRoots(input.roots, hash) ??
  (input.remote === null ? null : repoKeyFromRemote(input.remote, hash))
