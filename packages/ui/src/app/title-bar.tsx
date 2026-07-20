import type { CSSProperties, ReactNode } from "react"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/** macOS-style window title bar with traffic lights and a centered title. */
export function TitleBar({
  title = "Starbase",
  actions
}: {
  title?: string
  /**
   * Controls pinned to the right edge. Marked `no-drag`, or a click on one would
   * be swallowed by the window's drag region instead of reaching the button.
   */
  actions?: ReactNode
}) {
  return (
    <div
      style={drag}
      className="relative flex h-[38px] flex-none items-center gap-3.5 border-b border-hairline bg-panel px-3.5"
    >
      {/*
        The title is absolutely centred rather than flexed between the two side
        blocks. Those blocks are different widths — traffic lights on the left,
        a five-button layout picker on the right — so a `flex-1` title would sit
        visibly off-centre in the only configuration the app actually renders.
      */}
      <div className="pointer-events-none absolute inset-x-0 text-center text-[12px] text-dim">
        {title}
      </div>
      <div style={noDrag} className="relative flex gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex-1" />
      <div style={noDrag} className="relative flex justify-end">
        {actions}
      </div>
    </div>
  )
}
