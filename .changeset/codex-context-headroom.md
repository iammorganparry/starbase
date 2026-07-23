---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
"@starbase/core": patch
---

Compact Codex conversations before an agentic turn can exhaust the model window.

The context policy now reserves 25% of the reported window, a context-overflow
failure forces recovery digest preparation even though the failed turn has no
terminal usage event, retries wait for that recovery digest before resuming the
full thread, and conversations retain their persisted context reading while a
turn is active so the context meter remains visible.
