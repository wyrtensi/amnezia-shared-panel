"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type CardOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  hint?: string;
};

/**
 * A grid of large, rounded, selectable cards used for single-choice inputs
 * (device type, protocol, routing profile).
 */
export function OptionCards<T extends string>({
  options,
  value,
  onChange,
  columns = 2,
  ariaLabel,
}: {
  options: Array<CardOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  columns?: 2 | 3;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "grid gap-2.5",
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.disabled ? option.hint : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "group relative flex flex-col gap-1 rounded-xl border p-3.5 text-left transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55 disabled:active:scale-100",
              selected
                ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
                : "border-border bg-card hover:border-primary/40 hover:bg-accent/40",
            )}
          >
            <span
              className={cn(
                "pointer-events-none absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full border transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-transparent",
              )}
            >
              <Check className="h-3 w-3" />
            </span>
            <div className="flex min-w-0 items-center gap-2.5">
              {option.icon ? (
                <span
                  className={cn(
                    // The glyph carries the recognition here (the platform marks), so it gets
                    // most of the tile: 24px inside 40px leaves an 8px ring, which is
                    // the largest the mark can go before it crowds the rounded corners.
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-6",
                    selected
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {option.icon}
                </span>
              ) : null}
              <span className="flex min-w-0 flex-col">
                {/* `pr-3` is the tick's own footprint, not a round number: the
                    tick above is `right-2 w-4`, so its left edge sits 24px from
                    the card's border while the content box ends 15px from it
                    (`p-3.5` plus the 1px border) — a 9px overlap, cleared by
                    12px with 3px to spare. The `pr-5` this replaces reserved
                    more than twice that, and the 8px it wasted were the
                    difference between "MacBook" (69px) fitting the 3-up device
                    column and not: with 68.7px of usable width the word
                    overflowed its line, and `break-words` then split it —
                    Chrome breaks at the overflow point instead of backtracking
                    to the preceding space, which is how "Windows PC" came out
                    as "Window / s PC".

                    The label keeps `break-words` deliberately: it is the last
                    resort for a word genuinely wider than its column (the
                    longest Russian route-profile label still is, in a 3-up grid
                    inside a 576px dialog), not what decides ordinary wrapping. */}
                <span className="break-words pr-3 font-medium leading-tight">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </div>
            {option.disabled && option.hint ? (
              <span className="text-xs text-muted-foreground">
                {option.hint}
              </span>
            ) : null}
            {/* Anchored to the card's bottom edge (mt-auto in this flex-col
                button) rather than sitting beside the title, so a badge on
                one card no longer narrows that card's title column and
                throws off the row's alignment. */}
            {option.badge ? (
              <span className="mt-auto pt-1">{option.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
