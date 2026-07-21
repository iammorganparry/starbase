import type * as React from "react"
import * as Tooltip from "@radix-ui/react-tooltip"
import { cn } from "../lib/cn.js"

/**
 * A detail popover that opens on hover INTENT and on keyboard focus.
 *
 * Built on Radix's tooltip rather than a hand-rolled absolute-positioned card,
 * for five things that all matter at the left edge of the window:
 *
 * - **Collision handling.** The rail hugs the viewport's left edge and its cells
 *   run to the bottom, so a card opening `right` still has to flip and clamp
 *   vertically or it hangs off screen.
 * - **Portalling.** The rail's session list is an `overflow-y-auto` scroller —
 *   an in-flow card would be clipped by it at 52px wide.
 * - **Delay.** Opening on the first pixel of contact fires every time the
 *   pointer merely crosses the rail on its way elsewhere.
 * - **Focus.** Tab-navigating the rail gets the same detail the pointer does.
 * - **Escape.** Dismissal without moving the pointer.
 *
 * Each card mounts its OWN provider. A single app-level provider would be
 * tidier, but it would also mean this component could not be dropped into a
 * story, a test, or a subtree that doesn't have one — and the only cost of the
 * local provider is a context object per trigger.
 */
export function HoverCard({
  content,
  children,
  delayMs = 150,
  side = "right",
  className
}: {
  /** What the card shows. Rendered lazily by Radix — absent from the DOM while closed. */
  content: React.ReactNode
  /** The trigger. Must forward a ref and spread props (`asChild` clones onto it). */
  children: React.ReactNode
  /** How long the pointer must rest before the card opens. */
  delayMs?: number
  side?: "right" | "left" | "top" | "bottom"
  className?: string
}) {
  return (
    // `skipDelayDuration` lets the SECOND card in a run open immediately: once
    // you're reading the rail, sliding down it should feel like scrubbing, not
    // like waiting 150ms per session.
    <Tooltip.Provider delayDuration={delayMs} skipDelayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            sideOffset={8}
            collisionPadding={8}
            data-testid="hover-card"
            className={cn(
              // No enter/exit animation: `tailwindcss-animate` isn't in this
              // build, and a card that fades while the pointer is already moving
              // to the next cell reads as lag rather than as polish.
              "z-50 rounded-lg border border-hairline bg-panel p-2.5 shadow-2xl",
              className
            )}
          >
            {content}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
