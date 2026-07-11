import type { CSSProperties } from "react"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/** macOS-style window title bar with traffic lights and a centered title. */
export function TitleBar({ title = "Starbase" }: { title?: string }) {
  return (
    <div
      style={drag}
      className="flex h-[38px] flex-none items-center gap-3.5 border-b border-hairline bg-panel px-3.5"
    >
      <div style={noDrag} className="flex gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex-1 text-center text-[12px] text-dim">{title}</div>
      <div className="w-[52px]" />
    </div>
  )
}
