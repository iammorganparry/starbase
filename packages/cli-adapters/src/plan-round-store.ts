import type { PlanRound } from "@starbase/core"
import { PlanRound as PlanRoundSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type PlanRoundEnv = FileSystem.FileSystem | Path.Path | AppPaths

/**
 * The last adversarial planning round per session, at
 * `~/starbase/plan-rounds/<sessionId>.json`.
 *
 * This is an audit trail, not the artefact. The settled plan already lives in
 * the transcript; what's kept here is the material needed to answer the question
 * that actually matters when you distrust the feature — *did the critic really
 * attack, and did the proposer engage or just cave?* That needs the
 * pre-revision proposal and the raw critique side by side, which no other store
 * keeps.
 *
 * Best-effort throughout, like `PlanStore`: a filesystem hiccup must never fail
 * a round the operator can already see on screen. Unlike `ReviewStore` there is
 * no in-memory mirror, and that asymmetry is deliberate — the mirror exists
 * there because a *poll-driven* de-dupe that always misses respawns a reviewer
 * forever. Planning is user-triggered, so a failed read costs one unavailable
 * audit trail rather than an unbounded spend.
 */
export class PlanRoundStore extends Effect.Service<PlanRoundStore>()(
  "@starbase/PlanRoundStore",
  {
    accessors: true,
    sync: () => {
      const fileFor = (
        sessionId: string
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.planRoundsDir, `${sessionId}.json`)
        })

      /** Persist a round, replacing any earlier one for the session. */
      const set = (round: PlanRound): Effect.Effect<void, never, PlanRoundEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = yield* fileFor(round.sessionId)
          yield* fs.makeDirectory(paths.planRoundsDir, { recursive: true }).pipe(Effect.ignore)
          const encoded = yield* Schema.encode(PlanRoundSchema)(round).pipe(
            Effect.orElseSucceed(() => null)
          )
          if (encoded === null) return
          yield* fs
            .writeFileString(file, JSON.stringify(encoded, null, 2))
            .pipe(Effect.ignore)
        })

      /**
       * The stored round for a session, or null when there is none.
       *
       * A round written by an older build that no longer decodes yields null
       * rather than failing: the audit trail is a nice-to-have, and a schema
       * change must not make the Plan tab unopenable.
       */
      const get = (
        sessionId: string
      ): Effect.Effect<PlanRound | null, never, PlanRoundEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(sessionId)
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
          if (raw === null) return null
          return yield* Schema.decodeUnknown(Schema.parseJson(PlanRoundSchema))(raw).pipe(
            Effect.orElseSucceed(() => null)
          )
        })

      return { set, get, fileFor }
    }
  }
) {}
