import type { GitConfig, GithubConfig } from "@starbase/core"
import { WorkspaceConfig } from "@starbase/core"
import { ConfigError } from "@starbase/core"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type ConfigEnv = FileSystem.FileSystem | AppPaths

/**
 * Reads and writes the persisted `WorkspaceConfig` at `~/starbase/config.json`.
 * `get()` returns null until first-run setup writes a repos directory. Backed by
 * `@effect/platform` `FileSystem` (from `NodeContext.layer`) + `AppPaths`.
 */
export class ConfigService extends Effect.Service<ConfigService>()(
  "@starbase/ConfigService",
  {
    accessors: true,
    sync: () => {
      const get = (): Effect.Effect<WorkspaceConfig | null, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const exists = yield* fs
            .exists(paths.configFile)
            .pipe(Effect.orElseSucceed(() => false))
          if (!exists) return null
          const raw = yield* fs
            .readFileString(paths.configFile)
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to read config", cause })))
          return yield* Schema.decodeUnknown(Schema.parseJson(WorkspaceConfig))(raw).pipe(
            Effect.mapError((cause) => new ConfigError({ message: "Config file is malformed", cause }))
          )
        })

      /**
       * Apply `patch` on top of the persisted config, preserving every other
       * section (so saving one lever never drops another). Seeds `createdAt` +
       * a null `reposDir` on first write.
       */
      const patch = (
        patch: Partial<WorkspaceConfig>
      ): Effect.Effect<WorkspaceConfig, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const existing = yield* get()
          const createdAt =
            existing?.createdAt ?? (yield* Effect.sync(() => new Date().toISOString()))
          const config: WorkspaceConfig = {
            reposDir: existing?.reposDir ?? null,
            createdAt,
            ...(existing?.github ? { github: existing.github } : {}),
            ...(existing?.git ? { git: existing.git } : {}),
            ...(existing?.starredRepos ? { starredRepos: existing.starredRepos } : {}),
            ...(existing?.lastRepoPath ? { lastRepoPath: existing.lastRepoPath } : {}),
            ...patch
          }
          return yield* persist(config)
        })

      const setReposDir = (dir: string) => patch({ reposDir: dir })

      const setGithub = (github: GithubConfig) => patch({ github })

      const setGit = (git: GitConfig) => patch({ git })

      const setStarredRepos = (starredRepos: ReadonlyArray<string>) =>
        patch({ starredRepos })

      const setLastRepoPath = (lastRepoPath: string) => patch({ lastRepoPath })

      /** Encode + write the config to disk, mapping every failure to `ConfigError`. */
      const persist = (config: WorkspaceConfig): Effect.Effect<WorkspaceConfig, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs
            .makeDirectory(paths.root, { recursive: true })
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to create ~/starbase", cause })))
          const encoded = yield* Schema.encode(WorkspaceConfig)(config).pipe(
            Effect.mapError((cause) => new ConfigError({ message: "Failed to encode config", cause }))
          )
          yield* fs
            .writeFileString(paths.configFile, JSON.stringify(encoded, null, 2))
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to write config", cause })))
          return config
        })

      return { get, setReposDir, setGithub, setGit, setStarredRepos, setLastRepoPath }
    }
  }
) {}
