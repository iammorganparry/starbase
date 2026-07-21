import { type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "../lib/cn.js"
import { useContainerWidth } from "../hooks/use-container-width.js"
import { FAST, INSTANT, paneVariants, SPRING } from "../lib/motion.js"
import { maxPanesForWidth, type Pane, type SplitGroup, SESSION_DND_MIME } from "./split-layout.js"

/**
 * Where a dragged session would land relative to the pane it's hovering.
 *
 * Arc's three zones, and the names are the semantics: the outer eighths of a
 * pane INSERT a new pane on that side, the middle REPLACES what's there. Edge
 * zones are deliberately narrow — replacing is the commoner intent, and a wide
 * edge zone means every casual drop splits when you meant to swap.
 */
export type DropZone = "before" | "after" | "replace"

/** Fraction of a pane's width that counts as its insert edge. */
const EDGE_FRACTION = 0.125

const zoneAt = (e: DragEvent<HTMLElement>): DropZone => {
  const box = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - box.left) / (box.width || 1)
  if (x < EDGE_FRACTION) return "before"
  if (x > 1 - EDGE_FRACTION) return "after"
  return "replace"
}

/**
 * Whether a drag carries one of our session rows.
 *
 * Checks `types`, not the value: during `dragover` the spec blanks `getData` (so
 * a page can't snoop on what's being dragged over it), and only `types` is
 * readable. Getting this wrong means either accepting file drops or rejecting
 * every session drop.
 */
const carriesSession = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(SESSION_DND_MIME)

export interface SplitViewProps {
  /** The split on screen. `null` renders the empty state. */
  group: SplitGroup | null
  /**
   * One pane's contents. A prop rather than a hard dependency on `SessionPane`
   * so this component stays mountable in Storybook with cheap placeholders —
   * the whole point of approving the split's feel before wiring it to the app.
   */
  renderPane: (pane: Pane, index: number) => ReactNode
  /** Move the focus ring (and, downstream, singleton ownership) to a pane. */
  onFocusPane?: (index: number) => void
  /** A session was dropped. `at` is the pane index it should occupy. */
  onSplitWith?: (sessionId: string, at: number) => void
  /** A session was dropped onto a pane's middle — swap that pane's session. */
  onReplacePane?: (index: number, sessionId: string) => void
  /**
   * Drag on the divider after pane `index`, as a fraction of the row's width.
   * Deltas arrive continuously during the drag, not once at the end.
   */
  onResize?: (index: number, delta: number) => void
  /** Shown when there is no group at all — first launch, or everything closed. */
  emptyState?: ReactNode
}

/**
 * The split — one animated pane per session in the active group.
 *
 * A flex row of `flexGrow`-weighted children rather than a CSS grid: the panes
 * trade width continuously as a divider is dragged, and `flexGrow` is the one
 * property where "these three share the row in this proportion" is a single
 * number per child that the browser resolves in one pass.
 *
 * Panes are keyed by SESSION ID, not by index. That's what lets a pane keep its
 * subtree — and so its transcript scroll position and virtualizer measurements —
 * when a pane to its left closes and every index shifts. It is also what makes
 * `motion`'s layout animation able to slide the survivor rather than cross-fade
 * a remount.
 */
export function SplitView({
  group,
  renderPane,
  onFocusPane,
  onSplitWith,
  onReplacePane,
  onResize,
  emptyState
}: SplitViewProps) {
  // Which pane is under the pointer mid-drag, and where it would land. Tracked
  // as one value rather than a per-pane boolean so exactly one indicator shows:
  // `dragleave` fires when crossing into a CHILD element too, so a per-pane flag
  // would flicker as the cursor moves over the transcript.
  const [dropAt, setDropAt] = useState<{ index: number; zone: DropZone } | null>(null)
  // A divider being dragged. While this is set, layout animation is suspended —
  // a spring chasing the pointer lags behind it, which feels like the divider
  // is stuck to elastic rather than to the cursor.
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null)
  // Doubles as the divider drag's reference box and as the source of the
  // width-derived pane cap below — one measurement, two uses.
  const [rowRef, rowWidth] = useContainerWidth<HTMLDivElement>()

  const paneIds = group?.panes.map((p) => p.sessionId) ?? []
  const presence = useRef<{ ids: ReadonlyArray<string>; token: number }>({ ids: paneIds, token: 0 })
  /**
   * Is this update an EDIT of the split on screen, or a SWITCH to a different
   * one?
   *
   * An edit shares at least one session with what was here a moment ago — a pane
   * was added, closed, reordered or resized, and the panes that stayed should
   * visibly move to their new places. A switch shares none: the operator clicked
   * a different session (or a different group) in the sidebar, and nothing on
   * screen survives it.
   *
   * They were the same code path, so a plain chat switch played the split's
   * whole choreography — the outgoing pane collapsing to a sliver while the
   * incoming one grew out of one — which reads as a split being dismantled and
   * rebuilt rather than as navigation.
   */
  const switched =
    presence.current.ids.length > 0 &&
    paneIds.length > 0 &&
    paneIds.every((id) => !presence.current.ids.includes(id))
  const presenceKey = switched ? presence.current.token + 1 : presence.current.token
  // Derived-from-props state, written during render on purpose: the key has to
  // be right in THIS commit (a switch is only visible in the frame it happens),
  // so it can't wait for an effect. The write is idempotent — recomputing from
  // the new ids yields the same token — which is what makes React's development
  // double-render harmless here.
  if (
    presence.current.ids.length !== paneIds.length ||
    paneIds.some((id, i) => presence.current.ids[i] !== id)
  ) {
    presence.current = { ids: paneIds, token: presenceKey }
  }

  // A drag can end without any pane seeing `dragleave` — dropped outside the
  // window, cancelled with Escape, or aborted when the window loses focus —
  // which would leave the indicator painted until the next drag. `dragend` fires
  // on the source for all of those, so listen for it globally while one is lit.
  useEffect(() => {
    if (dropAt === null) return
    const clear = () => setDropAt(null)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [dropAt])

  /**
   * Divider drags run on POINTER capture rather than HTML5 drag-and-drop.
   *
   * Native drag events fire coarsely (and suppress the cursor), which is fine
   * for "drop this session there" and useless for a continuous resize. Pointer
   * capture also means the drag survives the pointer crossing into an iframe or
   * a terminal canvas, which a mousemove listener on the row would not.
   */
  const startDividerDrag = useCallback(
    (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      e.preventDefault()
      const rowWidth = rowRef.current?.getBoundingClientRect().width ?? 0
      if (rowWidth === 0) return
      let last = e.clientX
      setDraggingDivider(index)
      const move = (ev: PointerEvent) => {
        // Deltas are sent as a FRACTION of the row, because the model stores
        // ratios — converting in the component keeps the reducer free of pixels
        // and so free of the DOM.
        const delta = (ev.clientX - last) / rowWidth
        last = ev.clientX
        if (delta !== 0) onResize(index, delta)
      }
      const end = () => {
        setDraggingDivider(null)
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", end)
        window.removeEventListener("pointercancel", end)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", end)
      window.addEventListener("pointercancel", end)
    },
    [onResize]
  )

  if (group === null) {
    return (
      <div data-testid="split-view" className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-editor">
        {emptyState}
      </div>
    )
  }

  const single = group.panes.length === 1
  // The cap is the row's, not the model's: four panes are legible at 1400px and
  // illegible at 900px, and the operator gets told which by the indicator
  // turning red rather than by dropping a session into a pane they can't read.
  const full = group.panes.length >= maxPanesForWidth(rowWidth)

  const handleDrop = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!carriesSession(e)) return
    e.preventDefault()
    const zone = zoneAt(e)
    setDropAt(null)
    const sessionId = e.dataTransfer.getData(SESSION_DND_MIME)
    if (!sessionId) return
    // A REPLACE is always allowed — it doesn't change the pane count, so it
    // can't make the row narrower than it already is. Only an INSERT is refused,
    // and it's refused here rather than in the reducer so the same drop still
    // works the moment the window is widened.
    if (zone === "replace") onReplacePane?.(index, sessionId)
    else if (!full) onSplitWith?.(sessionId, zone === "before" ? index : index + 1)
  }

  return (
    <div
      ref={rowRef}
      data-testid="split-view"
      data-panes={group.panes.length}
      className="flex min-h-0 min-w-0 flex-1 bg-hairline"
    >
      {/*
        Keyed by the switch token, so a switch REMOUNTS the presence tree: the
        panes that were here go in the same frame, with no exit animation to
        play (motion can only run one from props the leaving element already
        had, which is why this is a key rather than a different `exit` variant).
        `initial` follows suit — normally false, so a pane already on screen when
        the split mounts doesn't animate in, but true on a switch, which is what
        lets the arriving panes fade.
      */}
      <AnimatePresence key={presenceKey} initial={switched} mode="popLayout">
        {group.panes.map((pane, index) => {
          const isFocused = index === group.focused
          const drop = dropAt?.index === index ? dropAt.zone : null
          return (
            <motion.div
              key={pane.sessionId}
              // `layout` moves a pane when its NEIGHBOURS change size or count.
              // Suspended mid-divider-drag: there, the width already tracks the
              // pointer exactly, and a spring on top of it only adds lag.
              layout={draggingDivider === null}
              custom={pane.ratio}
              variants={paneVariants}
              // A pane inserted into the split you're looking at grows out of a
              // sliver and pushes its neighbours aside, because that IS what
              // happened. A pane that arrives by a switch starts at its final
              // width and only fades — nothing was inserted.
              initial={switched ? "swap" : "hidden"}
              animate="visible"
              exit="exit"
              // The other half of suspending `layout` below. `visible` is a
              // function of the ratio, so a divider drag re-resolves it on every
              // pointer-move — with a spring, each of those starts a new ~260ms
              // animation toward the new width, and the pane trails the cursor
              // exactly as if `layout` had never been suspended. Mid-drag the
              // pointer IS the animation, so the width is written on the frame
              // it changes.
              // Mid-drag the pointer is the animation (INSTANT). A switch is a
              // 140ms fade at full width (FAST) — the width is already right, so
              // a spring would have nothing to travel but the opacity. Everything
              // else springs.
              transition={draggingDivider !== null ? INSTANT : switched ? FAST : SPRING}
              // `order` interleaves the panes with the dividers, which are
              // rendered as a separate run below (see the note there).
              style={{ flexGrow: pane.ratio, flexBasis: 0, order: index * 2 }}
              data-testid={`split-pane-${index}`}
              data-session={pane.sessionId}
              data-focused={isFocused || undefined}
              // Focus follows a mousedown anywhere in the pane, captured so a
              // click on a control inside still registers the pane as focused
              // first.
              onMouseDownCapture={() => onFocusPane?.(index)}
              onFocusCapture={() => onFocusPane?.(index)}
              onDragOver={(e) => {
                if (!onSplitWith && !onReplacePane) return
                if (!carriesSession(e)) return
                // Calling preventDefault is what MARKS this element as a valid
                // drop target — without it the browser refuses the drop entirely.
                e.preventDefault()
                e.dataTransfer.dropEffect = "move"
                const zone = zoneAt(e)
                setDropAt((current) =>
                  current?.index === index && current.zone === zone ? current : { index, zone }
                )
              }}
              onDragLeave={(e) => {
                // Ignore leaves into a descendant — only a real exit clears the
                // indicator, or it would strobe as the cursor crosses the pane.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDropAt((current) => (current?.index === index ? null : current))
              }}
              onDrop={handleDrop(index)}
              className={cn(
                "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-editor",
                // The focus ring is noise when there's only one pane — with
                // nothing to disambiguate it would just be a permanent border.
                !single && isFocused && "ring-1 ring-inset ring-blue/40",
                // A replace-drop outranks the focus ring: mid-drag, what will
                // happen matters more than where focus happens to be.
                drop === "replace" && "ring-2 ring-inset ring-blue"
              )}
            >
              {renderPane(pane, index)}
              {/* The insert indicator is a bar on the edge the pane would appear
                  on — a whole-pane ring would say "replace", which is the other
                  gesture entirely. */}
              {(drop === "before" || drop === "after") && (
                <motion.span
                  layoutId="split-insert-indicator"
                  transition={SPRING}
                  data-testid={`split-insert-${drop}-${index}`}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 w-1 bg-blue",
                    drop === "before" ? "left-0" : "right-0",
                    // At the cap there is nowhere to insert, so the indicator
                    // says so rather than promising a pane that won't appear.
                    full && "bg-red/70"
                  )}
                />
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>

      {/* Dividers are siblings of the panes, not children, so a drag on one is
          never intercepted by the pane's own drop handling. They're rendered as
          a second run and woven back between the panes with flex `order`
          (pane N gets `2N`, the divider after it `2N+1`) — rendering them
          interleaved would put each divider inside a pane's drop target. */}
      {onResize &&
        group.panes.slice(0, -1).map((pane, index) => (
          <Divider
            key={`divider-${pane.sessionId}`}
            index={index}
            active={draggingDivider === index}
            onPointerDown={startDividerDrag(index)}
          />
        ))}

      {/*
        There was a ghost "Add right split" panel here — Arc's, a 40px strip
        pinned to the right edge of every split. It has been removed: it was on
        screen permanently to serve an occasional act, and the two gestures that
        actually express "put that session beside this one" both say WHICH
        session while they do it. ⌃⇧= and a drag from the sidebar are those
        gestures; the panel could only ever guess (`addNextSessionAsPane`).
      */}
    </div>
  )
}

/**
 * The drag handle between two panes.
 *
 * One pixel of visible hairline, eight pixels of hit area. A divider you have to
 * aim at is a divider you avoid using; the negative margins let the target
 * overhang its neighbours without taking a pixel of layout from them.
 */
function Divider({
  index,
  active,
  onPointerDown
}: {
  index: number
  active: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize pane ${index + 1}`}
      data-testid={`split-divider-${index}`}
      data-active={active || undefined}
      onPointerDown={onPointerDown}
      // `-order` places each divider immediately after its pane: flex `order`
      // is the only way to interleave siblings that are rendered as two separate
      // runs, and rendering them interleaved would nest the divider inside the
      // pane's drop target.
      style={{ order: index * 2 + 1 }}
      className={cn(
        // The hairline is ALWAYS drawn, not just on hover: two transcripts flush
        // against each other read as one wrapped column. It doubles as the
        // affordance — the line you can see is the line you can grab.
        "relative z-10 -mx-1 w-2 flex-none cursor-col-resize touch-none",
        "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
        active ? "after:bg-blue" : "after:bg-hairline hover:after:bg-blue/50"
      )}
    />
  )
}
