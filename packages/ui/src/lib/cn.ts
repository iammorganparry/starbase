import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** shadcn's class combiner: merges conditional classes and de-dupes Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
