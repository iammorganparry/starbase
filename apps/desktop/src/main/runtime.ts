/**
 * The main-process Effect runtime. `AppLayer` wires every backend dependency the
 * RPC handlers need — the Node platform (`CommandExecutor` + `FileSystem` +
 * `Path`), the workspace/config/git/gh/discovery/session services, the native
 * dialog + `~/starbase` path layers — and launches the RPC server.
 * `ManagedRuntime` keeps the layer's scope (forked server daemon + IPC listener)
 * alive for the lifetime of the app.
 */
import {
  AdversarialPlanService,
  AgentRunner,
  AuthService,
  ConfigService,
  ContextManager,
  DiscoveryService,
  GhService,
  GitService,
  HarnessCliAdapterLive,
  ModelsService,
  PlanStore,
  PlanExecutor,
  PlanRoundStore,
  ReviewService,
  ReviewStore,
  SessionStore,
  McpService,
  SkillsService,
  TerminalService,
  ThemeService,
  TranscriptStore,
  BackgroundTaskStore,
  RankingService,
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
  ReviewStore.Default,
  PlanExecutor.Default,
  PlanRoundStore.Default,
)

/**
 * The three things that drive a CLI harness. `AgentRunner` owns the session's
 * conversation; `ReviewService` drives the adapter itself so an adversarial
 * review can run on its own model, read-only, without touching that
 * conversation; `ContextManager` does the same to summarise a session's own
 * transcript when its working set outgrows the quality band. Peers — none
 * depends on the others, and all three reach the harness through `CliAdapter`.
 */
const HarnessLayers = Layer.mergeAll(
  AgentRunner.Default,
  ReviewService.Default,
  ContextManager.Default,
  AdversarialPlanService.Default
)

// Later `Layer.provide`s satisfy the requirements of earlier ones, so the leaf
// dependencies (paths, dialog, Node platform) come last.
const AppLayer = RpcServerLive.pipe(
  // provideMerge: the RPC handlers consume DiscoveryService AND the main process
  // reaches the same instance to warm the model cache at startup (index.ts).
  Layer.provideMerge(DiscoveryService.Default),
  // AuthService requires SecretStore, satisfied by SecretStoreLive (merged below).
  Layer.provide(AuthService.Default),
  Layer.provide(WorkspaceService.Default),
  // Before SessionStore so the stores below satisfy the daemon's requirements —
  // a stage is provided-to by everything that follows it.
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
  // provideMerge: the `Theme.*` handlers consume ThemeService AND the main
  // process reaches the very same instance at startup, to resolve the boot
  // theme before the window is constructed (see `boot-theme.ts`). That has to
  // happen outside the RPC surface by definition — there is no renderer yet.
  Layer.provideMerge(ThemeService.Default),
  // Merged into one stage purely to stay inside `pipe`'s 20-argument limit;
  // neither depends on the other, so the composition is unchanged.
  Layer.provide(Layer.mergeAll(SkillsService.Default, McpService.Default)),
  // provideMerge: the `Models.*` handlers consume ModelsService AND the startup
  // prefetch reaches the very same instance — a different one would warm a cache
  // nobody reads, so the merge is what makes the prefetch actually count. The
  // rankings peer is also process-cached and has no dependencies.
  Layer.provideMerge(Layer.mergeAll(ModelsService.Default, RankingService.Default)),
  Layer.provide(UsageService.Default),
  Layer.provide(GhService.Default),
  // provideMerge: the `Config.*` handlers consume ConfigService AND the boot
  // theme resolution reads the active theme id from it before any window
  // exists.
  Layer.provideMerge(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(HarnessCliAdapterLive),
  Layer.provide(DialogServiceLive),
  Layer.provide(BrowserPreviewServiceLive),
  // provideMerge so ThemeService/ConfigService stay callable from the runtime
  // directly (boot theme), not only from inside an RPC handler.
  Layer.provideMerge(AppPathsLive),
  // NodeContext bundles CommandExecutor + FileSystem + Path used by the git/gh/
  // discovery/config/workspace/session services. Merged (not just provided) so
  // the startup prefetch can run `DiscoveryService.list`, which needs the executor.
  Layer.provideMerge(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
