/**
 * Local dev entrypoint. Vercel never runs this file — it imports `src/app.ts`
 * through `api/[[...route]].ts` instead. `pnpm --filter @starbase/server dev`
 * runs this under `tsx watch`.
 */
import { serve } from "@hono/node-server"
import { app } from "./app.js"
import { env } from "./env.js"

serve({ fetch: app.fetch, port: env.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[@starbase/server] listening on http://localhost:${info.port} (${env.nodeEnv})`)
})
