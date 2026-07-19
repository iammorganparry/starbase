import type {
  LearningConfig, CliKind, GitConfig, GithubConfig, ProviderConfig } from "@starbase/core"
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
            ...(existing?.collapsedRepos ? { collapsedRepos: existing.collapsedRepos } : {}),
            ...(existing?.lastRepoPath ? { lastRepoPath: existing.lastRepoPath } : {}),
            ...(existing?.providers ? { providers: existing.providers } : {}),
            // MANDATORY: omit a section here and every unrelated save silently
            // drops it, because `patch` is a whole-object read-modify-write.
            ...(existing?.learning ? { learning: existing.learning } : {}),
            ...patch
          }
          return yield* persist(config)
        })

      const setReposDir = (dir: string) => patch({ reposDir: dir })

      const setGithub = (github: GithubConfig) => patch({ github })

      const setGit = (git: GitConfig) => patch({ git })

      const setStarredRepos = (starredRepos: ReadonlyArray<string>) =>
        patch({ starredRepos })

      const setCollapsedRepos = (collapsedRepos: ReadonlyArray<string>) =>
        patch({ collapsedRepos })

      const setLastRepoPath = (lastRepoPath: string) => patch({ lastRepoPath })

      /** Upsert one CLI's provider defaults, preserving the other providers. */
      /** Persist the learning switch. Absent ⇒ off, so this is the only way it turns on. */
      const setLearning = (learning: LearningConfig) => patch({ learning })

      /** Persist the orchestrator's harness+model. Absent ⇒ the curated default. */
      const setOrchestrator = (cli: CliKind, model: string) =>
        patch({ orchestrator: { cli, model } })

      const setProvider = (cli: CliKind, provider: ProviderConfig) =>
        Effect.gen(function* () {
          const existing = yield* get()
          return yield* patch({
            providers: { ...(existing?.providers ?? {}), [cli]: provider }
          })
        })

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

      return {
        get,
        setReposDir,
        setGithub,
        setGit,
        setStarredRepos,
        setCollapsedRepos,
        setLastRepoPath,
        setProvider,
        setLearning,
        setOrchestrator
      }
    }
  }
) {}
