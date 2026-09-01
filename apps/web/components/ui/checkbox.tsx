"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Checkbox built on a native input: the app ships no checkbox primitive from
 * Radix, and adding one is not worth a dependency for a plain boolean control.
 * The real input stays in the DOM (keyboard, form semantics, screen readers)
 * and is painted by the sibling check mark once it is checked.
 */
const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        "peer size-4 cursor-pointer appearance-none rounded-[4px] border border-input bg-transparent shadow-sm transition-colors checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
    <Check
      aria-hidden
      strokeWidth={3}
      className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
    />
  </span>
));
Checkbox.displayName = "Checkbox";

export { Checkbox };
