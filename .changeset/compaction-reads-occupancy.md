---
"@starbase/cli-adapters": patch
"@starbase/core": patch
---

Compaction now decides from context OCCUPANCY, not cumulative token spend.

The end-of-turn `Done` event carries the run's total token usage — which counts
the resident context once per sampling call — and that number was being fed to
the context manager as if it were the size of the working set. A turn with ten
tool calls inside a 90k window reported ~900k, so long sessions crossed the
trigger on every single turn and compacted repeatedly, at a threshold that moved
with the tool count rather than the context.

The decision now reads the harness's own occupancy report, and the Claude
adapter probes `getContextUsage()` as the turn ends for an exact figure plus the
model's real ceiling — which also retires the model-id window guess for any
harness that answers. An older CLI, or one that fails to answer, falls back to
the per-message readings; nothing guesses.
