import { isAbsolute, resolve, sep } from "node:path"

/**
 * Keeping an unattended agent inside the worktree it was given.
 *
 * Read tools are never gated — `toPermissionRequest` returns null for them, so
 * `canUseTool` is not even consulted — which is right for an interactive session
 * the operator is watching. It is wrong for the side agents: a planning role, a
 * judge, or a plan step runs unattended, and nothing stops it reading anywhere
 * on the disk.
 *
 * Observed, not theorised: a planning proposer inferred a path from the
 * operator's user-level `CLAUDE.md`, read 403 lines of an unrelated private
 * repository, and folded it into the plan's context. Nothing was malicious and
 * nothing failed — which is what makes it worth closing.
 */

/**
 * macOS resolves `/tmp` to `/private/tmp`, and the two spellings mix freely: a
 * cwd captured one way and a path reported the other would look like an escape
 * when it is the same directory. Normalising the prefix is narrower than calling
 * `realpath` (which is IO, and would make this untestable and slow on a hot
 * path).
 */
const canonical = (p: string): string => {
  const resolved = resolve(p)
  return resolved.startsWith("/private/") ? resolved.slice("/private".length) : resolved
}

/** Whether `child` is `root` itself or lives beneath it. */
const within = (root: string, child: string): boolean => {
  const r = canonical(root)
  const c = canonical(child)
  // The separator matters: without it `/repo-secrets` reads as inside `/repo`.
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Path-bearing fields across the tools we care about.
 *
 * `path` covers Glob/Grep's search root as well as edit targets, which is the
 * point — confining writes while leaving a repo-wide grep unrestricted would
 * miss the case actually seen in the wild.
 */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const

/**
 * The first path in a tool call that leaves `cwd`, or null when it stays inside.
 *
 * Relative paths are judged too, resolved against `cwd` first. An earlier
 * version skipped them on the reasoning that they "cannot escape by
 * construction" — which is simply false: `../../.ssh` resolves straight out,
 * and `Grep`/`Glob` take a relative `path` happily. That was the whole
 * protection defeated by two dots.
 *
 * Returning the offending path rather than a boolean is deliberate — the denial
 * message names it, because "denied" with no subject is unactionable for
 * whoever reads the transcript.
 */
export const escapingPath = (
  cwd: string,
  input: Record<string, unknown>
): string | null => {
  if (cwd.length === 0) return null
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value !== "string" || value.length === 0) continue
    const candidate = isAbsolute(value) ? value : resolve(cwd, value)
    if (!within(cwd, candidate)) return value
  }
  return null
}
