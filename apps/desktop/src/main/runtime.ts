/**
 * The main-process Effect runtime. `AppLayer` wires every backend dependency the
 * RPC handlers need — the Node platform (which supplies the `CommandExecutor`
 * that CLI discovery shells out through), the discovery + session services, the
 * mock CLI adapter — and launches the RPC server. `ManagedRuntime` keeps the
 * layer's scope (and thus the forked server daemon + IPC listener) alive for the
 * lifetime of the app.
 */
import {
  DiscoveryService,
  MockCliAdapterLive,
  SessionStore
} from "@starbase/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { RpcServerLive } from "./rpc.js"

const AppLayer = RpcServerLive.pipe(
  Layer.provide(DiscoveryService.Default),
  Layer.provide(SessionStore.Default),
  Layer.provide(MockCliAdapterLive),
  // NodeContext bundles the CommandExecutor + FileSystem that DiscoveryService
  // shells out through (`which claude`, `<bin> --version`, …).
  Layer.provide(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
