---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
"@starbase/contracts": patch
"@starbase/core": patch
"@starbase/ui": patch
---

Sessions no longer come back with nothing to say. A turn that opened with a slash command — `/babysit-pr the PR we need it to main asap` — was rewritten before it reached the harness: the compaction primer and the saved-plan pointer were prepended, so the command was no longer the first thing in the message and the harness read it as prose rather than expanding it. The agent had nothing to do, the turn settled with zero parts, and the transcript showed a bare "CLAUDE" header with no reply. A turn that leads with a command now keeps it in front, and the context rides along after it.

Two silent paths that produced the same empty block are closed as well. The Claude SDK's message stream can end without a `result` — a killed child, a crashed CLI, stdout EOF — and a `for await` that simply ends throws nothing, so the run emitted no terminal event at all; it now reports why it stopped. On the renderer side, the forked RPC stream swallowed transport failures entirely, and the conversation machine only leaves `running` on a `Done`/`Failed`, so a dead stream left the turn spinning forever (and reading as an empty assistant message after a reload). Every run now settles with exactly one terminal event, whatever happens to it.

Plan mode stops asking permission for reads. Plan mode cannot write — the harness refuses edits outright — so every command it wanted approval for was a `git log`, an `rg`, a `gh pr view`: a queue of prompts for actions that could not change anything, which is how an operator learns to approve without reading. Commands now run unattended while planning, controlled by **Settings → General → Planning**. Edits gate exactly as before, in every mode.

The conversation pill now says what the sidebar says. It rendered the raw activity ("Running npm test -- auth", "Searching the web"), so one session answered "what are you doing?" two different ways depending on where you looked, and the pill's width moved with every tool call. It reports one of the five words the rows use — Thinking, Running, Needs Input, Monitoring, Idle — with the specifics kept on hover.
