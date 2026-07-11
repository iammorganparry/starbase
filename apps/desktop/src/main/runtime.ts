/**
 * The main-process Effect runtime. `AppLayer` wires every backend dependency the
 * RPC handlers need — the Node platform (`CommandExecutor` + `FileSystem` +
 * `Path`), the workspace/config/git/gh/discovery/session services, the native
 * dialog + `~/starbase` path layers — and launches the RPC server.
 * `ManagedRuntime` keeps the layer's scope (forked server daemon + IPC listener)
 * alive for the lifetime of the app.
 */
import {
  AgentRunner,
  ConfigService,
  DiscoveryService,
  GhService,
  GitService,
  HarnessCliAdapterLive,
  SessionStore,
  SkillsService,
  TranscriptStore,
  WorkspaceService
} from "@starbase/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { AppPathsLive } from "./app-paths.js"
import { DialogServiceLive } from "./dialog.js"
import { RpcServerLive } from "./rpc.js"

// Later `Layer.provide`s satisfy the requirements of earlier ones, so the leaf
// dependencies (paths, dialog, Node platform) come last.
const AppLayer = RpcServerLive.pipe(
  Layer.provide(DiscoveryService.Default),
  Layer.provide(WorkspaceService.Default),
  Layer.provide(SessionStore.Default),
  Layer.provide(TranscriptStore.Default),
  Layer.provide(AgentRunner.Default),
  Layer.provide(SkillsService.Default),
  Layer.provide(GhService.Default),
  Layer.provide(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(HarnessCliAdapterLive),
  Layer.provide(DialogServiceLive),
  Layer.provide(AppPathsLive),
  // NodeContext bundles CommandExecutor + FileSystem + Path used by the git/gh/
  // discovery/config/workspace/session services.
  Layer.provide(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
