import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A tiny offline stand-in for `@starbase/server`'s BetterAuth backend, so the
 * auth e2e runs deterministically without Postgres/OAuth/email. It answers the
 * handful of endpoints `AuthService` calls:
 *   - GET  /api/auth/get-session  → the user, iff `Authorization: Bearer <token>`
 *   - POST /api/auth/sign-in/magic-link → records the email, returns {status:true}
 *   - POST /api/auth/sign-in/social     → returns the (fake) provider URL
 *   - GET  /desktop/callback            → 302 to the starbase:// deep link
 *   - POST /api/auth/sign-out           → 200
 */
export interface FakeAuthServer {
  readonly url: string
  readonly token: string
  readonly sentEmails: ReadonlyArray<string>
  readonly close: () => Promise<void>
}

export const startFakeAuthServer = async (token = "e2e-token"): Promise<FakeAuthServer> => {
  const sentEmails: Array<string> = []

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? "localhost"
    const url = new URL(req.url ?? "/", `http://${host}`)
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === "/api/auth/get-session") {
      if (req.headers["authorization"] === `Bearer ${token}`) {
        return json(200, {
          session: { expiresAt: "2099-01-01T00:00:00Z", token },
          user: { id: "u_e2e", email: "e2e@starbase.dev", name: "E2E User", image: null }
        })
      }
      return json(401, {})
    }

    if (url.pathname === "/api/auth/sign-in/social" && req.method === "POST") {
      return json(200, { url: `http://${host}/desktop/callback?token=${token}`, redirect: true })
    }

    if (url.pathname === "/desktop/callback") {
      res.writeHead(302, { Location: `starbase://auth/callback?token=${token}` })
      return res.end()
    }

    if (url.pathname === "/api/auth/sign-in/magic-link" && req.method === "POST") {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        let email: unknown
        try {
          email = JSON.parse(body).email
        } catch {
          /* ignore malformed body */
        }
        // Any address containing "fail" simulates a backend rejection so the
        // LoginScreen error state can be asserted end-to-end.
        if (typeof email === "string" && email.includes("fail")) return json(400, { error: "rejected" })
        if (typeof email === "string") sentEmails.push(email)
        json(200, { status: true })
      })
      return
    }

    if (url.pathname === "/api/auth/sign-out" && req.method === "POST") {
      return json(200, {})
    }

    json(404, {})
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    get sentEmails() {
      return sentEmails
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
