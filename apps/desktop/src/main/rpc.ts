/**
 * RPC transport — the crux of the app.
 *
 * APPROACH: the real `@effect/rpc` machinery, wired over Electron IPC with a
 * pair of *custom Protocols* (NOT the hand-rolled dispatch fallback). The main
 * process runs `RpcServer` and the renderer runs `RpcClient`; both are driven
 * by the shared `StarbaseRpcs` group, which stays the single source of truth for
 * every payload/success/error schema. The only thing crossing the IPC boundary
 * is already-encoded, JSON-safe `FromClientEncoded` / `FromServerEncoded` frames
 * on one channel (`RPC_CHANNEL`); RpcServer/RpcClient own all schema
 * encode/decode. (We avoid the no-serialization path because its *decoded*
 * frames carry Effect `Exit`/`Cause` class instances that don't survive
 * Electron's structured-clone IPC.)
 */
import { DiscoveryService, SessionStore } from "@starbase/cli-adapters"
import { StarbaseRpcs } from "@starbase/contracts"
import { RpcServer } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Layer, Mailbox, Option, Runtime } from "effect"
import type { WebContents } from "electron"
import { ipcMain } from "electron"

/** The single IPC channel both directions of the RPC transport ride on. */
export const RPC_CHANNEL = "starbase/rpc"

/**
 * Handlers for every procedure in the group. Each one delegates straight to an
 * Effect service, so the group remains the sole contract. `Discovery.list`
 * pulls in a `CommandExecutor` requirement (via `DiscoveryService.list()`) that
 * `AppLayer` satisfies with the Node platform layer.
 */
const HandlersLayer = StarbaseRpcs.toLayer({
  "Discovery.list": () => DiscoveryService.list(),
  "Sessions.list": () => SessionStore.list(),
  "Sessions.get": ({ id }) => SessionStore.get(id)
})

/**
 * There is exactly one renderer. We remember its `WebContents` from the most
 * recent inbound frame so the server can push responses back to it. Requests
 * always arrive after the window has loaded, so this is set before any `send`.
 */
let sender: WebContents | null = null

/**
 * A custom `RpcServer.Protocol` that pumps encoded frames over `ipcMain` /
 * `webContents.send`. `writeRequest` feeds an inbound client frame into the
 * server core; `send` ships a server response back to the renderer.
 */
const ServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make((writeRequest) =>
    Effect.gen(function* () {
      const disconnects = yield* Mailbox.make<number>()
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

      ipcMain.on(RPC_CHANNEL, (event, data: FromClientEncoded) => {
        sender = event.sender
        runFork(writeRequest(event.sender.id, data))
      })

      return {
        disconnects,
        send: (_clientId: number, response: FromServerEncoded) =>
          Effect.sync(() => sender?.send(RPC_CHANNEL, response)),
        end: (_clientId: number) => Effect.void,
        clientIds: Effect.sync(() => new Set(sender ? [sender.id] : [])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false
      }
    })
  )
)

/**
 * The running RPC server: the group's handlers served over the IPC protocol.
 * Building this layer forks the server daemon and registers the `ipcMain`
 * listener; it still requires `CommandExecutor | DiscoveryService | SessionStore`,
 * which `AppLayer` provides.
 */
export const RpcServerLive = RpcServer.layer(StarbaseRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(ServerProtocolLive)
)
