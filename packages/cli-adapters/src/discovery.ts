import type { CliInfo, CliKind } from "@starbase/core"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { expandHome, runString, which } from "./command.js"

/**
 * Static description of how to find each supported CLI: the binary names to look
 * up on `PATH`, plus absolute-path candidates for common non-PATH installs.
 */
interface CliSpec {
  readonly label: string
  readonly bins: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<string>
}

const CLI_SPECS: Record<CliKind, CliSpec> = {
  claude: {
    label: "Claude Code",
    bins: ["claude"],
    candidates: ["~/.claude/local/claude", "~/.local/bin/claude", "/opt/homebrew/bin/claude"]
  },
  codex: {
    label: "Codex CLI",
    bins: ["codex"],
    candidates: ["~/.local/bin/codex", "/opt/homebrew/bin/codex"]
  },
  cursor: {
    label: "Cursor Agent",
    bins: ["cursor-agent", "cursor"],
    candidates: ["~/.local/bin/cursor-agent"]
  }
}

/** Capture a CLI's version string by invoking `<bin> --version`. */
const versionOf = (bin: string) => runString(bin, "--version")

const unavailable = (kind: CliKind, spec: CliSpec): CliInfo => ({
  kind,
  label: spec.label,
  binPath: null,
  version: null,
  available: false
})

/** Probe the host for one CLI, folding all failures into an unavailable result. */
const probe = (
  kind: CliKind,
  spec: CliSpec
): Effect.Effect<CliInfo, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // 1. PATH lookup for each candidate binary name.
    for (const bin of spec.bins) {
      const path = yield* which(bin)
      if (path !== null) {
        return {
          kind,
          label: spec.label,
          binPath: path,
          version: yield* versionOf(path),
          available: true
        }
      }
    }
    // 2. Fall back to well-known absolute install paths. A successful
    //    `--version` both confirms existence and captures the version.
    for (const candidate of spec.candidates) {
      const resolved = yield* expandHome(candidate)
      const version = yield* versionOf(resolved)
      if (version !== null) {
        return { kind, label: spec.label, binPath: resolved, version, available: true }
      }
    }
    return unavailable(kind, spec)
  })

/**
 * Discovers which coding CLIs are installed on the host. All probing runs
 * concurrently and never fails the scan — an absent CLI yields
 * `{ available: false }`. Requires a `CommandExecutor` (provided by
 * `NodeCommandExecutor.layer` in the Electron main process).
 */
export class DiscoveryService extends Effect.Service<DiscoveryService>()(
  "@starbase/DiscoveryService",
  {
    accessors: true,
    sync: () => ({
      list: (): Effect.Effect<
        ReadonlyArray<CliInfo>,
        never,
        CommandExecutor.CommandExecutor
      > =>
        Effect.forEach(
          Object.entries(CLI_SPECS) as ReadonlyArray<[CliKind, CliSpec]>,
          ([kind, spec]) => probe(kind, spec),
          { concurrency: "unbounded" }
        )
    })
  }
) {}
