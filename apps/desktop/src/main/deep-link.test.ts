import { describe, expect, it } from "vitest"
import { findDeepLinkInArgv, parseAuthCallback } from "./deep-link.js"

/**
 * The deep-link parsers are pure (no Electron), so they're unit-tested directly.
 * They decide whether an inbound URL/argv is a sign-in callback and extract the
 * token or error the main process then acts on.
 */
describe("parseAuthCallback", () => {
  it("extracts the token from a valid callback", () => {
    expect(parseAuthCallback("starbase://auth/callback?token=abc123")).toEqual({
      token: "abc123",
      error: null
    })
  })

  it("extracts an error when sign-in failed", () => {
    expect(parseAuthCallback("starbase://auth/callback?error=nosession")).toEqual({
      token: null,
      error: "nosession"
    })
  })

  it("rejects a non-starbase scheme", () => {
    expect(parseAuthCallback("https://auth/callback?token=abc")).toBeNull()
  })

  it("rejects a starbase URL that isn't the auth host", () => {
    expect(parseAuthCallback("starbase://open/session?token=abc")).toBeNull()
  })

  it("rejects an unparseable URL", () => {
    expect(parseAuthCallback("not a url")).toBeNull()
  })
})

describe("findDeepLinkInArgv", () => {
  it("finds a starbase link among other argv entries", () => {
    expect(
      findDeepLinkInArgv(["/path/electron", "--flag", "starbase://auth/callback?token=x"])
    ).toBe("starbase://auth/callback?token=x")
  })

  it("returns null when no deep link is present", () => {
    expect(findDeepLinkInArgv(["/path/electron", "--flag"])).toBeNull()
  })
})
