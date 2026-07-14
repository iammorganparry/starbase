import { createActor, waitFor } from "xstate"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authMachine } from "./auth-machine.js"

/**
 * The auth machine's side-effects go through `rpc-client` (mocked) and
 * `window.starbase.openExternal` (stubbed), so it runs under node. We drive it
 * through the same events the LoginScreen sends and assert the states the gate
 * keys off: signed-in vs the wall, the magic-link sent/error substates, the
 * OAuth → deep-link → signed-in path, and sign-out.
 */
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; image: string | null }; expiresAt: string },
  magicLinkOk: true,
  sentEmails: [] as Array<string>,
  signInUrl: "https://provider.example/oauth",
  openedUrls: [] as Array<string>,
  signOutCalls: 0
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    authGetSession: async () => h.session,
    authSendMagicLink: async (email: string) => {
      h.sentEmails.push(email)
      if (!h.magicLinkOk) throw new Error("send failed")
    },
    authStartSignIn: async () => h.signInUrl,
    authSignOut: async () => {
      h.signOutCalls += 1
    }
  }
}))

const SESSION = {
  user: { id: "u1", email: "founder@example.com", name: "Founder", image: null },
  expiresAt: "2099-01-01T00:00:00Z"
}

beforeEach(() => {
  h.session = null
  h.magicLinkOk = true
  h.sentEmails = []
  h.openedUrls = []
  h.signOutCalls = 0
  vi.stubGlobal("window", {
    starbase: { openExternal: async (url: string) => void h.openedUrls.push(url) }
  })
})

const start = () => {
  const actor = createActor(authMachine)
  actor.start()
  return actor
}

describe("authMachine", () => {
  it("lands on the wall (signedOut) when there's no session", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedOut"))
    expect(actor.getSnapshot().matches({ signedOut: "idle" })).toBe(true)
  })

  it("goes straight to signedIn when a valid session exists", async () => {
    h.session = SESSION
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedIn"))
    expect(actor.getSnapshot().context.session?.user.email).toBe("founder@example.com")
  })

  it("sends a magic link and shows the sent confirmation", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedOut"))
    actor.send({ type: "MAGIC_LINK", email: "hi@team.com" })
    await waitFor(actor, (s) => s.matches({ signedOut: "magicLinkSent" }))
    expect(h.sentEmails).toEqual(["hi@team.com"])
    expect(actor.getSnapshot().context.sentEmail).toBe("hi@team.com")
  })

  it("shows the error substate when the magic link fails, and RESET recovers", async () => {
    h.magicLinkOk = false
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedOut"))
    actor.send({ type: "MAGIC_LINK", email: "hi@team.com" })
    await waitFor(actor, (s) => s.matches({ signedOut: "error" }))
    expect(actor.getSnapshot().context.error).toBeTruthy()
    actor.send({ type: "RESET" })
    expect(actor.getSnapshot().matches({ signedOut: "idle" })).toBe(true)
  })

  it("opens the browser for OAuth and signs in on the deep-link callback", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedOut"))
    actor.send({ type: "OAUTH", provider: "github" })
    await waitFor(actor, (s) => s.matches({ signedOut: "oauthPending" }))
    expect(h.openedUrls).toEqual(["https://provider.example/oauth"])
    // The main process stored the token; the callback re-validates → signedIn.
    h.session = SESSION
    actor.send({ type: "CALLBACK" })
    await waitFor(actor, (s) => s.matches("signedIn"))
  })

  it("signs out back to the wall", async () => {
    h.session = SESSION
    const actor = start()
    await waitFor(actor, (s) => s.matches("signedIn"))
    actor.send({ type: "SIGN_OUT" })
    await waitFor(actor, (s) => s.matches("signedOut"))
    expect(h.signOutCalls).toBe(1)
    expect(actor.getSnapshot().context.session).toBeNull()
  })
})
