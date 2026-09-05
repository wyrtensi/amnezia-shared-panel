"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/provider";

// Light client-side check; the control API is authoritative on save.
export const looksLikeCidr = (value: string): boolean =>
  /^[0-9a-f.:]+(\/\d{1,3})?$/i.test(value) && /[.:]/.test(value);

/**
 * Chip-list editor for one list of route addresses: type an entry, press Enter
 * (or the plus button) to add it, click a chip's cross to drop it. Shared by
 * the self-service card and the admin global-routes page so both sides validate
 * and normalise entries the same way.
 *
 * Addresses only. A route profile ends up as a WireGuard AllowedIPs list, which
 * takes prefixes; a site name typed here would be stored and then routed
 * nowhere, so it is not offered — see `ROUTE_DOMAINS_UNSUPPORTED` in the
 * contracts, and `InactiveDomainList` below for what happens to the names that
 * were stored before.
 */
export function RouteListEditor({
  entries,
  onChange,
  label,
  disabled = false,
}: {
  entries: string[];
  onChange: (next: string[]) => void;
  /** Overrides the default heading. */
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [value, setValue] = React.useState("");

  const add = () => {
    const entry = value.trim().toLowerCase();
    if (!entry) return;
    if (!looksLikeCidr(entry)) {
      toast.error(t("routes.badIp"));
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
        {label ?? t("routes.ipLabel")}
      </p>
      <div className="flex gap-2">
        <Input
          value={value}
          disabled={disabled}
          placeholder={t("routes.ipPlaceholder")}
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

/**
 * The site names a route rule was saved with before route rules became
 * addresses-only.
 *
 * They are shown rather than deleted on sight: nobody typed them expecting them
 * to disappear, and a list somebody curated is worth reading once before it
 * goes. Struck through and unclickable, because that is what they are —
 * stored, inert, routed nowhere. Saving the card drops them, which the note
 * says out loud rather than leaving it to be discovered.
 *
 * The button is what makes that possible: a card whose only stale content is
 * this block is not dirty, so its Save is disabled and the entries could never
 * be cleared. Removing them here is the edit that arms it.
 *
 * Renders nothing when there are none, which is every deployment that never
 * stored one.
 */
export function InactiveDomainList({
  domains,
  onClear,
  disabled = false,
}: {
  domains: string[];
  onClear: () => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  if (domains.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5">
      <p className="text-xs font-medium">{t("routes.staleDomainsTitle")}</p>
      <p className="text-xs leading-snug text-muted-foreground">
        {t("routes.staleDomainsBody")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {domains.map((domain) => (
          <span
            key={domain}
            className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground line-through"
          >
            {domain}
          </span>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onClear}
      >
        {t("routes.staleDomainsClear")}
      </Button>
    </div>
  );
}
