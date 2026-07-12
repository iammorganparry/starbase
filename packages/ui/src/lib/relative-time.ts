const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Format an ISO timestamp as a compact relative "just now" / "2h ago" / "3d ago". */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const elapsed = Math.max(0, Date.now() - then)
  if (elapsed < MS_PER_MINUTE) return "just now"
  if (elapsed < MS_PER_HOUR) return `${Math.floor(elapsed / MS_PER_MINUTE)}m ago`
  if (elapsed < MS_PER_DAY) return `${Math.floor(elapsed / MS_PER_HOUR)}h ago`
  return `${Math.floor(elapsed / MS_PER_DAY)}d ago`
}
