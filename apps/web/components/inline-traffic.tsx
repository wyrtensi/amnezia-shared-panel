"use client";

import { formatTraffic } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { TrafficPair } from "@/lib/types";

/**
 * Compact "Today / 7 days / Month" traffic, all three shown inline (no toggle).
 * Used for per-server traffic on the employee dashboard and admin surfaces.
 */
export function InlineTraffic({
  today,
  week,
  month,
  className,
}: {
  today?: TrafficPair;
  week?: TrafficPair;
  month?: TrafficPair;
  className?: string;
}) {
  const { t, lang } = useT();
  const items: Array<[string, TrafficPair | undefined]> = [
    [t("traffic.rangeToday"), today],
    [t("traffic.range7"), week],
    [t("traffic.range30"), month],
  ];
  return (
    <span
      className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums text-xs text-muted-foreground ${className ?? ""}`}
    >
      {items.map(([label, pair]) => (
        <span key={label} className="whitespace-nowrap">
          <span className="opacity-70">{label}:</span>{" "}
          {formatTraffic(pair ?? null, lang)}
        </span>
      ))}
    </span>
  );
}
