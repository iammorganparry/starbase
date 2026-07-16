---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Agentic adversarial code review — a reviewer agent that argues *against* a pull request, manually or automatically, with findings routed back to the working agent.

- **Adversarial review of a PR** — a reviewer agent runs in the session's worktree, is fed the PR diff, and hunts for defects (logic, security, performance, regressions, missing coverage) plus how the code will age (simplicity, duplication across the repo, repo convention, over-abstraction). Findings are structured — severity, file, line, rationale, suggested fix — and ranked worst-first in the Pull Request rail and anchored to their file in Code Review.
- **Reviewer model is configurable** (Settings · GitHub), defaulting to **Fable** (`claude-fable-5`): its 1M context swallows large diffs whole, and the point of an adversarial review is to critique a diff with a *stronger* model than the one that wrote it — so this stays deliberately decoupled from the per-session Providers default.
- **Auto-run on new commits** (opt-in, off by default) — reviews a PR when it opens and each time its head advances, de-duped on the PR head SHA so an unchanged head costs one `gh pr view` and spawns nothing.
- **Send any finding to the working agent** to address, through the session's conversation (so its work and any approval gates surface in the Conversation tab).
- **Reviews are read-only by construction** — the reviewer can read and search the worktree but cannot edit files or run commands, enforced by the harness itself (`SessionSpec.readOnly`: Claude refuses the write tools; Codex runs a read-only sandbox) rather than by prompt.
