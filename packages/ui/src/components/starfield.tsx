import type { CSSProperties } from "react"
import { cn } from "../lib/cn.js"

/**
 * The deep-space backdrop for the sign-in wall — a radial nebula gradient with a
 * scatter of twinkling stars. Purely decorative (`aria-hidden`), absolutely
 * positioned to fill its (relative) parent. Star positions are fixed so the
 * field renders identically every time (no `Math.random`, which is unavailable
 * in some sandboxes and would make snapshots flaky).
 */
interface Star {
  readonly left: string
  readonly top: string
  readonly size: number
  readonly color: string
  readonly dur: string
  readonly delay: string
}

/*
 * Star colours are tokens, not hexes. The field has to invert with the theme
 * along with the nebula it sits on — bake the stars light and a light theme
 * gets white dots on a near-white sky, i.e. no starfield at all.
 */
const STARS: ReadonlyArray<Star> = [
  { left: "9%", top: "20%", size: 2, color: "var(--sb-text-bright)", dur: "3s", delay: "0.2s" },
  { left: "22%", top: "12%", size: 2, color: "var(--sb-blue)", dur: "2.4s", delay: "0.9s" },
  { left: "74%", top: "16%", size: 2, color: "var(--sb-text-bright)", dur: "3.4s", delay: "0.5s" },
  { left: "86%", top: "26%", size: 3, color: "var(--sb-cyan)", dur: "2.8s", delay: "1.4s" },
  { left: "39%", top: "8%", size: 2, color: "var(--sb-text-bright)", dur: "3.1s", delay: "0.7s" },
  { left: "61%", top: "30%", size: 2, color: "var(--sb-muted)", dur: "2.2s", delay: "1.1s" },
  { left: "93%", top: "9%", size: 2, color: "var(--sb-muted)", dur: "2.6s", delay: "0s" },
  { left: "5%", top: "42%", size: 2, color: "var(--sb-text-bright)", dur: "3.6s", delay: "1.8s" },
  { left: "16%", top: "66%", size: 2, color: "var(--sb-dim)", dur: "3.2s", delay: "0.4s" },
  { left: "90%", top: "64%", size: 2, color: "var(--sb-muted)", dur: "2.9s", delay: "1.3s" },
  { left: "80%", top: "82%", size: 2, color: "var(--sb-blue)", dur: "2.5s", delay: "0.8s" },
  { left: "12%", top: "84%", size: 2, color: "var(--sb-text-bright)", dur: "3.3s", delay: "1.6s" }
]

export function Starfield({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{
        // Nebula falloff: the lit rim at the bottom, then out to the deepest
        // surface the theme has. `canvas` is the darkest token, so the outer two
        // stops share it and the geometry carries the depth.
        background:
          "radial-gradient(120% 95% at 50% 122%,var(--sb-sunken) 0%,var(--sb-canvas) 48%,var(--sb-canvas) 100%)"
      }}
    >
      {STARS.map((s, i) => {
        const style: CSSProperties = {
          left: s.left,
          top: s.top,
          width: s.size,
          height: s.size,
          background: s.color,
          animation: `sb-twinkle ${s.dur} ease-in-out infinite`,
          animationDelay: s.delay
        }
        return <span key={i} className="absolute rounded-full" style={style} />
      })}
    </div>
  )
}
