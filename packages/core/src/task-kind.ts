import { Schema } from "effect"

/**
 * What *kind* of work a plan step is — the axis model-affinity learnings are
 * keyed on ("who is good at schema work in this repo?").
 *
 * Deliberately a CLOSED literal rather than free-form tags, and that choice is
 * load-bearing rather than tidiness. Learnings are scored per (repo, kind,
 * model), so every extra kind divides already-thin evidence into smaller cells.
 * Free-form tags would fragment the data until no cell ever reached a usable
 * sample size — "frontend", "front-end", "ui" and "react" would each accumulate
 * a handful of observations and none would ever mean anything.
 *
 * Eight is a deliberate ceiling. Adding a ninth is a real cost paid by every
 * future estimate, so it needs a reason beyond "this task felt different".
 *
 * Shared by the plan schema (a step declares its kind) and the outcome schema (an
 * outcome records the kind it was scored for). It lives in its own module so
 * neither has to import the other.
 */
export const TaskKind = Schema.Literal(
  "frontend",
  "backend",
  "schema",
  "tests",
  "refactor",
  "infra",
  "docs",
  "review"
)
export type TaskKind = Schema.Schema.Type<typeof TaskKind>

/** Every task kind, for exhaustive iteration in prompts, tables and tests. */
export const TASK_KINDS: ReadonlyArray<TaskKind> = TaskKind.literals
