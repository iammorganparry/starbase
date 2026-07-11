import type { CliKind } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import { Context, Effect, Layer, Stream } from "effect"

/** Parameters for starting a new agent session against a CLI. */
export interface SessionSpec {
  readonly cli: CliKind
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly prompt: string
}

/**
 * A normalized event emitted while an agent session runs. Real adapters parse
 * each CLI's `stream-json` output into this shape; the mock emits canned events.
 */
export type StreamEvent =
  | { readonly _tag: "Started"; readonly sessionId: string }
  | { readonly _tag: "Assistant"; readonly text: string }
  | { readonly _tag: "Thinking"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly name: string; readonly target: string | null }
  | { readonly _tag: "Done"; readonly costUsd: number; readonly tokens: number }

/**
 * The contract for wrapping a native coding CLI. Milestone 1 ships a mock
 * implementation; real headless adapters (`claude -p --output-format stream-json`,
 * codex/cursor equivalents) implement this same interface next.
 */
export interface CliAdapterShape {
  readonly spawn: (spec: SessionSpec) => Effect.Effect<string, CliExecError>
  readonly stream: (sessionId: string) => Stream.Stream<StreamEvent, CliExecError>
  readonly stop: (sessionId: string) => Effect.Effect<void, CliExecError>
}

export class CliAdapter extends Context.Tag("@starbase/CliAdapter")<
  CliAdapter,
  CliAdapterShape
>() {}

/**
 * A deterministic in-memory adapter that exercises the full contract without
 * spawning real processes — used to wire the app end-to-end before real
 * process control lands.
 */
export const MockCliAdapterLive = Layer.succeed(
  CliAdapter,
  CliAdapter.of({
    spawn: (spec) => Effect.succeed(`mock-${spec.cli}-${spec.branch}`),
    stream: (sessionId) =>
      Stream.fromIterable<StreamEvent>([
        { _tag: "Started", sessionId },
        { _tag: "Thinking", text: "Reviewing the request and planning the change…" },
        { _tag: "ToolCall", name: "Edit", target: "src/auth/refresh.ts" },
        { _tag: "Assistant", text: "Applied the change and opened a pull request." },
        { _tag: "Done", costUsd: 0.38, tokens: 42_100 }
      ]),
    stop: () => Effect.void
  })
)
