---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
---

Reap orphaned CLI child processes so they stop piling up and eating memory.

Every `opencode serve` / `codex app-server` Starbase spawns already kills its own child when the run or probe ends. What that could never cover was the run *not* ending — the main process going away underneath it (a crash, `SIGTERM`, or electron-vite's dev-restart on every edit to the main process). The `finally` that would have killed the child never executed, so the child was reparented to launchd (PPID 1) and kept running. An `opencode serve` holds ~100MB and never exits on its own, so across a day of `pnpm dev` they accumulated into hundreds of live servers — the memory those processes and the app were seen consuming.

- A process-wide **child registry** now tracks every CLI child we spawn (`opencode serve` for both runs and model/auth probes, `codex app-server`) and self-cleans as each exits. `before-quit` reaps the survivors alongside the existing PTY `killAll`, and a synchronous `process.on("exit")` sweep catches the hard-exit paths that skip `before-quit` entirely — the exact paths that produced the orphans.
- **Model discovery no longer double-spawns during warm-up.** `ModelsService.list` had no in-flight de-duplication, so the startup prefetch and the renderer's `loadCatalog` (fired when a conversation opens) could each boot their own server for the same harness before the first result cached. It now coalesces concurrent probes onto one shared fetch via `Effect.cachedFunction`.
