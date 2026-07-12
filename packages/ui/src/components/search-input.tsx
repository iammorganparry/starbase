import * as React from "react"
import { Search, X } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * A reusable search / filter input — a leading magnifier, a controlled value, and
 * either a trailing clear (✕) once there's text or an optional `kbd` hint while
 * empty. Used for the session filter, the PR picker search, etc. Forwards its ref
 * so callers can focus it from a shortcut.
 */
export const SearchInput = React.forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    /** Hint shown on the right while the field is empty (e.g. a `⌘K` Kbd). */
    kbd?: React.ReactNode
    autoFocus?: boolean
    className?: string
    "aria-label"?: string
  }
>(({ value, onChange, placeholder = "Search…", kbd, autoFocus, className, "aria-label": ariaLabel }, ref) => (
  <div
    className={cn(
      "flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-[7px] text-[12.5px] text-dim focus-within:border-line-strong",
      className
    )}
  >
    <Search size={13} className="flex-none" />
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel ?? placeholder}
      className="min-w-0 flex-1 bg-transparent text-text-body outline-none placeholder:text-dim"
    />
    {value ? (
      <button
        type="button"
        onClick={() => onChange("")}
        aria-label="Clear"
        className="flex-none text-dim transition-colors hover:text-text"
      >
        <X size={13} />
      </button>
    ) : (
      kbd
    )}
  </div>
))
SearchInput.displayName = "SearchInput"
