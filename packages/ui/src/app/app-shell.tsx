import type { ReactNode } from "react"
import { MotionConfig } from "motion/react"
import { TitleBar } from "./title-bar.js"

/** The window frame: title bar plus routed content. */
export function AppShell({
  title,
  actions,
  children
}: {
  title?: string
  /** App-level controls pinned to the title bar's right edge. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    // `reducedMotion="user"` is the ONE place the app honours
    // `prefers-reduced-motion`: it makes every transform and layout animation
    // instant while leaving opacity fades alone, so a split still reads as
    // changing without anything sliding. Doing this per-component would be four
    // places to forget; doing it here means a new animated component is
    // accessible by default.
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col overflow-hidden bg-editor text-text">
        <TitleBar title={title} actions={actions} />
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </MotionConfig>
  )
}
