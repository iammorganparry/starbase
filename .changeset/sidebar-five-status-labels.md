---
"@starbase/core": minor
"@starbase/ui": minor
---

The sidebar reports one of five states, and only those five: **Thinking**, **Running**, **Needs Input**, **Monitoring**, **Idle**.

Before, a row could say almost anything. It showed the live activity's own label when one existed ("Running git branch --show-current", "Searching the web", "Delegating") and a lowercase persisted status when one didn't ("running", "idle") — so the same session named the same state differently depending on whether a tool happened to be in flight, and an unbounded command string ellipsized over the branch name beside it. Grouping by status introduced a third vocabulary again, calling it "Working".

- **One rollup, `displayStatusOf`, now feeds the row's label, its colour, and its group header.** Every kind of tool work (reading, editing, web, delegating) reports Running — the conversation header keeps the finer distinction, where there's room for it. Both watchers (`gh pr checks --watch` and `vitest --watch`) report Monitoring: they differ in what they watch, not in what they mean here — a process that won't return. Needing approval reports Needs Input, since there's one thing for the human to do about either.
- **The detail moved to the row's hover title**, so "Running npm test -- auth" is still there when you want it and can't push the branch out of the row when you don't.
- **Grouping by status now reads Needs Input / Running / Monitoring / Idle.** Monitoring earns its own group (a watch lasts minutes, so the group holds still). Thinking deliberately does not — it still folds into Running, because an agent flips between the two every few seconds and a group that reorders under your cursor is worse than a coarser one that doesn't. The row still says which.
- **The unreachable "done" status folds to Idle.** It's in `SessionStatus` but nothing writes it (`SettledSessionStatus` is idle | needs-input), and its "Done" group could never appear.
