---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Background tasks are visible and stoppable, session transcripts survive a mid-write kill, and a merged PR no longer retires a live session.

## Background tasks

Work the agent starts that **outlives the turn that started it** — a backgrounded shell command or sub-agent — previously ran to completion with nothing in the UI to say it existed, let alone stop it. It now gets a dock below the conversation with per-row **Stop** and **View**.

- **The lifecycle is a statechart** (`backgroundTaskMachine`), not ad-hoc status branching. The harness's signals are unordered and lossy by design: `background_tasks_changed` is a *level* signal whose ordering against the start/progress/settle *edges* is explicitly unspecified, settle bookends can be dropped, and progress can arrive after a task has finished. States are `running → stopping → completed | stopped | failed`, with terminal states as XState `final` so a late progress report or a task reappearing in the level cannot resurrect it.
- **`stopping` is a real state.** Stopping is not instant — the harness confirms via a later bookend — so without it the Stop button reads as broken. The row flips on the click and disables until the harness settles it either way.
- **The level signal is authoritative for membership.** A task that vanishes from the live set is settled even with no bookend (otherwise a dropped edge wedges a row as "running" forever); a task *in* the level we never saw start gets a placeholder row (better a vague row than invisible running work).
- **A stop racing a natural completion reports the truth.** If a task finishes on its own between the click and the confirmation, it settles as `completed`, not `stopped`.
- **State lives in a main-process registry**, one actor per task, keyed by session — *not* in the renderer's conversation state, which is per-run and cleared on the next turn. Holding it there would delete the row the moment the next prompt was sent while the work carried on. Deliberately not disk-persisted: a background task cannot outlive its harness process, so a restored row could never settle and its id would resolve to nothing stoppable.
- **Cross-provider by capability, not by pretence.** `CliInfo.backgroundTasks` gates the dock. Only Claude exposes real background tasks (a live set, per-task progress, and `query.stopTask`); Codex and OpenCode can only abort a whole turn, so they show no dock rather than a Stop button with nothing to aim at.
- The Claude adapter now maps `task_started` / `task_progress` / `task_notification` / `background_tasks_changed`, which were previously dropped. `task_started` fires for **foreground** tasks too, so the level signal gates promotion — otherwise the dock would fill with ordinary synchronous sub-agents.

## Session history survived a mid-write kill

**Fixed: a dev restart could zero a session's transcript**, and the conversation pane came back blank with no error. `TranscriptStore` wrote with `writeFileString`, which truncates the target before writing, and `AgentRunner` rewrites the whole file on nearly every stream event — so killing the main process mid-write (exactly what an electron-vite dev restart does) left a 0-byte file. Reads treat an unreadable transcript as "no history yet", which is why it presented as a silent blank rather than a failure. Writes now go to a scratch file and `rename` onto the target, which is atomic within a filesystem.

A recovery script (`apps/desktop/scripts/backfill-transcript.ts`) rebuilds a lost transcript from the harness's own JSONL log by replaying it through the same `streamEventsFor` + `applyStreamEvent` path a live run uses. Note that agent *reasoning* is unrecoverable — Claude's logs record thinking blocks with an empty string and a signature only.

## A merged PR no longer archives its session

**Fixed: a session vanished from the sidebar when its linked PR merged.** A session record holds a single `prNumber` but routinely outlives several PRs (open one, merge it, keep working off the same worktree, open the next), so merging the first PR retired a session whose work was still in flight. Merge state now **badges** the row; archiving is always the operator's call. The `closeOnMerge` issue automation is unaffected — closing a linked issue is a statement about the issue, not about whether the session is finished.

**Fixed: the Archived group sorted by `updatedAt`**, so a session archived today whose last turn was a week ago sorted below sessions archived days earlier — buried exactly when you go looking for it. It now sorts by `archivedAt`.

## Local DX

The Playwright e2e suite no longer steals focus. It launches a real Electron app dozens of times, and every `show()` pulled focus from whatever you were doing, making the suite (which runs only locally — it is not in CI) incompatible with using the machine. Windows are now hidden and off the dock by default; `STARBASE_E2E_HEADED=1` to watch a run.
