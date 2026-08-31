"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { ProtocolKind } from "@/lib/types";

/**
 * Panel-known protocols, preferred first. Future-proof: adding a protocol here
 * (and to the ProtocolKind type) surfaces it everywhere this control is used.
 * `note` holds an i18n key resolved at render time.
 */
export const PROTOCOLS: Array<{
  value: ProtocolKind;
  label: string;
  note?: string;
}> = [
  { value: "awg3", label: "AWG 3.1", note: "protoSelect.recommended" },
  { value: "awg2", label: "AWG 2.0", note: "protoSelect.legacy" },
];

/**
 * Chip multi-toggle for choosing a set of protocols. Enforces at least one
 * selected. `available` optionally restricts the options (e.g. to a node's
 * physically-supported protocols).
 */
export function ProtocolSelect({
  value,
  onChange,
  available,
  disabled,
}: {
  value: ProtocolKind[];
  onChange: (next: ProtocolKind[]) => void;
  available?: ProtocolKind[];
  disabled?: boolean;
}) {
  const { t } = useT();
  const toggle = (protocol: ProtocolKind) => {
    const has = value.includes(protocol);
    const next = has
      ? value.filter((item) => item !== protocol)
      : [...value, protocol];
    onChange(next.length === 0 ? [protocol] : next);
  };

  return (
    <div className="flex flex-wrap gap-1.5" role="group">
      {PROTOCOLS.map((protocol) => {
        const supported = !available || available.includes(protocol.value);
        const active = value.includes(protocol.value);
        const note = !supported ? "protoSelect.unsupported" : protocol.note;
        return (
          <button
            key={protocol.value}
            type="button"
            disabled={disabled || !supported}
            aria-pressed={active}
            onClick={() => toggle(protocol.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
              "disabled:cursor-not-allowed",
              !supported
                ? "border-dashed border-border text-muted-foreground/50"
                : active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <span
              className={cn(
                "flex size-3.5 items-center justify-center rounded-[4px] border",
                active && supported
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40",
              )}
            >
              {active && supported ? <Check className="size-2.5" /> : null}
            </span>
            {protocol.label}
            {note ? (
              <span className="text-[10px] opacity-70">· {t(note)}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
