import { join } from "node:path"
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
  /**
   * Lowest version Starbase can drive, as `[major, minor]`. Absent = any version
   * goes (we adapt to whatever the user has). Present only where an older line is
   * genuinely undriveable rather than merely dated.
   */
  readonly minVersion?: readonly [number, number]
  /** Command to suggest when `minVersion` isn't met, e.g. `opencode upgrade`. */
  readonly upgradeWith?: string
  /**
   * Whether this harness exposes BACKGROUND TASKS the operator can see and stop
   * individually — a live task set, per-task progress, and a per-task stop.
   *
   * Only Claude does. Codex and OpenCode can abort a whole turn but have no
   * per-task handle, so the background-task dock stays hidden for them rather
   * than offering a Stop button with nothing to aim at.
   */
  readonly backgroundTasks?: boolean
}

const CLI_SPECS: Record<CliKind, CliSpec> = {
  claude: {
    label: "Claude Code",
    backgroundTasks: true,
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
  },
  opencode: {
    label: "opencode",
    bins: ["opencode"],
    candidates: ["~/.opencode/bin/opencode", "~/.local/bin/opencode", "/opt/homebrew/bin/opencode"],
    // The 1.0.x line can't be driven the way the adapter expects: no `--auto`,
    // `--fork` or `--variant`, and it predates opencode's move to a SQLite
    // session store. Supporting both regimes isn't worth it — gate instead.
    //
    // Deliberately NOT bundling our own opencode: Conductor does, and their
    // bundled copy fights the user's install over the shared session DB at
    // ~/.local/share/opencode/opencode.db (their 0.76.0 bug). Probing the user's
    // own binary sidesteps that entirely.
    minVersion: [1, 18],
    upgradeWith: "opencode upgrade"
  },
  // Us, and deliberately LAST. There is no binary to probe for, so
  // `bins`/`candidates` are empty and `probe` short-circuits on this kind before
  // it ever touches the filesystem — an empty candidate list would otherwise
  // report the orchestrator as "not installed" on every host.
  //
  // Order matters beyond cosmetics: callers take the first available harness as
  // the default for a NEW session, and defaulting to the orchestrator would put
  // every new session through a multi-minute, multi-model planning round nobody
  // asked for. Selecting Starbase must stay a deliberate act.
  starbase: {
    label: "Starbase",
    bins: [],
    candidates: []
  }
}

/**
 * Restrict discovery to a single directory. Set only by the e2e suite.
 *
 * The tests must not find the developer's real `claude` / `opencode`. Booting
 * them is slow and non-deterministic, and `withOpencodeServer` inherits the
 * environment UNTOUCHED by design (the BYOK contract), so a test run would drive
 * the developer's own binary against their own credentials.
 *
 * Scrubbing `PATH` cannot achieve this on its own: `candidates` below deliberately
 * includes absolute install paths (`/opt/homebrew/bin/opencode`, `~/.local/bin/...`)
 * precisely so a GUI-launched app with a threadbare PATH still finds them. This
 * override therefore replaces BOTH lookups — it is the only way to make discovery
 * hermetic.
 */
const DISCOVERY_BIN_DIR = "STARBASE_DISCOVERY_BIN_DIR"

/** The pinned discovery dir, or null when discovery should probe the real host. */
const pinnedBinDir = (): string | null => {
  const dir = process.env[DISCOVERY_BIN_DIR]
  return dir === undefined || dir === "" ? null : dir
}

/** Capture a CLI's version string by invoking `<bin> --version`. */
const versionOf = (bin: string) => runString(bin, "--version")

/**
 * Whether `raw` (a `--version` output) is at least `min`. Reads the first
 * dotted-numeric run anywhere in the string, so it copes with the range of
 * shapes CLIs emit: bare `1.18.0`, `codex-cli 0.5.0`, `1.2.3 (Claude Code)`.
 * An unparseable version is treated as *passing* — refusing to run a CLI because
 * we couldn't read its banner would be worse than trying and failing loudly.
 */
export const meetsMinVersion = (raw: string | null, min: readonly [number, number]): boolean => {
  if (raw === null) return false
  const match = /(\d+)\.(\d+)/.exec(raw)
  if (match === null) return true
  const major = Number(match[1])
  const minor = Number(match[2])
  return major !== min[0] ? major > min[0] : minor >= min[1]
}

const unavailable = (kind: CliKind, spec: CliSpec, note?: string): CliInfo => ({
  kind,
  label: spec.label,
  backgroundTasks: spec.backgroundTasks ?? false,
  binPath: null,
  version: null,
  available: false,
  ...(note === undefined ? {} : { note })
})

/** The "installed, but too old to drive" result — carries a note explaining why. */
const tooOld = (kind: CliKind, spec: CliSpec, version: string | null): CliInfo => {
  const [major, minor] = spec.minVersion!
  const upgrade = spec.upgradeWith === undefined ? "" : ` Upgrade with \`${spec.upgradeWith}\`.`
  return unavailable(
    kind,
    spec,
    `${spec.label} ${version ?? "(unknown version)"} found — Starbase needs ${major}.${minor} or newer.${upgrade}`
  )
}

/** Probe the host for one CLI, folding all failures into an unavailable result. */
const probe = (
  kind: CliKind,
  spec: CliSpec
): Effect.Effect<CliInfo, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Starbase ships WITH the app, so "is it installed" is always yes and there
    // is nothing on disk to look for. Availability here means exactly that;
    // whether a round can actually run on this host is a different question with
    // a different answer (`planningReadiness` — it needs two independent
    // vendors), and the picker renders that as a disabled entry with the reason.
    // Conflating the two here would report the orchestrator as "not installed",
    // which is both false and unactionable.
    if (kind === "starbase") {
      return {
        kind,
        label: spec.label,
        binPath: null,
        version: null,
        available: true,
        backgroundTasks: false
      }
    }

    // Found a binary — accept it only if it clears `minVersion`. A too-old CLI is
    // reported unavailable *with a note*, so the UI can say "upgrade" rather than
    // pretend nothing is installed.
    const accept = (binPath: string, version: string | null): CliInfo =>
      spec.minVersion !== undefined && !meetsMinVersion(version, spec.minVersion)
        ? tooOld(kind, spec, version)
        : {
            kind,
            label: spec.label,
            binPath,
            version,
            available: true,
            backgroundTasks: spec.backgroundTasks ?? false
          }

    // 0. Pinned dir (e2e only): this dir IS the host, so neither the PATH lookup
    //    nor the absolute candidates below may run — a real install must stay
    //    invisible even though its path is hardcoded a few lines down.
    const pinned = pinnedBinDir()
    if (pinned !== null) {
      for (const bin of spec.bins) {
        const candidate = join(pinned, bin)
        const version = yield* versionOf(candidate)
        if (version !== null) return accept(candidate, version)
      }
      return unavailable(kind, spec)
    }

    // 1. PATH lookup for each candidate binary name.
    for (const bin of spec.bins) {
      const path = yield* which(bin)
      if (path !== null) return accept(path, yield* versionOf(path))
    }
    // 2. Fall back to well-known absolute install paths. A successful
    //    `--version` both confirms existence and captures the version.
    for (const candidate of spec.candidates) {
      const resolved = yield* expandHome(candidate)
      const version = yield* versionOf(resolved)
      if (version !== null) return accept(resolved, version)
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
