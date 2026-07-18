---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
---

Fixed: spawned processes could inherit the app's working directory and act on the wrong repository.

Starbase runs many repos side by side, each session in its own git worktree. Four spawn sites fell back to the Electron main process's cwd when no worktree was supplied — and in development that cwd is whichever worktree `pnpm dev` was launched from. So a process belonging to repo A silently read and wrote inside repo B.

This was not hypothetical. A user-scope MCP server probed from Settings (which has no session, so no worktree) was spawned with no `cwd`, inherited the app's, and created its SQLite database inside an unrelated repo's checkout — where it then surfaced as an untracked file in that repo's PR.

- **MCP probe** (`mcp-probe.ts`) omitted `cwd` entirely when there was no worktree. It now always passes one: the session's worktree, or an explicitly neutral directory.
- **Terminals** used `input.cwd ?? process.cwd()`. A terminal with no session now opens in the user's home — where an interactive shell would start anyway — never in a checkout.
- **All three agent adapters** (claude, codex, opencode) mapped `spec.cwd || undefined` to *no* cwd, so a session with a missing worktree would have run the agent against Starbase's own source. They now call `requireWorktree`, which throws rather than inheriting: a session with no worktree has nothing legitimate to run.

Worktree *creation* was never affected — paths are namespaced `worktrees/<repo>/<slug>` and every git command runs against the owning repo. The containment gap was entirely on the execution side.

Two comments in the codebase asserted the safe behaviour while the code did the opposite, and one test asserted the unsafe behaviour as a guarantee (`falls back to the process cwd for an unknown session`); all three are corrected.
