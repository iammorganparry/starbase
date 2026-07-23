/**
 * XtermView — one live xterm.js cell bound to one PTY (by `terminalId`).
 *
 * Performance choices:
 *  - **WebGL renderer** (GPU) when available, DOM fallback otherwise.
 *  - **Bounded scrollback** (5000 lines) caps renderer memory.
 *  - Output arrives already *coalesced* from the main process, so `term.write`
 *    is called at most ~60×/sec/terminal regardless of raw throughput.
 *  - Resize is rAF-debounced to avoid reflow thrash while dragging the splitter.
 *
 * Lifecycle: everything (xterm instance, WebGL context, attach stream, input
 * subscription, ResizeObserver) is torn down on unmount — no leaks. Detaching
 * does NOT kill the PTY; it keeps running in main and is re-attachable.
 */
import { useEffect, useRef } from "react"
import { useThemeTokens } from "@starbase/ui"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { rpc } from "./rpc-client.js"

/**
 * The terminal is themed like everything else, but through a different pipe:
 * xterm paints to a canvas and takes a JS object, so it reads `ThemeTokens`
 * directly instead of CSS custom properties. `tokens.terminal` is the theme's
 * own `terminal.ansi*` palette where it declares one, and a derivation from the
 * accent ramp where it does not — see `@starbase/themes`'s mapper.
 */

export interface XtermViewProps {
  terminalId: string
  /** Called with the exit code when the shell process ends. */
  onExit?: (code: number) => void
}

export function XtermView({ terminalId, onExit }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep the latest onExit without re-running the (expensive) mount effect.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  const { terminal: palette } = useThemeTokens()
  /**
   * The palette is read through a ref in the mount effect, and applied through
   * a SEPARATE effect afterwards.
   *
   * Putting it in the mount effect's dependency array would tear down and
   * rebuild the whole terminal on every theme switch — losing the WebGL
   * context, the PTY attachment and, most visibly, the entire scrollback. A
   * colour change must not cost the operator their session output.
   */
  const themeRef = useRef(palette)
  themeRef.current = palette
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      scrollback: 5000,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { ...themeRef.current }
    })

    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => void window.starbase.openExternal(uri)))
    term.open(el)

    // GPU rendering when the context is available; silently fall back to DOM.
    let webgl: WebglAddon | null = null
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => addon.dispose())
      term.loadAddon(addon)
      webgl = addon
    } catch {
      webgl = null
    }

    fit.fit()

    // Operator input → PTY.
    const inputSub = term.onData((data) => void rpc.terminalWrite(terminalId, data))

    // PTY output → terminal. Replays scrollback first, then live coalesced frames.
    const detach = rpc.terminalAttach(terminalId, (chunk) => {
      if (chunk._tag === "data") {
        term.write(chunk.data)
      } else {
        term.write(`\r\n\x1b[2m[process exited with code ${chunk.exitCode}]\x1b[0m\r\n`)
        onExitRef.current?.(chunk.exitCode)
      }
    })

    // Fit + inform the PTY on resize, rAF-debounced (splitter drags fire fast).
    let raf = 0
    const scheduleFit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* container detached mid-drag */
        }
        void rpc.terminalResize(terminalId, term.cols, term.rows)
      })
    }
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(el)

    // Push the initial size to the PTY (create used a guessed 80×24).
    void rpc.terminalResize(terminalId, term.cols, term.rows)
    term.focus()

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      inputSub.dispose()
      detach()
      webgl?.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [terminalId])

  // Repaint an already-running terminal in place: no remount, no lost
  // scrollback, no dropped PTY.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { ...palette }
  }, [palette])

  return <div ref={containerRef} className="h-full w-full" />
}
