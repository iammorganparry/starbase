import { execFile } from "node:child_process"
import { Effect } from "effect"

export interface CodexSkillRoot {
  readonly sourcePath: string
  readonly namespace: string
}

interface CodexPluginList {
  readonly installed?: ReadonlyArray<{
    readonly name?: unknown
    readonly installed?: unknown
    readonly enabled?: unknown
    readonly source?: { readonly path?: unknown }
  }>
}

/** Parse only enabled, installed plugin roots; cached-but-uninstalled plugins must stay hidden. */
export const parseCodexSkillRoots = (output: string): ReadonlyArray<CodexSkillRoot> => {
  try {
    const parsed = JSON.parse(output) as CodexPluginList
    return (parsed.installed ?? []).flatMap((plugin) =>
      plugin.installed === true &&
      plugin.enabled === true &&
      typeof plugin.name === "string" &&
      typeof plugin.source?.path === "string"
        ? [{ sourcePath: plugin.source.path, namespace: plugin.name }]
        : []
    )
  } catch {
    return []
  }
}

/** Ask Codex which plugins are active so their namespaced skills can join the `/` menu. */
export const probeCodexSkillRoots = (
  binPath: string | null,
  cwd: string | null
): Effect.Effect<ReadonlyArray<CodexSkillRoot>> => {
  if (binPath === null) return Effect.succeed([])
  return Effect.tryPromise(
    () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          binPath,
          ["plugin", "list", "--json"],
          { cwd: cwd ?? undefined, timeout: 5_000, maxBuffer: 2_000_000 },
          (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout)
          }
        )
      })
  ).pipe(
    Effect.map(parseCodexSkillRoots),
    Effect.orElseSucceed(() => [])
  )
}
