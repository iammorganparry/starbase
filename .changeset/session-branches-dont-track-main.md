---
"@starbase/cli-adapters": patch
---

A session's branch no longer tracks the base branch. Forking a worktree off `origin/<base>` made git DWIM an upstream of `origin/main` onto the new branch, so the session reported "up to date with origin/main" and a bare `git push` inside the worktree — from you, or from an agent granted push — resolved to `origin/main` and put the session's commits straight onto the base branch, unreviewed. New session branches are created with `--no-track` and have no upstream until something pushes them, which is what `git push -u` and `gh pr create` set correctly.
