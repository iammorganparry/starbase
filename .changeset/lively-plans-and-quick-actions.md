---
"@starbase/cli-adapters": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Plan-mode cycling, per-mode composer theming, per-step plan flows, and sidebar archive/delete quick actions.

- **Shift+Tab reaches Plan mode** on Claude sessions (the cycle now includes `plan`; other harnesses keep the 3-mode cycle).
- **Composer "nightlight"** — the composer border/background/glow and the mode chip are colour-coded per HITL mode (ask=blue, accept-edits=green, auto=orange, plan=purple).
- **Per-step plan flows** — decision/state-machine flows now live on each `PlanStep` (parsed from `` ```flow step NN `` `` blocks) and render inside that step's spec, instead of one flow for the whole plan; Plan Review opens on the first step that has a flow.
- **Sidebar archive/delete quick actions** — each session row exposes Archive/Restore/Delete via hover buttons and a right-click context menu, with a confirmation dialog before deleting.
