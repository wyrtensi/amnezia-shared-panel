import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        success: "border-transparent bg-success/15 text-success",
        // `-foreground` is the colour for a SOLID warning fill. On the 20%
        // wash it works in light, where the token is near-black, and fails in
        // dark, where it is also near-black and the wash is dim - the text
        // came out all but invisible. Its siblings (success, destructive) use
        // the accent itself for exactly this reason; warning could not,
        // because the accent is too light against a pale wash. So: one per
        // theme.
        warning:
          "border-transparent bg-warning/20 text-warning-foreground dark:text-warning",
        destructive:
          "border-transparent bg-destructive/15 text-destructive",
        outline: "text-foreground",
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
