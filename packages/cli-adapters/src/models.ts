import type { CliKind, ModelOption } from "@starbase/core"
import { FALLBACK_MODELS } from "@starbase/core"
import { Effect, Ref } from "effect"

/**
 * Live model discovery per harness. Models are pulled from each provider's
 * models API using whatever credentials are available (env API keys), so the
 * list stays current instead of hardcoded. When discovery isn't possible
 * (offline / subscription-only auth with no API key), we fall back to the small
 * curated `FALLBACK_MODELS`. Results are cached for the process lifetime.
 */

const CLAUDE = /^claude/i
const OPENAI_KEEP = /^(gpt-5|gpt-4\.1|o3|o4|codex)/i
const OPENAI_DROP = /(audio|realtime|embedding|tts|image|moderation|transcribe|search|instruct|preview-\d)/i

const fetchAnthropic = async (): Promise<ReadonlyArray<ModelOption> | null> => {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> }
  return (body.data ?? [])
    .filter((m) => CLAUDE.test(m.id))
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }))
}

const fetchOpenAI = async (): Promise<ReadonlyArray<ModelOption> | null> => {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => OPENAI_KEEP.test(id) && !OPENAI_DROP.test(id))
    .sort()
    .map((id) => ({ id, label: id }))
}

const fetchFor = (cli: CliKind): Promise<ReadonlyArray<ModelOption> | null> =>
  cli === "claude" ? fetchAnthropic() : cli === "codex" ? fetchOpenAI() : Promise.resolve(null)

export class ModelsService extends Effect.Service<ModelsService>()("@starbase/ModelsService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const cache = yield* Ref.make(new Map<CliKind, ReadonlyArray<ModelOption>>())
    return {
      list: (cli: CliKind): Effect.Effect<ReadonlyArray<ModelOption>> =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(cache)).get(cli)
          if (cached) return cached
          const fetched = yield* Effect.tryPromise(() => fetchFor(cli)).pipe(
            Effect.orElseSucceed(() => null)
          )
          const result = fetched && fetched.length > 0 ? fetched : FALLBACK_MODELS[cli]
          yield* Ref.update(cache, (m) => new Map(m).set(cli, result))
          return result
        })
    }
  })
}) {}
