/**
 * Renderer-side RPC client. Mirror image of `src/main/rpc.ts`: a custom
 * `RpcClient.Protocol` that shuttles encoded frames over the preload bridge
 * (`window.starbase`), driving a real `RpcClient` built from the shared
 * `StarbaseRpcs` group. Callers get plain, typed Promises back.
 */
import type {
  CliInfo,
  CreateSessionInput,
  GateDecision,
  GhStatus,
  Message,
  PermissionMode,
  Repo,
  Session,
  Skill,
  StreamEvent,
  WorkspaceConfig
} from "@starbase/core"
import { StarbaseRpcs } from "@starbase/contracts"
import { RpcClient } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Fiber, Layer, ManagedRuntime, Runtime, Scope, Stream } from "effect"

/**
 * A custom `RpcClient.Protocol` bound to the preload bridge. `send` ships a
 * client→server frame to main; incoming server→client frames are pushed into
 * the client core via `writeResponse`.
 */
const ClientProtocolLive = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

      window.starbase.on((data) => {
        runFork(writeResponse(data as FromServerEncoded))
      })

      return {
        send: (request: FromClientEncoded) =>
          Effect.sync(() => window.starbase.send(request)),
        supportsAck: true,
        supportsTransferables: false
      }
    })
  )
)

/** One runtime provides the IPC client protocol for the app's lifetime. */
const runtime = ManagedRuntime.make(ClientProtocolLive)

/**
 * The client's background fibers must outlive any single call, so we build it
 * once inside a scope that is never closed (until the page unloads).
 */
const clientScope = Effect.runSync(Scope.make())

const clientPromise = runtime.runPromise(
  RpcClient.make(StarbaseRpcs).pipe(Scope.extend(clientScope))
)

const run = <A>(
  f: (client: Awaited<typeof clientPromise>) => Effect.Effect<A, unknown>
): Promise<A> => clientPromise.then((client) => runtime.runPromise(f(client)))

/** The typed calls the renderer consumes. */
export const rpc = {
  discoveryList: (): Promise<ReadonlyArray<CliInfo>> =>
    run((c) => c.Discovery.list()),
  configGet: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Config.get()),
  chooseReposDir: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Setup.chooseReposDir()),
  workspaceRepos: (): Promise<ReadonlyArray<Repo>> =>
    run((c) => c.Workspace.repos()),
  workspaceBranches: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.branches({ repoPath })),
  ghStatus: (): Promise<GhStatus> =>
    run((c) => c.Gh.status()),
  sessionsList: (): Promise<ReadonlyArray<Session>> =>
    run((c) => c.Sessions.list()),
  sessionsGet: (id: string): Promise<Session> =>
    run((c) => c.Sessions.get({ id })),
  sessionsCreate: (input: CreateSessionInput): Promise<Session> =>
    run((c) => c.Sessions.create(input)),
  sessionsTranscript: (id: string): Promise<ReadonlyArray<Message>> =>
    run((c) => c.Sessions.transcript({ id })),
  sessionsDiff: (id: string): Promise<string> => run((c) => c.Sessions.diff({ id })),
  workspaceFiles: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.files({ repoPath })),
  skillsList: (sessionId: string): Promise<ReadonlyArray<Skill>> =>
    run((c) => c.Skills.list({ sessionId })),
  agentDecideGate: (sessionId: string, gateId: string, decision: GateDecision): Promise<void> =>
    run((c) => c.Agent.decideGate({ sessionId, gateId, decision })),
  agentSetMode: (sessionId: string, mode: PermissionMode): Promise<void> =>
    run((c) => c.Agent.setMode({ sessionId, mode })),
  agentStop: (sessionId: string): Promise<void> => run((c) => c.Agent.stop({ sessionId })),

  /**
   * Subscribe to a prompt's normalized event stream. Forks the RPC stream on the
   * client runtime, pushing each `StreamEvent` to `onEvent`; returns a canceller
   * that interrupts the run (used on unmount / session switch / stop).
   */
  agentRun: (
    sessionId: string,
    text: string,
    onEvent: (event: StreamEvent) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Agent.run({ sessionId, text }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  }
}
