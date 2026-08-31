"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Small "(i)" hint next to a label. Keeps forms compact while still
 * offering a one-tap explanation of what a control does.
 */
export function Hint({
  children,
  className,
  side = "top",
}: {
  children: React.ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const { t } = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("hint.aria")}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-64 text-pretty">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/** Muted helper line rendered under a field. */
export function FieldHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-xs leading-snug text-muted-foreground", className)}>
      {children}
    </p>
  );
}

const CALLOUT_TONES = {
  info: "border-chart-4/40 bg-chart-4/10 text-foreground",
  warning: "border-warning/45 bg-warning/12 text-foreground",
  success: "border-success/45 bg-success/12 text-foreground",
  danger: "border-destructive/45 bg-destructive/10 text-foreground",
} as const;

/** Full-width inline notice with an icon slot — used for the rules banner. */
export function Callout({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof CALLOUT_TONES;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
        CALLOUT_TONES[tone],
        className,
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium leading-tight">{title}</p> : null}
        {children ? (
          <div className="text-xs leading-snug text-muted-foreground">
            {children}
          </div>
        ) : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
