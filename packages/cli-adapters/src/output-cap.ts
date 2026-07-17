/**
 * Capping a tool's output, shared by every harness adapter.
 *
 * A tool's output rides the RPC to the renderer AND is persisted into the
 * session's transcript.json, so an uncapped `pnpm test` log would bloat the file
 * that every future read pays for. Live `ToolDelta` snapshots are capped the same
 * way, since a running command's aggregated output grows without bound.
 */
export const OUTPUT_CAP = 6_000
/** Kept from the front when capping — enough to see what the command started doing. */
export const OUTPUT_HEAD = 3_600

/**
 * Cap a tool's output, keeping BOTH ends.
 *
 * Which end matters depends on the command: a compile error lists its first
 * failures at the top, while a test run puts the summary that explains it at the
 * very bottom. Keeping only one end reliably hides the answer for half of them,
 * so we keep the head and the tail and say what went missing — a silent cut
 * reads as "that's all it printed".
 */
export const capOutput = (text: string): string => {
  if (text.length <= OUTPUT_CAP) return text
  const head = text.slice(0, OUTPUT_HEAD)
  const tail = text.slice(text.length - (OUTPUT_CAP - OUTPUT_HEAD))
  const dropped = text.length - OUTPUT_HEAD - (OUTPUT_CAP - OUTPUT_HEAD)
  return `${head}\n\n… ${dropped.toLocaleString()} characters omitted …\n\n${tail}`
}
