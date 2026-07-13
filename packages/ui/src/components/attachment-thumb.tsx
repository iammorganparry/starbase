import type { Attachment } from "@starbase/core"
import { X } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * A thumbnail for an attached image: the image (object-cover) with its filename
 * overlaid along the bottom. Pass `onRemove` to show the ✕ affordance (the
 * composer's pending attachments); omit it for a read-only transcript thumbnail.
 * Dimensions come from `className` so the same atom serves the 58px composer tile
 * and the wider transcript thumbnail.
 */
export function AttachmentThumb({
  attachment,
  onRemove,
  className
}: {
  attachment: Attachment
  onRemove?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex-none overflow-hidden rounded-md border border-line bg-canvas",
        className
      )}
    >
      <img
        src={`data:${attachment.mediaType};base64,${attachment.data}`}
        alt={attachment.name}
        className="size-full object-cover"
      />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove image"
          className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full border border-line bg-canvas/85 text-text-body outline-none transition-colors hover:bg-canvas focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={10} />
        </button>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-canvas/80 px-1.5 py-px font-mono text-[8.5px] text-muted-foreground">
        {attachment.name}
      </span>
    </div>
  )
}
