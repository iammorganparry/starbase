---
"@starbase/cli-adapters": patch
---

Fixed: a session could share a branch ref with your own checkout, so the agent's commits moved the branch you were standing on.

`checkoutBranch` passed `--ignore-other-worktrees` unconditionally. That flag exists to bypass git's safeguard against checking out a branch already live in another worktree, and the PR flow used it so that a pull request whose head branch you happened to have checked out locally could still be opened as a session. But git's safeguard is not arbitrary: two worktrees on one branch share the ref, so a commit landed in either moves both. An agent working in a session would advance the branch in the developer's main repository, with nothing in either place indicating it had happened.

The guard is deliberately narrow. Sharing a branch between two *sessions* stays allowed — that is what the "share checked-out branches" setting opts into, and it is recoverable noise. What is now refused is sharing with the **main working tree**, always the first record of `git worktree list --porcelain`. Writing into the checkout the developer is standing in was never what that setting asked for.

`createFromPr` already treats a failure here as "this pull request cannot be opened as a session", which is the correct outcome. The error names the branch and says to move your own checkout off it first.

Worth knowing if you hit it: opening a PR session whose head branch is checked out in your main repo now fails with an explanation, where it previously appeared to succeed. That is the fix working, not a new fault.
