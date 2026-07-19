import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Keeping an unattended agent away from the operator's credentials.
 *
 * The file-tool check in `confinement.ts` cannot see a shell: `Bash` takes a
 * command string, not a path, and a plan step legitimately needs Bash to build
 * and test. So `cat ~/.ssh/id_rsa` walked straight through it.
 *
 * The Claude SDK's sandbox does see it. Verified on macOS against the real
 * harness: without a sandbox the read succeeds, with one it fails with
 * "Operation not permitted" at the OS level rather than by the model's good
 * manners.
 *
 * WHAT THIS IS NOT
 *
 * It is not confinement to the worktree, and the distinction is load-bearing
 * enough to have been measured. `denyRead` is absolute — there is no carve-out —
 * so denying `~` also denies a worktree living under `~`, and `allowWrite` does
 * not grant read back. A step that cannot read its own repository is useless,
 * so "deny everything outside cwd" is not expressible here.
 *
 * What IS expressible is a denylist of the places credentials live. That is a
 * meaningful reduction — an unattended agent cannot exfiltrate SSH keys, cloud
 * credentials, or the tokens for the very harnesses Starbase drives — but it is
 * a denylist, not a boundary, and anything not on the list is still readable.
 */

/**
 * Credential locations, denied to unattended agents.
 *
 * Chosen for blast radius rather than completeness: each entry is somewhere a
 * secret that grants access to OTHER systems lives. A repo the agent shouldn't
 * have read is a privacy problem; an SSH key is a lateral-movement problem.
 *
 * `~/.claude` and `~/.codex` are on the list because they hold the auth for the
 * harnesses Starbase itself drives — an agent that could read those could keep
 * running as the operator long after the session ended.
 */
export const CREDENTIAL_DIRS: ReadonlyArray<string> = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".config/gh",
  ".config/gcloud",
  // The OTHER place a GitHub token lives, in plaintext
  // (`https://user:ghp_xxx@github.com`), on a machine that by definition uses
  // git. Denying `.config/gh` without this covered one of the two.
  ".git-credentials",
  ".config/git/credentials",
  // Holds `oauthAccount` and MCP server definitions whose `env` blocks
  // routinely carry third-party API keys.
  ".claude.json",
  // opencode is a harness Starbase drives — same argument as .claude/.codex.
  ".local/share/opencode/auth.json",
  ".pgpass",
  ".claude/.credentials.json",
  ".codex/auth.json"
]

/** Absolute credential paths for a given home. Exported for test. */
export const credentialDenyList = (home: string): ReadonlyArray<string> =>
  CREDENTIAL_DIRS.map((d) => join(home, d))

/**
 * Sandbox settings for an agent nobody is watching.
 *
 * `failIfUnavailable: false` is deliberate and is the main caveat: the sandbox
 * needs platform support (bubblewrap on Linux), and defaulting to `true` would
 * turn a missing dependency into "your approved plan refuses to run". Degrading
 * is the right call for a defence-in-depth measure — but it does mean that on an
 * unsupported host this protection is silently absent, which is why the
 * file-tool check in `confinement.ts` is kept as well rather than replaced. That
 * one is pure and works everywhere.
 *
 * `autoAllowBashIfSandboxed` is what makes this usable: a sandboxed command is
 * already constrained by the OS, so gating each one on a human who is not there
 * would just stall the run.
 */
export const unattendedSandbox = (home: string = homedir()) => ({
  enabled: true,
  failIfUnavailable: false,
  autoAllowBashIfSandboxed: true,
  filesystem: { denyRead: [...credentialDenyList(home)] }
})
