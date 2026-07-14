import type { Plan } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"

type PlanStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

/** Kebab-case + length-cap a string into a filesystem-safe plan file name. */
export const planFileName = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan"

/**
 * The plan library: each session's plans persisted as markdown under
 * `~/starbase/.starbase/<worktree-slug>/<plan-name>.md`. Starbase already captures
 * a plan in the transcript when the agent calls ExitPlanMode; writing it to disk
 * too — in a stable location keyed by the session's worktree — lets a LATER turn
 * or session "pick the plan back up" by reading the file, which the runner points
 * the agent at. All operations are best-effort: a filesystem hiccup never fails a
 * run (planning/implementation proceeds; the transcript remains the source of
 * truth). `worktreePath` is the session's isolated worktree; its basename is the
 * per-session folder, so plans from different sessions never collide.
 */
export class PlanStore extends Effect.Service<PlanStore>()(
  "@starbase/PlanStore",
  {
    accessors: true,
    sync: () => {
      /** `<plansDir>/<worktree-basename>` — the plan folder for one worktree. */
      const dirFor = (worktreePath: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.plansDir, path.basename(worktreePath))
        })

      /** `<dir>/<plan-name>.md` — the file for one plan (named from its summary). */
      const fileFor = (
        worktreePath: string,
        plan: Plan
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          return path.join(dir, `${planFileName(plan.summary || plan.id)}.md`)
        })

      /**
       * Persist a plan as markdown, returning its file path. A revised plan with
       * the same summary overwrites its file (latest wins); a distinct plan gets
       * its own file. Best-effort — a write failure yields the intended path
       * without throwing, so the run is never blocked.
       */
      const write = (
        worktreePath: string,
        plan: Plan
      ): Effect.Effect<string, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* fileFor(worktreePath, plan)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
          // Prefer the agent's full plan markdown; fall back to the summary so the
          // file is never empty even for a plan with no raw body.
          const body = plan.raw && plan.raw.trim().length > 0 ? plan.raw : `# ${plan.summary}\n`
          yield* fs.writeFileString(file, body).pipe(Effect.ignore)
          return file
        })

      /**
       * The saved plan files for a worktree (absolute paths, sorted for a stable
       * order), or `[]` when the session has none. The runner reads this to point
       * a resuming agent at its plan(s).
       */
      const list = (
        worktreePath: string
      ): Effect.Effect<ReadonlyArray<string>, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const entries = yield* fs
            .readDirectory(dir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          return entries
            .filter((e) => e.endsWith(".md"))
            .sort()
            .map((name) => path.join(dir, name))
        })

      return { write, list, dirFor, fileFor }
    }
  }
) {}
