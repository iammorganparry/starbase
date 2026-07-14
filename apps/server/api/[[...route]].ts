/**
 * Vercel Functions entrypoint. `vercel.json` rewrites every path to this
 * catch-all, and `@hono/vercel`'s `handle` adapts the Hono app to Vercel's
 * Node runtime. Node (not edge) because `postgres`/`drizzle-orm` need Node APIs.
 */
import { handle } from "hono/vercel"
import { app } from "../src/app.js"

export const config = { runtime: "nodejs" }

export default handle(app)
