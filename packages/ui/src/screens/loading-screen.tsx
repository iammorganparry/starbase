import { useEffect, useRef } from "react"

/**
 * Full-bleed launch splash shown while the app boots (see the renderer's
 * `appMachine` loading/starting states). A rocket fuels on the pad — rumble and
 * exhaust build with the progress bar — then lifts off, streaks the sky, and the
 * sequence loops until boot completes and the screen unmounts.
 *
 * Ported from the `Loading.dc.html` design. The launch/progress/shake are driven
 * imperatively via `requestAnimationFrame` (refs, no per-frame React re-renders);
 * only the ambient star twinkle, ascent streaks and loading dots are pure CSS.
 * Honours `prefers-reduced-motion` by holding a calm, static pad state.
 */

interface Star {
  readonly left: string
  readonly top: string
  readonly size: number
  readonly color: string
  readonly dur: string
  readonly delay: string
}

const STARS: ReadonlyArray<Star> = [
  { left: "12%", top: "22%", size: 2, color: "#d7dae0", dur: "3s", delay: "0.2s" },
  { left: "28%", top: "14%", size: 2, color: "#61afef", dur: "2.4s", delay: "0.9s" },
  { left: "68%", top: "18%", size: 2, color: "#d7dae0", dur: "3.4s", delay: "0.5s" },
  { left: "82%", top: "28%", size: 3, color: "#56b6c2", dur: "2.8s", delay: "1.4s" },
  { left: "44%", top: "9%", size: 2, color: "#d7dae0", dur: "3.1s", delay: "0.7s" },
  { left: "56%", top: "34%", size: 2, color: "#828997", dur: "2.2s", delay: "1.1s" },
  { left: "91%", top: "12%", size: 2, color: "#828997", dur: "2.6s", delay: "0s" },
  { left: "7%", top: "44%", size: 2, color: "#d7dae0", dur: "3.6s", delay: "1.8s" }
]

interface Streak {
  readonly left: string
  readonly width: number
  readonly height: number
  readonly tint: string
  readonly dur: string
  readonly delay: string
}

const STREAKS: ReadonlyArray<Streak> = [
  { left: "14%", width: 2, height: 44, tint: "rgba(255,255,255,.35)", dur: "1.1s", delay: "0.1s" },
  { left: "31%", width: 1, height: 60, tint: "rgba(97,175,239,.5)", dur: "0.9s", delay: "0.4s" },
  { left: "52%", width: 2, height: 36, tint: "rgba(255,255,255,.3)", dur: "1.3s", delay: "0.2s" },
  { left: "70%", width: 1, height: 52, tint: "rgba(255,255,255,.3)", dur: "1s", delay: "0.6s" },
  { left: "87%", width: 2, height: 40, tint: "rgba(86,182,194,.45)", dur: "1.2s", delay: "0.3s" }
]

export function LoadingScreen() {
  const rk = useRef<HTMLDivElement>(null)
  const shake = useRef<HTMLDivElement>(null)
  const trail = useRef<HTMLDivElement>(null)
  const glow = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const pct = useRef<HTMLSpanElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const streaks = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    // Calm, static pad state for reduced-motion users — no launch, no rumble.
    if (reduce) {
      if (bar.current) bar.current.style.width = "40%"
      if (pct.current) pct.current.textContent = "40%"
      if (status.current) status.current.textContent = "Fueling"
      return
    }

    let raf = 0
    let timer = 0
    let t0 = 0
    let launched = false
    const DUR = 3800

    const start = () => {
      const rkEl = rk.current
      if (!rkEl || !trail.current || !streaks.current || !bar.current) {
        raf = requestAnimationFrame(start)
        return
      }
      rkEl.style.transition = "none"
      rkEl.style.transform = "translate(-50%,0)"
      trail.current.style.transition = "none"
      trail.current.style.height = "0px"
      trail.current.style.opacity = "0"
      streaks.current.style.opacity = "0"
      bar.current.style.width = "0%"
      t0 = performance.now()
      launched = false
      raf = requestAnimationFrame(tick)
    }

    const tick = () => {
      const t = performance.now() - t0
      const p = Math.min(1, t / DUR)
      const ease = p * p * (3 - 2 * p) // smoothstep

      if (!launched) {
        if (bar.current) bar.current.style.width = `${(ease * 100).toFixed(1)}%`
        if (pct.current) pct.current.textContent = `${Math.round(ease * 100)}%`
        if (status.current) {
          status.current.textContent =
            p < 0.45 ? "Fueling" : p < 0.85 ? "Ignition sequence" : "Hold on"
        }
        // Rumble builds with the countdown.
        const amp = 5.5 * p * p
        const jx = (Math.random() - 0.5) * 2 * amp
        const jy = (Math.random() - 0.5) * amp
        if (shake.current) {
          shake.current.style.transform = `rotate(-45deg) translate(${jx.toFixed(1)}px,${jy.toFixed(1)}px)`
        }
        if (glow.current) {
          glow.current.style.opacity = (
            0.25 +
            0.55 * p +
            (p > 0.7 ? Math.random() * 0.2 : 0)
          ).toFixed(2)
          glow.current.style.transform = `translateX(-50%) scale(${(1 + p * 0.5).toFixed(2)})`
        }
        if (p > 0.7 && trail.current) {
          trail.current.style.opacity = ((p - 0.7) * 2).toFixed(2)
          trail.current.style.height = `${(14 * (p - 0.7)) / 0.3}px`
        }
        if (p >= 1) launch()
      }
      raf = requestAnimationFrame(tick)
    }

    const launch = () => {
      launched = true
      if (status.current) status.current.textContent = "Liftoff!"
      if (pct.current) pct.current.textContent = "100%"
      if (rk.current) {
        rk.current.style.transition = "transform 1.15s cubic-bezier(.62,-.02,.9,.4)"
        rk.current.style.transform = "translate(-50%,-125vh)"
      }
      if (trail.current) {
        trail.current.style.transition = "height .5s ease-out, opacity .9s ease-in .5s"
        trail.current.style.height = "150px"
        trail.current.style.opacity = "1"
        requestAnimationFrame(() => {
          if (trail.current) trail.current.style.opacity = "0"
        })
      }
      if (streaks.current) streaks.current.style.opacity = "1"
      if (glow.current) glow.current.style.opacity = "0.9"
      // Settle, then loop the sequence until boot finishes and we unmount.
      timer = window.setTimeout(() => {
        if (glow.current) glow.current.style.opacity = "0.25"
        if (status.current) status.current.textContent = "Fueling"
        start()
      }, 2100)
    }

    start()
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [])

  return (
    <div
      className="relative h-full w-full overflow-hidden font-sans"
      style={{
        background:
          "radial-gradient(120% 90% at 50% 118%,#1b2230 0%,#12141a 45%,#0f1115 100%)"
      }}
    >
      {/* Twinkling stars */}
      <div className="pointer-events-none absolute inset-0">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: s.left,
              top: s.top,
              width: s.size,
              height: s.size,
              background: s.color,
              animation: `sb-twinkle ${s.dur} ease-in-out infinite`,
              animationDelay: s.delay
            }}
          />
        ))}
      </div>

      {/* Ascent streaks (revealed on liftoff) */}
      <div
        ref={streaks}
        className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-500"
      >
        {STREAKS.map((s, i) => (
          <span
            key={i}
            className="absolute top-0 rounded-[2px]"
            style={{
              left: s.left,
              width: s.width,
              height: s.height,
              background: `linear-gradient(rgba(255,255,255,0),${s.tint})`,
              animation: `sb-streak ${s.dur} linear infinite`,
              animationDelay: s.delay
            }}
          />
        ))}
      </div>

      {/* Pad glow */}
      <div
        ref={glow}
        className="absolute bottom-[24%] left-1/2 h-[70px] w-[200px] -translate-x-1/2 rounded-[50%] opacity-25"
        style={{
          background:
            "radial-gradient(ellipse at center,rgba(229,136,63,.35),rgba(229,136,63,0) 65%)"
        }}
      />

      {/* Rocket rig: outer = launch translate, inner = rumble */}
      <div
        ref={rk}
        className="absolute bottom-[27%] left-1/2 [transform:translate(-50%,0)] [will-change:transform]"
      >
        <div
          ref={trail}
          className="absolute top-[52px] left-[calc(50%+2px)] h-0 w-[10px] -translate-x-1/2 rounded-[6px] opacity-0 [filter:blur(2px)]"
          style={{ background: "linear-gradient(#ffd696,#e5883f 30%,rgba(229,136,63,0))" }}
        />
        <div
          ref={shake}
          className="text-[58px] leading-none [transform:rotate(-45deg)] [filter:drop-shadow(0_5px_14px_rgba(0,0,0,.5))]"
        >
          🚀
        </div>
      </div>

      {/* Brand mark */}
      <div className="absolute top-[26px] left-1/2 flex -translate-x-1/2 items-center gap-[9px] opacity-85">
        <span className="flex size-[22px] items-center justify-center rounded-md bg-blue text-[13px] text-editor">
          ✦
        </span>
        <span className="text-[14px] font-semibold text-text-bright">Starbase</span>
      </div>

      {/* Copy + progress */}
      <div className="absolute bottom-[9%] left-1/2 flex w-[320px] -translate-x-1/2 flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              ref={status}
              className="text-[17px] font-bold tracking-[-0.2px] text-text-bright"
            >
              Fueling
            </span>
            <span className="inline-flex gap-[3px]">
              {[0, 0.2, 0.4].map((delay) => (
                <span
                  key={delay}
                  className="size-1 rounded-full bg-blue"
                  style={{ animation: "sb-dot 1.4s ease-in-out infinite", animationDelay: `${delay}s` }}
                />
              ))}
            </span>
          </div>
          <span className="font-mono text-[11.5px] text-dim">
            spinning up agents · warming the worktrees
          </span>
        </div>
        <div className="flex w-full items-center gap-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-[3px] border border-line bg-panel">
            <div
              ref={bar}
              className="h-full w-0 rounded-[3px]"
              style={{ background: "linear-gradient(90deg,#61afef,#56b6c2)" }}
            />
          </div>
          <span
            ref={pct}
            className="w-[34px] text-right font-mono text-[11px] text-muted-foreground"
          >
            0%
          </span>
        </div>
      </div>
    </div>
  )
}
