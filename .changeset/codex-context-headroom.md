---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
"@starbase/core": patch
---

Compact Codex conversations before an agentic turn can exhaust the model window.

The context policy now reserves 25% of the reported window, a context-overflow
failure forces recovery digest preparation even though the failed turn has no
terminal usage event, and reopened conversations immediately restore their
persisted context reading so the context meter remains visible.
