"use client";

import { Check } from "lucide-react";
import { Switch } from "@/components/ui/switch";
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
  nodes: Array<{ id: string; name: string }>;
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
      <label className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm">
        <span>{t("nodeSelect.allNodes")}</span>
        <Switch
          checked={all}
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
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-3.5 items-center justify-center rounded-[4px] border",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40",
                    )}
                  >
                    {active ? <Check className="size-2.5" /> : null}
                  </span>
                  {node.name}
                </button>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}
