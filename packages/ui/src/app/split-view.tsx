import { type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Plus } from "lucide-react"
import { cn } from "../lib/cn.js"
import { paneVariants, SPRING } from "../lib/motion.js"
import { MAX_PANES, type Pane, type SplitGroup, SESSION_DND_MIME } from "./split-layout.js"

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
  /** The operator asked for another pane (placeholder or ⌃⇧=). */
  onAddSplit?: () => void
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
  onAddSplit,
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
  const rowRef = useRef<HTMLDivElement>(null)

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
  const full = group.panes.length >= MAX_PANES

  const handleDrop = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!carriesSession(e)) return
    e.preventDefault()
    const zone = zoneAt(e)
    setDropAt(null)
    const sessionId = e.dataTransfer.getData(SESSION_DND_MIME)
    if (!sessionId) return
    if (zone === "replace") onReplacePane?.(index, sessionId)
    else onSplitWith?.(sessionId, zone === "before" ? index : index + 1)
  }

  return (
    <div
      ref={rowRef}
      data-testid="split-view"
      data-panes={group.panes.length}
      className="flex min-h-0 min-w-0 flex-1 bg-hairline"
    >
      <AnimatePresence initial={false} mode="popLayout">
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
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={SPRING}
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

      {/* Arc's "Add right split" — a ghost panel on the right edge. Hidden at the
          cap, where clicking it could only fail. */}
      {onAddSplit && !full && (
        <motion.button
          layout
          type="button"
          transition={SPRING}
          onClick={onAddSplit}
          // Always last in the row, whatever the pane count.
          style={{ order: MAX_PANES * 2 }}
          data-testid="add-right-split"
          title="Add right split (⌃⇧=)"
          className="group flex w-10 flex-none flex-col items-center justify-center gap-2 border-l border-hairline bg-editor text-dim outline-none transition-colors hover:w-32 hover:bg-panel hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-6 items-center justify-center rounded border border-dashed border-line-strong group-hover:border-blue">
            <Plus className="size-3.5" />
          </span>
          <span className="hidden whitespace-nowrap text-[11px] group-hover:block">Add right split</span>
        </motion.button>
      )}
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
