import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface AuthCardProps {
  /** Card heading, e.g. "Sign in to Starbase". */
  title: string
  /** Supporting line under the heading. */
  subtitle?: string
  /** The auth controls (OAuth buttons, divider, magic-link form, …). */
  children: ReactNode
  className?: string
}

/**
 * The sign-in card chrome: the breathing ✦ brand mark, heading + subtitle, and a
 * blue ambient glow, wrapping whatever auth controls are slotted in. A molecule
 * so the same shell can host sign-in, sign-up, or recovery bodies later.
 */
export function AuthCard({ title, subtitle, children, className }: AuthCardProps) {
  return (
    <div
      className={cn(
        "relative z-10 flex w-[328px] flex-col items-center rounded-lg border border-line bg-panel px-7 pb-6 pt-7",
        className
      )}
      style={{
        boxShadow:
          "0 0 64px -14px rgba(97,175,239,0.5),0 0 22px -6px rgba(97,175,239,0.35),0 10px 30px -12px rgba(0,0,0,0.7)"
      }}
    >
      <div className="mb-4 flex size-[38px] items-center justify-center rounded-md border border-blue/30 bg-blue/10">
        <span className="font-mono text-[18px] font-semibold text-blue [animation:sb-breathe_3.8s_ease-in-out_infinite]">
          ✦
        </span>
      </div>
      <h1 className="mb-1.5 text-center text-[17px] font-semibold tracking-[-0.01em] text-text-bright">
        {title}
      </h1>
      {subtitle ? (
        <p className="mb-5 text-center text-[12px] leading-snug text-text">{subtitle}</p>
      ) : null}
      <div className="flex w-full flex-col items-center gap-4">{children}</div>
    </div>
  )
}
