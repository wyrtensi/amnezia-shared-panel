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
                "absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-transparent",
              )}
            >
              <Check className="h-3.5 w-3.5" />
            </span>
            <div className="flex min-w-0 items-center gap-2.5">
              {option.icon ? (
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5",
                    selected
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {option.icon}
                </span>
              ) : null}
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 pr-7 font-medium leading-tight">
                  <span className="truncate">{option.label}</span>
                  {option.badge}
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
          </button>
        );
      })}
    </div>
  );
}
