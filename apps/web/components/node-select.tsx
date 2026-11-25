"use client";

import { Check } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { formatEntryExit } from "@/lib/egress-api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

/**
 * Node-availability picker. `value === null` means "all nodes"; a list restricts
 * to the chosen node ids. Used for the global default and per-user overrides.
 */
export function NodeSelect({
  nodes,
  value,
  onChange,
}: {
  nodes: Array<{
    id: string;
    name: string;
    address?: string | null;
    egressIpv4?: string | null;
    enabled?: boolean;
  }>;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useT();
  const all = value === null;
  const toggle = (id: string) => {
    const set = new Set(value ?? []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange([...set]);
  };
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 rounded-lg border bg-well shadow-[var(--inset-shadow)] p-2.5 text-sm">
        <span className="min-w-0">{t("nodeSelect.allNodes")}</span>
        <Switch
          checked={all}
          className="shrink-0"
          onCheckedChange={(checked) =>
            onChange(checked ? null : nodes.map((node) => node.id))
          }
        />
      </label>
      {!all ? (
        nodes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("nodeSelect.noNodes")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {nodes.map((node) => {
              const active = value?.includes(node.id) ?? false;
              return (
                <button
                  key={node.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(node.id)}
                  className={cn(
                    "inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                    node.enabled === false && "opacity-70",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40",
                    )}
                  >
                    {active ? <Check className="size-2.5" /> : null}
                  </span>
                  <span>{node.name}</span>
                  {formatEntryExit(node.address, node.egressIpv4) ? (
                    <code className="break-all font-mono text-[11px] font-normal opacity-75">
                      {formatEntryExit(node.address, node.egressIpv4)}
                    </code>
                  ) : null}
                  {node.enabled === false ? (
                    <span className="text-[11px] font-normal opacity-75">
                      ({t("nodes.endpointDisabled").toLowerCase()})
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}
