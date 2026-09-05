"use client";

import type * as React from "react";

/**
 * The caption above a block inside a node card.
 *
 * One shape for every block — same icon size, same weight, same colour — on the
 * nodes page and on the overview, so a card reads as a stack of comparable
 * sections and the two pages read as one product. Before this, each block had
 * invented its own heading: an icon here, none there, three different sizes.
 *
 * `action` is the control or figure that belongs to the section (the capacity
 * count, the checks master switch, a failure tally), kept on the caption line
 * rather than costing a row of its own.
 */
export function NodeCardSection({
  icon: Icon,
  children,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-5 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{children}</span>
      </span>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
