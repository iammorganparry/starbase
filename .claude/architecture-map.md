# Starbase Architecture Map

> Last updated: 2026-07-22
> Cartographer skill revision focused on Gigaplan routing

## Quick Reference

| App/package | Purpose | Key entry |
|---|---|---|
| `apps/desktop` | Electron main, preload, and React renderer | `src/main/index.ts`, `src/renderer/main.tsx` |
| `apps/server` | BetterAuth HTTP backend on Hono/Postgres | `src/index.ts` |
| `packages/core` | Shared Effect schemas and pure domain logic | `src/index.ts` |
| `packages/contracts` | Typed main/renderer RPC contract | `src/index.ts` |
| `packages/cli-adapters` | Harness adapters and desktop Effect services | `src/index.ts` |
| `packages/ui` | React components and application shell | `src/index.ts` |

## System Overview

```text
React renderer/XState
        |
        | @effect/rpc over Electron IPC
        v
Electron main (rpc.ts)
        |
        +--> cli-adapters --> Claude / Codex / OpenCode CLIs
        +--> JSON stores --> sessions, transcripts, plans, config
        +--> Git/GitHub --> worktrees, diffs, PRs

Desktop sign-in --> Hono server --> BetterAuth --> Postgres
```

Workspace packages ship source TypeScript. Electron/Vite or the server's `tsx`
transpiles them directly, so there is no intermediate package build artifact.

## Gigaplan Flow

```text
User selects Gigaplan and sends a brief
        |
        v
Plan.adversarial RPC
        |
        +--> discover installed harnesses and live model catalogues
        +--> collapse routes by underlying model vendor
        +--> proposer: preferred flagship
        +--> adversary: flagship from a different vendor
        +--> proposer revises and assigns each step a task kind + cli/model
        |
        v
Structured Plan persisted in the transcript
        |
        | operator approval
        v
Plan.execute RPC
        |
        +--> stable dependency ordering; branches and unreachable steps skipped
        +--> resolve one runner per step
        +--> run steps sequentially in one shared worktree
        +--> retry blocked steps up to three times
        +--> persist live and crash-recoverable step status
```

### Planning and routing ownership

| Decision | Current owner | Source |
|---|---|---|
| Reachable labs and preferred harness | Deterministic code | `packages/core/src/vendor.ts` |
| Proposer/adversary roles | Deterministic code | `packages/cli-adapters/src/adversarial-plan.ts` |
| Step decomposition and task kind | Proposer model | `packages/cli-adapters/src/adversarial-plan-prompt.ts` |
| Exact step harness/model | Proposer model | `packages/cli-adapters/src/adversarial-plan-prompt.ts` |
| Assignee fallback at execution | Deterministic code | `packages/core/src/plan-execution.ts` |
| Dependency order and retry policy | Deterministic code | `packages/core/src/plan-execution.ts`, `packages/cli-adapters/src/plan-executor.ts` |

## Important Boundaries

- `packages/core` owns pure, testable policy and schemas. It must not depend on
  Electron or a CLI adapter.
- `packages/cli-adapters` turns policy into harness runs. Planning roles are
  read-only; approved plan steps may edit their session worktree.
- `apps/desktop/src/main/rpc.ts` composes discovery, persistence, and services.
  It is the integration seam for a future routing policy service.
- `packages/contracts` is the source of truth for every renderer/main RPC shape.
- The renderer owns conversation state and rendering; main owns processes and
  persistence.

## Routing Concerns

- `TaskKind` is a closed eight-value vocabulary, but today it labels steps only;
  `resolveRunner` does not consult it.
- The proposer writes a concrete `cli + model` into the durable plan. That makes
  the recommendation auditable, but also lets a stale model id cross into a
  later execution unchanged.
- `Plan.execute` reduces each installed harness to its first catalogue model
  before calling `resolveRunner`; the rest of the live catalogue is discarded.
- The optional affinity/evidence input exists in the planning service and UI
  schema, but no production caller currently supplies a knowledge base.
- Execution is intentionally sequential because all steps share one worktree.
  Parallel execution requires isolated worktrees and merge/conflict policy.

## Common Tasks

| Task | Start here |
|---|---|
| Change Gigaplan plan schema | `packages/core/src/conversation.ts` |
| Change task categories | `packages/core/src/task-kind.ts` |
| Change planner routing instructions | `packages/cli-adapters/src/adversarial-plan-prompt.ts` |
| Change runtime runner selection | `packages/core/src/plan-execution.ts` |
| Change execution/retry behavior | `packages/cli-adapters/src/plan-executor.ts` |
| Wire new routing state/persistence | `apps/desktop/src/main/rpc.ts`, `packages/contracts/src/index.ts` |
