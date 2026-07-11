import { FileCode2, FileJson, FileText, FileType } from "lucide-react"
import { cn } from "../lib/cn.js"

/** Extension → icon + One Dark accent colour, so file references read at a glance. */
const ICONS: Record<string, { Icon: typeof FileCode2; color: string }> = {
  ts: { Icon: FileType, color: "text-cyan" },
  tsx: { Icon: FileType, color: "text-cyan" },
  js: { Icon: FileCode2, color: "text-yellow" },
  jsx: { Icon: FileCode2, color: "text-yellow" },
  mjs: { Icon: FileCode2, color: "text-yellow" },
  json: { Icon: FileJson, color: "text-yellow" },
  md: { Icon: FileText, color: "text-blue" },
  css: { Icon: FileCode2, color: "text-purple" },
  html: { Icon: FileCode2, color: "text-orange" }
}

const DEFAULT = { Icon: FileText, color: "text-dim" } as const

/** A small file-type glyph derived from a path's extension. */
export function FileIcon({
  path,
  size = 13,
  className
}: {
  path: string | null | undefined
  size?: number
  className?: string
}) {
  const ext = path?.split(".").pop()?.toLowerCase() ?? ""
  const { Icon, color } = ICONS[ext] ?? DEFAULT
  return <Icon size={size} className={cn("shrink-0", color, className)} aria-hidden />
}
