import { afterAll, describe, expect, it, vi } from "vitest"
import { app } from "./app.js"
import { sql } from "./db/client.js"
import { runtime } from "./runtime.js"

/**
 * End-to-end HTTP coverage of the auth backend against a REAL Postgres — exercises
 * BetterAuth + Drizzle + the repository layer through Hono's `app.request`, no
 * network server. Needs Docker Postgres, so it's gated behind STARBASE_DB_TESTS
 * and excluded from the CI unit run (see `vitest.config.ts`); run it with
 * `pnpm --filter @starbase/server test:integration` after `docker compose up -d db`
 * and `db:migrate`.
 */
const RUN = process.env.STARBASE_DB_TESTS === "1"

const cookieFrom = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""

describe.skipIf(!RUN)("auth backend (integration, needs Postgres)", () => {
  afterAll(async () => {
    await runtime.dispose()
    await sql.end()
  })

  /**
   * Cross-tenant isolation, against a real database.
   *
   * This is the worst bug this feature could ship, so it is asserted at the
   * REPOSITORY level rather than through a route: a route test proves one
   * handler is scoped today, while a repository test proves the only way to
   * reach the data is scoped at all. Every method takes `organizationId` first
   * precisely so there is no unscoped query to forget.
   */
  it("never returns one organisation's outcomes to another", async () => {
    const { LearningsRepository } = await import("./db/repositories/learnings-repository.js")
    const { Effect } = await import("effect")
    const { db } = await import("./db/client.js")
    const { organization, user, repoModelOutcome } = await import("./db/schema.js")
    const { eq, inArray } = await import("drizzle-orm")

    const stamp = Date.now()
    const orgA = `org-a-${stamp}`
    const orgB = `org-b-${stamp}`
    const userId = `u-${stamp}`
    const repoKey = `repo-${stamp}`

    await db.insert(user).values({
      id: userId,
      name: "T",
      email: `t-${stamp}@example.com`,
      emailVerified: true
    })
    await db.insert(organization).values([
      { id: orgA, name: "A", slug: `a-${stamp}`, createdAt: new Date() },
      { id: orgB, name: "B", slug: `b-${stamp}`, createdAt: new Date() }
    ])

    const outcome = {
      id: "s_1",
      repoKey,
      taskKind: "schema",
      cli: "codex",
      vendor: "openai",
      model: "gpt-5.6-sol",
      findingsCritical: 0,
      findingsMajor: 0,
      findingsMinor: 0,
      findingsNit: 0,
      ciPassed: true,
      merged: true,
      filesReverted: 0,
      planRevisions: 0,
      sizeBucket: "m",
      score: 2,
      occurredOn: "2026-07-18"
    }

    try {
      await runtime.runPromise(LearningsRepository.record(orgA, userId, [outcome]))

      const mine = await runtime.runPromise(LearningsRepository.affinity(orgA, repoKey))
      expect(mine).toHaveLength(1)
      expect(mine[0]?.observations).toBe(1)

      // The same repository, checked out by someone in a DIFFERENT org: they
      // must see nothing at all.
      const theirs = await runtime.runPromise(LearningsRepository.affinity(orgB, repoKey))
      expect(theirs).toEqual([])

      // Contribution is idempotent, so a retried sync cannot double-count.
      await runtime.runPromise(LearningsRepository.record(orgA, userId, [outcome]))
      expect((await runtime.runPromise(LearningsRepository.affinity(orgA, repoKey)))[0]?.observations).toBe(1)

      // A purge only removes the caller's own rows, in their own org.
      await runtime.runPromise(LearningsRepository.purge(orgB, userId))
      expect((await runtime.runPromise(LearningsRepository.affinity(orgA, repoKey)))[0]?.observations).toBe(1)
      await runtime.runPromise(LearningsRepository.purge(orgA, userId))
      expect(await runtime.runPromise(LearningsRepository.affinity(orgA, repoKey))).toEqual([])
    } finally {
      await db.delete(repoModelOutcome).where(eq(repoModelOutcome.repoKey, repoKey))
      await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
      await db.delete(user).where(eq(user.id, userId))
    }
  })

  it("refuses learnings routes without a bearer token", async () => {
    expect((await app.request("/api/learnings/affinity?repoKey=x")).status).toBe(401)
    expect(
      (await app.request("/api/learnings/outcomes", { method: "POST", body: "{}" })).status
    ).toBe(401)
  })

  it("health check responds", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok" })
  })

  it("magic link → session → bearer → /api/me → sign out", async () => {
    const email = `it_${Date.now()}@example.com`

    // 1. Request a magic link; capture the verify URL logged to the console.
    const logs: Array<string> = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })
    const sent = await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "http://localhost:9100/desktop/callback" })
    })
    spy.mockRestore()
    expect(sent.status).toBe(200)

    const verifyUrl = logs.join("\n").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0]
    expect(verifyUrl, "magic-link verify URL should be logged in dev").toBeTruthy()
    const verifyPath = verifyUrl!.replace(/^https?:\/\/[^/]+/, "")

    // 2. "Click" the link: BetterAuth verifies, creates the session, sets a cookie.
    const verified = await app.request(verifyPath)
    const cookie = cookieFrom(verified)
    expect(cookie).toContain("=")

    // 3. Desktop bridge: reads the session cookie → starbase:// deep link w/ token.
    const bridge = await app.request("/desktop/callback", { headers: { cookie } })
    expect(bridge.status).toBe(302)
    const location = bridge.headers.get("location") ?? ""
    const token = new URL(location).searchParams.get("token")
    expect(token, "bridge should redirect with a token").toBeTruthy()

    // 4. /api/me (repository-backed) with the bearer token returns the user.
    const me = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { user: { email: string } }
    expect(meBody.user.email).toBe(email)

    // 5. Sign out revokes the session.
    const out = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(out.status).toBe(200)
  })

  it("/api/me is 401 without a bearer token", async () => {
    const res = await app.request("/api/me")
    expect(res.status).toBe(401)
  })
})
