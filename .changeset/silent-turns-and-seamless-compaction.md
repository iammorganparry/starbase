---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
"@starbase/core": patch
---

Stop losing turns, and make a compaction seamless to pick back up

Three fixes, two of them for the same complaint: you send a message, the eyebrow
appears, and the agent never answers.

**A stop could kill the wrong run.** `AgentRunner.stop` read a session's in-flight
run by session id alone, while the renderer fired `agentStop` and started the next
turn without waiting. If the interrupt was scheduled after the new turn had been
forked, it killed that instead — so a fresh message came back as a bare "Stopped."
and had to be re-sent. 64 of 946 assistant turns in a local transcript archive
were exactly this. A per-session lock now orders a stop against the next turn's
setup, and the renderer waits in a new `stopping` state (capped at 3s) rather than
firing and forgetting.

**A wedged harness could hang forever, silently.** Nothing bounded the wait for a
turn's first event: the renderer only synthesises a terminal event when a stream
ends, and the runner's instrumentation is a finalizer, so a child that hung before
saying anything was invisible everywhere and left the turn empty with the typing
indicator running. 32 of those same 946 turns are frozen there. Turns that produce
nothing for two minutes now settle with a message saying so.

**Compaction now carries short-term memory.** The digest gained `recentWork` (what
was just done, concretely) and `nextStep` (the single next action), rendered ahead
of the backlog in the primer — so a compacted agent resumes mid-thread instead of
re-planning from scratch. Older digests without these fields still decode.

Separately: every agent is now told, each turn, to ask through its native question
channel rather than in prose — a prose question renders as unanswerable chat text
and gets silently ignored. Claude is pointed at `AskUserQuestion`; Codex gains a
question channel it never had (it has no per-tool callback, so it asks through a
fenced block that becomes the same question card).
