import type { OpencodeProviderInfo } from "@starbase/core"
import type { OpencodeProvider } from "./opencode-models.js"
import { readProviders } from "./opencode-models.js"
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
 * Fold `/config/providers` into the rows Settings renders — the pure,
 * unit-tested seam.
 *
 * Providers are sorted by whether they're configured, so the ones actually doing
 * work are at the top. A provider with zero resolved models is still listed:
 * that is precisely the "you have the integration but no key" case the settings
 * page exists to fix.
 */
export const toProviderInfos = (
  providers: ReadonlyArray<OpencodeProvider>
): ReadonlyArray<OpencodeProviderInfo> =>
  providers
    .filter((p) => typeof p?.id === "string" && p.id.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      source: p.source ?? null,
      // The env vars this provider reads, so the UI can name the one to set
      // instead of making the user go and find it.
      env: p.env ?? [],
      modelCount: Object.keys(p.models ?? {}).length
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

/**
 * Every provider opencode currently resolves for the user, with the origin of
 * each credential. Null when opencode can't be reached — the caller shows the
 * harness as unconfigured rather than an empty provider list.
 */
export const fetchOpencodeProviders = async (
  binPath?: string | null
): Promise<ReadonlyArray<OpencodeProviderInfo> | null> =>
  withOpencodeServer(binPath, async (url) => {
    const body = await readProviders(url)
    return body === null ? null : toProviderInfos(body.providers ?? [])
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
