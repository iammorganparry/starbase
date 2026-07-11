import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "../lib/cn.js"

/** shadcn/Radix Switch restyled to the One Dark toggle (34×19, blue when on). */
export const Toggle = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-[19px] w-[34px] shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-blue data-[state=unchecked]:bg-line",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-[15px] rounded-full transition-transform",
        "data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0",
        "data-[state=checked]:bg-editor data-[state=unchecked]:bg-muted-foreground"
      )}
    />
  </SwitchPrimitive.Root>
))
Toggle.displayName = "Toggle"
