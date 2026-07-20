import { delimiter, isAbsolute, relative, resolve, sep } from "node:path"

/**
 * Strip the PARENT process's toolchain configuration out of a child's
 * environment.
 *
 * Starbase is itself launched through a package-manager script (`pnpm --filter
 * @starbase/desktop dev`), and pnpm publishes its RESOLVED configuration into
 * the environment before running one: an `npm_config_*` variable for every
 * setting in the launching repo's `.npmrc`, `PNPM_SCRIPT_SRC_DIR` naming the
 * directory it was invoked from, and a `PATH` prefixed with that repo's
 * `node_modules/.bin`.
 *
 * Every agent session inherits the lot. So a session working in
 * `~/starbase/worktrees/acme/feature` runs its installs under the ORIGIN
 * repo's `.npmrc` and resolves binaries from the ORIGIN repo's `.bin` — a
 * different repository, on a different branch, possibly a different package
 * manager. And because environment variables OUTRANK `.npmrc`, the worktree
 * cannot override them: writing the setting into its own `.npmrc` changes
 * nothing.
 *
 * Observed concretely while measuring worktree disk use:
 * `npm_config_node_linker=hoisted` and `npm_config_shamefully_hoist=true` were
 * reaching every session from `/Users/…/repos/starbase`, so a `pnpm install`
 * inside a worktree silently used the origin's linker no matter what that
 * worktree's `.npmrc` said.
 *
 * The fix is deliberately narrow. We remove only variables a child package
 * manager RECOMPUTES for itself — nothing here carries user intent that would
 * be lost. Credentials are untouched: registry auth lives in `~/.npmrc`, which
 * every package manager reads directly, so stripping `npm_config_*` cannot
 * sign anyone out. Metered-key withholding is a separate concern with a
 * separate rationale; see `harnessEnv` in `subscription.ts`.
 *
 * Pure, so the decision is testable without spawning a process. Returns a COPY:
 * callers hand this to `spawn` as a REPLACEMENT environment, not a patch.
 */

/**
 * Exact variable names to drop.
 *
 * `NODE_PATH` is included because pnpm points it at its own global store for
 * the duration of a script; a child that inherits it resolves modules out of
 * the launcher's pnpm installation rather than its own tree.
 */
const DROP_EXACT: ReadonlySet<string> = new Set([
  "NODE_PATH",
  "PNPM_SCRIPT_SRC_DIR",
  "npm_command",
  "npm_execpath",
  "npm_node_execpath"
])

/**
 * Prefixes to drop.
 *
 * `npm_config_*` is the whole resolved `.npmrc` of the launching repo — the
 * variables that actually caused the bug. `npm_package_*` and `npm_lifecycle_*`
 * describe the SCRIPT pnpm was running (Starbase's own `dev`), which is
 * meaningless and misleading inside an unrelated repository.
 */
const DROP_PREFIXES: ReadonlyArray<string> = ["npm_config_", "npm_package_", "npm_lifecycle_"]

const isDropped = (key: string): boolean => {
  const lower = key.toLowerCase()
  return DROP_EXACT.has(key) || DROP_PREFIXES.some((p) => lower.startsWith(p))
}

/** Whether `child` is `parent` or sits underneath it. Separator-safe. */
const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  // `relative` returns "" for the same path, and a leading ".." for an escape.
  // The `isAbsolute` guard catches the Windows case of a different drive, where
  // no relative path exists and `rel` comes back absolute.
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * A `PATH` entry that is some OTHER checkout's `node_modules/.bin`.
 *
 * The worktree's own `.bin` is legitimate and stays — that is the session's
 * tooling. Anything else pointing into a `node_modules/.bin` belongs to the
 * repository Starbase was launched from and would shadow the session's own
 * binaries with another branch's versions.
 *
 * Non-absolute entries are left alone: they are relative to the child's cwd,
 * so they already resolve inside the worktree.
 */
const isForeignBin = (entry: string, worktreePath: string | undefined): boolean => {
  if (!isAbsolute(entry)) return false
  const normalised = resolve(entry)
  const tail = `${sep}node_modules${sep}.bin`
  if (!normalised.endsWith(tail)) return false
  if (worktreePath === undefined) return true
  return !isWithin(resolve(worktreePath), normalised)
}

/**
 * The environment a process working inside `worktreePath` should run with.
 *
 * Pass `worktreePath` as `undefined` for a child with no worktree of its own
 * (a probe, a discovery spawn); every `node_modules/.bin` entry is then foreign
 * by definition and the launcher's tooling is stripped entirely.
 */
export const worktreeEnv = (
  env: Record<string, string | undefined>,
  worktreePath?: string
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isDropped(key)) continue
    out[key] = value
  }
  // PATH casing varies by platform (`Path` on Windows), so find it rather than
  // assuming. Rebuilt in place to preserve the caller's original key.
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === "PATH")
  if (pathKey !== undefined) {
    const kept = out[pathKey]!
      .split(delimiter)
      .filter((entry) => entry.length > 0 && !isForeignBin(entry, worktreePath))
    out[pathKey] = kept.join(delimiter)
  }
  return out
}
