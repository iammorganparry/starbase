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
  AuthService,
  ConfigService,
  DiscoveryService,
  GhService,
  GitService,
  HarnessCliAdapterLive,
  ModelsService,
  PlanStore,
  ReviewService,
  ReviewStore,
  SessionStore,
  McpService,
  SkillsService,
  TerminalService,
  TranscriptStore,
  BackgroundTaskStore,
  UsageService,
  WorkspaceService
} from "@starbase/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { AppPathsLive } from "./app-paths.js"
import { BrowserPreviewServiceLive } from "./browser-preview.js"
import { DialogServiceLive } from "./dialog.js"
import { RpcServerLive } from "./rpc.js"
import { PlaintextSecretStoreLive, SecretStoreLive } from "./secret-store.js"

// e2e selects a plaintext file store (no OS keychain prompts under Playwright);
// every real build uses the keychain-backed store.
const SecretStoreLayer =
  process.env.STARBASE_SECRET_STORE === "memory" ? PlaintextSecretStoreLive : SecretStoreLive

/**
 * The per-session JSON stores under `~/starbase`. Independent peers — each needs
 * only FileSystem/Path/AppPaths — so they're merged into one `provide` rather
 * than chained. (`pipe` tops out at 20 arguments; grouping peers keeps headroom.)
 */
const StoreLayers = Layer.mergeAll(
  TranscriptStore.Default,
  BackgroundTaskStore.Default,
  PlanStore.Default,
  ReviewStore.Default
)

/**
 * The two things that drive a CLI harness. `AgentRunner` owns the session's
 * conversation; `ReviewService` drives the adapter itself so an adversarial
 * review can run on its own model, read-only, without touching that
 * conversation. Peers — neither depends on the other.
 */
const HarnessLayers = Layer.mergeAll(AgentRunner.Default, ReviewService.Default)

// Later `Layer.provide`s satisfy the requirements of earlier ones, so the leaf
// dependencies (paths, dialog, Node platform) come last.
const AppLayer = RpcServerLive.pipe(
  // provideMerge: the RPC handlers consume DiscoveryService AND the main process
  // reaches the same instance to warm the model cache at startup (index.ts).
  Layer.provideMerge(DiscoveryService.Default),
  // AuthService requires SecretStore, satisfied by SecretStoreLive (merged below).
  Layer.provide(AuthService.Default),
  Layer.provide(WorkspaceService.Default),
  Layer.provide(SessionStore.Default),
  Layer.provide(StoreLayers),
  Layer.provide(HarnessLayers),
  // provideMerge (not provide): the RPC handlers consume TerminalService AND the
  // runtime keeps it in context, so the `before-quit` kill-all can reach the very
  // same instance to reap PTYs.
  Layer.provideMerge(TerminalService.Default),
  // provideMerge: the RPC auth handlers consume SecretStore AND the main process
  // reaches the same instance directly (deep-link token storage in index.ts).
  Layer.provideMerge(SecretStoreLayer),
  Layer.provide(SkillsService.Default),
  Layer.provide(McpService.Default),
  // provideMerge: the `Models.*` handlers consume ModelsService AND the startup
  // prefetch reaches the very same instance — a different one would warm a cache
  // nobody reads, so the merge is what makes the prefetch actually count.
  Layer.provideMerge(ModelsService.Default),
  Layer.provide(UsageService.Default),
  Layer.provide(GhService.Default),
  Layer.provide(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(HarnessCliAdapterLive),
  Layer.provide(DialogServiceLive),
  Layer.provide(BrowserPreviewServiceLive),
  Layer.provide(AppPathsLive),
  // NodeContext bundles CommandExecutor + FileSystem + Path used by the git/gh/
  // discovery/config/workspace/session services. Merged (not just provided) so
  // the startup prefetch can run `DiscoveryService.list`, which needs the executor.
  Layer.provideMerge(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
