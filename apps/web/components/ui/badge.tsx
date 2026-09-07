import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // The shadow lives on the variants, not here: a filled badge reads as a chip
  // lifted off the card, an outline one as a recess cut into it, and those are
  // opposite shadows.
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/10 text-primary shadow-[var(--chip-shadow)]",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground shadow-[var(--chip-shadow)]",
        success:
          "border-transparent bg-success/15 text-success shadow-[var(--chip-shadow)]",
        // `-foreground` is the colour for a SOLID warning fill. On the 20%
        // wash it works in light, where the token is near-black, and fails in
        // dark, where it is also near-black and the wash is dim - the text
        // came out all but invisible. Its siblings (success, destructive) use
        // the accent itself for exactly this reason; warning could not,
        // because the accent is too light against a pale wash. So: one per
        // theme.
        warning:
          "border-transparent bg-warning/20 text-warning-foreground shadow-[var(--chip-shadow)] dark:text-warning",
        destructive:
          "border-transparent bg-destructive/15 text-destructive shadow-[var(--chip-shadow)]",
        outline: "bg-well text-foreground shadow-[var(--inset-shadow)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
