import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"

/** shadcn Button, restyled to the One Dark button spec (primary/secondary/danger/ghost). */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[12.5px] font-semibold transition-[color,background-color,border-color,scale] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-blue text-editor hover:bg-blue/90",
        secondary: "border border-line text-text hover:bg-surface",
        danger: "border border-red/40 text-red hover:bg-red/10",
        ghost: "font-normal text-muted-foreground hover:text-text"
      },
      size: {
        sm: "px-2 py-1 text-[11.5px]",
        md: "px-[13px] py-1.5",
        icon: "size-7 p-0"
      }
    },
    defaultVariants: { variant: "primary", size: "md" }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp ref={ref} data-slot="button" className={cn(button({ variant, size }), className)} {...props} />
  }
)
Button.displayName = "Button"

export { button as buttonVariants }
