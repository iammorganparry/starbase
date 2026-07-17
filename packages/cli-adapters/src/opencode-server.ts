import { spawn } from "node:child_process"
import { trackChild } from "./child-registry.js"
import { parseServerUrl } from "./opencode-adapter.js"

/**
 * Boot a throwaway opencode server, hand its URL to `fn`, and shut it down.
 *
 * Everything Starbase asks opencode *about* — the resolved model catalogue, the
 * provider list, writing a key — goes through its HTTP API, which means a
 * server. Booting one costs ~0.7s, about the same as any of opencode's own
 * one-shot commands, and it answers far more richly than they do.
 *
 * The environment is inherited UNTOUCHED. That's the BYOK contract: opencode
 * resolves providers from the user's own credentials, including bare env vars
 * like `OPENROUTER_API_KEY`, so anything we asked it here must be exactly what a
 * real run would see. Injecting config would make the answer a fiction.
 *
 * Never throws — every failure (no binary, boot timeout, bad response) resolves
 * to null so callers degrade rather than break. `binPath` comes from
 * `DiscoveryService`: a GUI-launched Electron app has a threadbare `PATH`, so a
 * bare `opencode` lookup would miss installs discovery finds at an absolute path.
 */
export const withOpencodeServer = async <A>(
  binPath: string | null | undefined,
  fn: (url: string) => Promise<A | null>,
  timeoutMs = 8000
): Promise<A | null> => {
  if (!binPath) return null

  // `--port=0` asks for a free port. opencode actually tries 4096 first and only
  // falls back if it's taken, so the port is never assumed — we read the URL out
  // of the banner it prints.
  //
  // stderr is DISCARDED at the OS level, not piped. A pipe with no reader fills
  // (~64KB) and the child then blocks on its next write — which could strand it
  // before it ever prints the banner, and the failure would be invisible: the
  // guard fires, this returns null, and the model list silently falls back while
  // the provider list comes up empty. Today's opencode writes nothing to stderr
  // at boot (389 bytes even at DEBUG), so it can't happen yet — but its log
  // volume isn't our contract, and this costs nothing to rule out for good.
  //
  // `runOpencode`'s own spawn DOES pipe and drain stderr, because it puts the
  // text in its error message. This one has nowhere to put it: every failure
  // here resolves to null by design.
  // Tracked so app teardown reaps it: the `finally` kill below covers this
  // helper returning, but not the main process dying mid-probe, which would
  // orphan an `opencode serve` (PPID 1) that never exits on its own.
  const proc = trackChild(
    spawn(binPath, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env
    })
  )
  const kill = (): void => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM")
  }
  const guard = setTimeout(kill, timeoutMs)

  try {
    const url = await new Promise<string | null>((resolve) => {
      let output = ""
      let settled = false
      const done = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        const parsed = parseServerUrl(output)
        if (parsed !== null) done(parsed)
      })
      // A dead server must reject rather than hang until the guard fires.
      proc.on("error", () => done(null))
      proc.on("exit", () => done(null))
      setTimeout(() => done(null), timeoutMs)
    })
    return url === null ? null : await fn(url)
  } catch {
    return null
  } finally {
    clearTimeout(guard)
    kill()
  }
}
