/**
 * The server's Effect runtime. `AppLayer` wires the `Database` service and every
 * Repository built on it; Hono handlers run Effects through `runtime.runPromise`.
 * A single `ManagedRuntime` is reused across requests (and across warm Vercel
 * invocations), mirroring the module-scoped Drizzle client.
 *
 * Add a repository: build it here (`provideMerge` its `.Default`) and it becomes
 * available to every handler.
 */
import { Layer, ManagedRuntime } from "effect"
import { Database } from "./db/database.js"
import { LearningsRepository } from "./db/repositories/learnings-repository.js"
import { UserRepository } from "./db/repositories/user-repository.js"

const AppLayer = Layer.mergeAll(UserRepository.Default, LearningsRepository.Default).pipe(
  Layer.provideMerge(Database.Default)
)

export const runtime = ManagedRuntime.make(AppLayer)
