/**
 * The renderer's auth state machine — the sign-in wall's brain, kept SEPARATE
 * from `appMachine` so the (growing) auth surface doesn't bloat the app-level
 * flow. `App` gates the whole app on this reaching `signedIn`.
 *
 * States:
 *   checking      — validating any stored token (getSession) on boot / after a callback
 *   signedOut     — the wall; substates model the email + OAuth affordances:
 *     idle          — nothing in flight
 *     sending       — magic-link request in flight
 *     magicLinkSent — "check your email" confirmation
 *     oauthPending  — browser opened, awaiting the `starbase://` callback
 *     error         — a send/OAuth attempt failed
 *   signedIn      — authenticated; `SIGN_OUT` revokes and returns to the wall
 *   signingOut    — sign-out request in flight
 *
 * Room to grow: `signUp` / `forgotPassword` slot in as siblings of `signedOut`'s
 * substates without touching `appMachine`. The `CALLBACK` event (from the main
 * process's deep-link handler) re-runs `checking`, so both OAuth and magic-link
 * returns converge on the same validation path.
 */
import type { AuthProvider, AuthSession } from "@starbase/core"
import { assign, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"

export interface AuthContext {
  /** Controlled email input (lifted so `sent`/`error` survive re-renders). */
  readonly email: string
  /** Display name from the sign-up form; sent with the magic link on sign-up. */
  readonly name: string | null
  /** The address a magic link was sent to (for the confirmation copy). */
  readonly sentEmail: string | null
  /** User-facing error message for the `error` substate. */
  readonly error: string | null
  /** The live session once signed in (so the app can read the user). */
  readonly session: AuthSession | null
}

export type AuthEvent =
  | { type: "OAUTH"; provider: AuthProvider }
  | { type: "MAGIC_LINK"; email: string; name?: string }
  | { type: "CALLBACK" }
  | { type: "RESET" }
  | { type: "SIGN_OUT" }

const checkAuth = fromPromise<AuthSession | null>(() => rpc.authGetSession())

const sendMagicLink = fromPromise<void, { email: string; name: string | null }>(({ input }) =>
  rpc.authSendMagicLink(input.email, input.name ?? undefined)
)

const startOAuth = fromPromise<void, { provider: AuthProvider }>(async ({ input }) => {
  const url = await rpc.authStartSignIn(input.provider)
  await window.starbase.openExternal(url)
})

const signOut = fromPromise<void>(() => rpc.authSignOut())

export const authMachine = setup({
  types: {
    context: {} as AuthContext,
    events: {} as AuthEvent
  },
  actors: { checkAuth, sendMagicLink, startOAuth, signOut },
  guards: {
    hasSession: ({ event }) => "output" in event && event.output !== null
  }
}).createMachine({
  id: "auth",
  initial: "checking",
  context: { email: "", name: null, sentEmail: null, error: null, session: null },
  states: {
    checking: {
      invoke: {
        src: "checkAuth",
        onDone: [
          {
            guard: "hasSession",
            target: "signedIn",
            actions: assign({ session: ({ event }) => event.output })
          },
          { target: "signedOut" }
        ],
        onError: { target: "signedOut" }
      }
    },
    signedOut: {
      initial: "idle",
      // OAuth / magic-link kick off from any substate; a deep-link callback
      // re-validates via `checking`.
      on: {
        OAUTH: { target: ".oauthPending", actions: assign({ error: () => null }) },
        MAGIC_LINK: {
          target: ".sending",
          actions: assign({
            email: ({ event }) => event.email,
            name: ({ event }) => event.name ?? null,
            error: () => null
          })
        },
        CALLBACK: "checking"
      },
      states: {
        idle: {},
        sending: {
          invoke: {
            src: "sendMagicLink",
            input: ({ context }) => ({ email: context.email, name: context.name }),
            onDone: {
              target: "magicLinkSent",
              actions: assign({ sentEmail: ({ context }) => context.email })
            },
            onError: {
              target: "error",
              actions: assign({
                error: () => "We couldn't send the sign-in link. Please try again."
              })
            }
          }
        },
        magicLinkSent: {
          on: {
            RESET: {
              target: "idle",
              actions: assign({ sentEmail: () => null, email: () => "", name: () => null })
            }
          }
        },
        oauthPending: {
          invoke: {
            src: "startOAuth",
            input: ({ event }) => ({
              provider: event.type === "OAUTH" ? event.provider : "github"
            }),
            onError: {
              target: "error",
              actions: assign({ error: () => "Couldn't start sign-in. Please try again." })
            }
          }
        },
        error: {
          on: { RESET: "idle" }
        }
      }
    },
    signedIn: {
      on: { SIGN_OUT: "signingOut" }
    },
    signingOut: {
      invoke: {
        src: "signOut",
        onDone: { target: "signedOut", actions: assign({ session: () => null }) },
        onError: { target: "signedOut", actions: assign({ session: () => null }) }
      }
    }
  }
})
