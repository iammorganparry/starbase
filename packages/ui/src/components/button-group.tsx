import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../lib/cn.js"

/** shadcn ButtonGroup, adapted to Starbase's owned Button primitive and tokens. */
const buttonGroupVariants = cva(
  "flex w-fit items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 has-[>[data-slot=button-group]]:gap-2",
  {
    variants: {
      orientation: {
        horizontal:
          "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none",
        vertical:
          "flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none"
      }
    },
    defaultVariants: { orientation: "horizontal" }
  }
)

export function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  )
}

export { buttonGroupVariants }
