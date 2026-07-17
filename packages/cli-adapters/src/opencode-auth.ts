import type { OpencodeProviderInfo } from "@starbase/core"
import type { OpencodeProvider } from "./opencode-models.js"
import { readAllProviders, readProviders } from "./opencode-models.js"
import { withOpencodeServer } from "./opencode-server.js"

/**
 * opencode's provider/credential surface, for Settings · Providers.
 *
 * The design rule: **Starbase never owns an opencode credential.** Keys are
 * written through opencode's OWN auth API (`PUT /auth/{providerID}` →
 * `~/.local/share/opencode/auth.json`), which means:
 *  - a key added in Starbase works in a bare `opencode` shell too, and
 *  - a key the user already added with `opencode auth login` just works here,
 *  - and `SecretStore` keeps holding exactly one thing: the Starbase bearer
 *    token.
 *
 * That is what "respect their BYOK" has to mean — a second, Starbase-shaped
 * credential store would be a worse copy of the one opencode already has.
 *
 * `source` is the honest part of this: it says where each provider's credential
 * actually came from, so the UI can show that OpenRouter is live because of an
 * env var the user set, and offer to add a key only where one is missing.
 */

/**
 * Fold opencode's two provider reads into the rows Settings renders — the pure,
 * unit-tested seam.
 *
 * It takes BOTH reads because neither alone can answer the question:
 *  - `all` + `connected` (`GET /provider`) — every provider opencode knows
 *    (~167) and which currently resolve. This is what makes "Add key" reachable:
 *    `/config/providers` lists only providers that ALREADY work, so on its own
 *    you could never add a key for one you haven't configured — to add
 *    OpenRouter you'd need OpenRouter already working.
 *  - `configured` (`GET /config/providers`) — the true ORIGIN of a connected
 *    provider's credential. `all[].source` can't be used for this: the registry
 *    stamps almost everything `"custom"` regardless.
 *
 * Connected providers sort first — the ones actually doing work belong at the
 * top — then alphabetically within each group.
 */
export const toProviderInfos = (
  all: ReadonlyArray<OpencodeProvider>,
  connected: ReadonlyArray<string> = [],
  configured: ReadonlyArray<OpencodeProvider> = []
): ReadonlyArray<OpencodeProviderInfo> => {
  const isConnected = new Set(connected)
  const byId = new Map(configured.filter((p) => typeof p?.id === "string").map((p) => [p.id, p]))

  return all
    .filter((p) => typeof p?.id === "string" && p.id.length > 0)
    .map((p) => {
      const live = byId.get(p.id)
      return {
        id: p.id,
        name: p.name ?? p.id,
        // A provider is only "sourced" if it actually resolves. `api` is the
        // fallback for a connected provider that `/config/providers` didn't
        // detail — it resolved from somewhere, and a key in opencode's own store
        // is the likeliest somewhere.
        source: isConnected.has(p.id) ? (live?.source ?? "api") : null,
        // The env vars this provider reads, so the UI can name the one to set
        // instead of making the user go and find it.
        env: p.env ?? [],
        // Models it RESOLVES, not models it could. An unconnected provider
        // resolves none — the registry's catalogue for it is potential, and
        // reporting that as live would be a lie.
        modelCount: isConnected.has(p.id) ? Object.keys(live?.models ?? p.models ?? {}).length : 0
      }
    })
    .sort(
      (a, b) =>
        Number(b.source !== null) - Number(a.source !== null) || a.name.localeCompare(b.name)
    )
}

/**
 * Every provider opencode knows about, each marked with whether it resolves for
 * this user and where its credential came from. Null when opencode can't be
 * reached — the caller shows the harness as unconfigured rather than an empty
 * provider list.
 */
export const fetchOpencodeProviders = async (
  binPath?: string | null
): Promise<ReadonlyArray<OpencodeProviderInfo> | null> =>
  withOpencodeServer(binPath, async (url) => {
    // One server boot, two reads — the registry is useless without knowing which
    // entries are live, and the live list is useless for adding a key.
    const [registry, live] = await Promise.all([readAllProviders(url), readProviders(url)])
    if (registry === null) return null
    return toProviderInfos(registry.all ?? [], registry.connected ?? [], live?.providers ?? [])
  })

/**
 * Store an API key for `providerId` in opencode's own credential file, exactly
 * as `opencode auth login` would. Returns whether it landed.
 *
 * Verified against a live 1.18 server: the SDK templates this route as
 * `/auth/{id}` while the server declares `/auth/{providerID}`, but both resolve
 * to the same concrete URL, so the SDK's method is correct here (unlike its
 * permission types — see `PermissionAsked`).
 */
export const setOpencodeAuth = async (
  binPath: string | null | undefined,
  providerId: string,
  key: string
): Promise<boolean> => {
  const ok = await withOpencodeServer(binPath, async (url) => {
    const { createOpencodeClient } = await import("@opencode-ai/sdk")
    const client = createOpencodeClient({ baseUrl: url })
    const res = await client.auth.set({ path: { id: providerId }, body: { type: "api", key } })
    return res.error === undefined ? true : null
  })
  return ok === true
}
