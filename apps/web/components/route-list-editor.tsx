"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/provider";

export type RouteEntryKind = "cidr" | "domain";

// Light client-side checks; the control API is authoritative on save.
export const looksLikeCidr = (value: string): boolean =>
  /^[0-9a-f.:]+(\/\d{1,3})?$/i.test(value) && /[.:]/.test(value);

export const looksLikeDomain = (value: string): boolean =>
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(
    value,
  );

const KIND_TEXT: Record<
  RouteEntryKind,
  { label: string; placeholder: string; invalid: string }
> = {
  cidr: {
    label: "routes.ipLabel",
    placeholder: "routes.ipPlaceholder",
    invalid: "routes.badIp",
  },
  domain: {
    label: "routes.domainLabel",
    placeholder: "routes.domainPlaceholder",
    invalid: "routes.badDomain",
  },
};

/**
 * Chip-list editor for one list of routes: type an entry, press Enter (or the
 * plus button) to add it, click a chip's cross to drop it. Shared by the
 * self-service card and the admin global-routes page so both sides validate and
 * normalise entries the same way.
 */
export function RouteListEditor({
  kind,
  entries,
  onChange,
  label,
  disabled = false,
}: {
  kind: RouteEntryKind;
  entries: string[];
  onChange: (next: string[]) => void;
  /** Overrides the default per-kind heading. */
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [value, setValue] = React.useState("");
  const text = KIND_TEXT[kind];

  const add = () => {
    const entry = value.trim().toLowerCase();
    if (!entry) return;
    const valid = kind === "cidr" ? looksLikeCidr(entry) : looksLikeDomain(entry);
    if (!valid) {
      toast.error(t(text.invalid));
      return;
    }
    setValue("");
    if (entries.includes(entry)) return;
    onChange([...entries, entry]);
  };

  const remove = (entry: string) =>
    onChange(entries.filter((item) => item !== entry));

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {label ?? t(text.label)}
      </p>
      <div className="flex gap-2">
        <Input
          value={value}
          disabled={disabled}
          placeholder={t(text.placeholder)}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled}
          aria-label={t("common.add")}
          onClick={add}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {entries.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
            >
              {entry}
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(entry)}
                className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                aria-label={t("routes.removeAria", { value: entry })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
