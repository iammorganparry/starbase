import type { ReactNode } from "react"
import { TitleBar } from "./title-bar.js"

/** The window frame: title bar plus routed content. */
export function AppShell({
  title,
  actions,
  children
}: {
  title?: string
  /** App-level controls pinned to the title bar's right edge (the layout picker). */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-editor text-text">
      <TitleBar title={title} actions={actions} />
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}
