---
"@starbase/cli-adapters": minor
"@starbase/core": minor
"@starbase/ui": minor
---

Plan mode now runs on Codex and opencode, not just Claude.

Plan mode was Claude-only for a real reason: it steers the harness toward `ExitPlanMode`, a tool the other two don't have. But the workaround was already in the codebase, shipping, twice. Adversarial planning reads its plans out of a fenced ` ```plan ` block precisely so any harness can hold any role, and structured questions do the same with a JSON block that `codex-adapter` parses out of an ordinary reply. This is the third use of a pattern that was already proven, not new machinery.

So `planInstructions` is now a function of how the plan comes back — `"tool"` for Claude, `"reply"` for everyone else — and the grammar below that first sentence is byte-identical between the two, guarded by a test. A Codex plan is parsed by the same `parsePlan`, renders as the same interactive card, and takes the same comment/revise/approve flow.

**A safety bug fell out of scoping this, and it's the load-bearing fix.** `mapCodexPolicy` branched `readOnly → auto → else`, so `plan` fell through to `workspace-write`, and `agent-runner` never sets `spec.readOnly`. Ungating the chip without touching that would have shipped a "planning" mode that edits your worktree. Plan mode's promise is that the agent *cannot* write until you approve; on Claude the SDK keeps that promise, and on these two harnesses nothing was keeping it. Now Codex plans under a `read-only` sandbox and opencode plans with `edit`/`write`/`patch`/`task` withheld.

The two harnesses get there differently, because their sandboxes have different lifetimes:

- **Codex** fixes `sandboxMode` when the *thread* opens, so approving a plan re-opens the same thread id under the restored exec mode. Same id, so the planning conversation is still there — a fresh thread would make the agent re-derive everything it just worked out.
- **opencode** bakes its permission map into `OPENCODE_CONFIG_CONTENT` when the *server* spawns, which a mid-run approval can't revoke without a restart. It uses `session.prompt`'s per-prompt `tools` map instead — stronger, because a withheld tool is never offered to the model at all, and there is no gate for an unanswered approval to park on. `bash` stays available in both: planning means reading the code, which is what Claude's own plan mode allows.

Both adapters run the same bounded loop (six rounds): revise sends your comments back as the next prompt, approve re-prompts with the plan under a widened sandbox, reject ends the turn. Past the cap the block degrades to plain text — no card, no error, exactly what the question channel already does.

The gate itself is now one predicate, `supportsPlanMode(cli)`. It replaces four separate `cli === "claude"` checks — the composer chip, the Shift+Tab cycle, and the renderer *and* main-process coercions that fired on a harness switch — three of which drop the mode silently rather than erroring, so a disagreement between them looked like a bug with no message. A consequence worth knowing: switching Claude → Codex mid-plan no longer throws your planning session away.

One cost, and it's visible. Approval on Codex and opencode spends an extra harness turn, because the sandbox can only widen on a new prompt. Claude carries straight on inside one query.
