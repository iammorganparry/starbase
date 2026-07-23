import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * shadcn Select (Radix) restyled to the One Dark form control — a sunken trigger
 * with a `panel` popover of items. Controlled via `value` / `onValueChange`.
 */
export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line bg-sunken px-2.5 py-[7px] text-[12.5px] text-text outline-none transition-colors focus:border-blue/50 focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-dim [&>span]:truncate",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown size={14} className="flex-none text-muted-foreground" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        "relative z-50 max-h-64 min-w-[8rem] overflow-hidden rounded-lg border border-line bg-panel shadow-[0_16px_48px_var(--sb-shadow-strong)]",
        position === "popper" &&
          "w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
        className
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /** Optional trailing adornment (e.g. a star toggle); shifts the check left. */
    trailing?: React.ReactNode
  }
>(({ className, children, trailing, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-2.5 text-[12.5px] text-text outline-none data-[highlighted]:bg-surface data-[state=checked]:text-blue data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      trailing ? "pr-12" : "pr-7",
      className
    )}
    {...props}
  >
    <span
      className={cn("absolute flex items-center justify-center", trailing ? "right-7" : "right-2")}
    >
      <SelectPrimitive.ItemIndicator>
        <Check size={13} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.4px] text-dim", className)}
    {...props}
  />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName
