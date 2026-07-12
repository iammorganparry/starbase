import { useState } from "react"
import { cn } from "../lib/cn.js"

const toneBg: Record<string, string> = {
  blue: "bg-blue",
  orange: "bg-orange",
  dim: "bg-dim",
  green: "bg-green",
  purple: "bg-purple"
}

/** A GitHub avatar image URL derived from a login (redirects to the real avatar). */
export const githubAvatarUrl = (login: string, size = 48): string =>
  `https://github.com/${encodeURIComponent(login)}.png?size=${size}`

/**
 * A monogram avatar — colored circle with a dark initial. When `src` is given it
 * renders that image instead (e.g. a GitHub avatar), falling back to the monogram
 * if the image fails to load.
 */
export function Avatar({
  initial,
  src,
  tone = "blue",
  size = 26,
  className
}: {
  initial: string
  /** Optional image URL; falls back to the monogram on error. */
  src?: string | null
  tone?: keyof typeof toneBg
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={initial}
        onError={() => setFailed(true)}
        className={cn("inline-block flex-none rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full font-bold text-editor",
        toneBg[tone],
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initial}
    </span>
  )
}
