---
"@starbase/cli-adapters": patch
"@starbase/core": patch
"@starbase/ui": patch
---

Compaction stops firing eagerly, waits for a boundary, and reports honest numbers.

Four faults on one path, all visible in the same corner of the screen.

**The reading survived the reseed.** Applying a digest starts a brand-new harness
conversation, but the manager kept the occupancy reading that described the old
one — in memory and on disk. The meter therefore read "compacting soon" over a
40k session, and the next turn's decision measured a conversation that no longer
existed and forked another digest. Both copies are now cleared at the swap.

**The marker quoted the wrong number.** The in-transcript "Context compacted
from …" line was reading `Session.tokens`, the session's lifetime spend, so a
long-running session announced "from 49894.2k" — larger than any context window
in existence. It now comes from the manager's own occupancy reading. Markers
already written carry the old figure, so the divider declines to quote anything
implausible rather than showing it.

**Modern Opus was measured as a 200k model.** `claude-opus-4-8` matched the bare
`opus` row in the model-id table, putting the trigger at 170k — so sessions the
harness was happily running at 500k sat permanently on "compacting soon".
Opus 4.5+ now reads as 1M, and beyond the table any window a session has
demonstrably exceeded is corrected upward: a reading of 598k is proof the
ceiling is not 200k, whatever the guess said. The working-set budget also moves
to 400k (tunable to 500k), which is where the current generation of models
actually starts to degrade.

**Compaction could land mid-task.** A swap dropped into an unfinished edit
sequence or a live debugging thread discards exactly the state the next turn
needs. The digest run — which already reads the whole transcript on the cheap
tier — now also reports whether the session is mid-flow, and that combines with
structural evidence a summary cannot see: a plan still executing, an unanswered
question, a pending approval, a background task still running. When it is, the
swap is held for a turn and the meter says "compaction held" with the reason.
The digest is never discarded, and the hold yields to the hard ceiling and to a
three-turn cap, so a session that always looks busy still compacts.
