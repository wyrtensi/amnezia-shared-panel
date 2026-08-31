"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { formatTrafficParts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { TrafficPair } from "@/lib/types";

/**
 * Received / sent for a single traffic pair, shown as "↓ received ↑ sent".
 * Down = received (into the device), up = sent (out of the device).
 */
export function TrafficSplit({
  pair,
  className,
}: {
  pair?: TrafficPair | null;
  className?: string;
}) {
  const { lang } = useT();
  const parts = formatTrafficParts(pair ?? null, lang);
  if (!parts) return <span className={className}>—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums whitespace-nowrap",
        className,
      )}
      title={`↓ ${parts.received} · ↑ ${parts.sent}`}
    >
      <ArrowDown className="h-3 w-3 shrink-0 text-chart-2" aria-hidden />
      {parts.received}
      <ArrowUp className="ml-0.5 h-3 w-3 shrink-0 text-chart-5" aria-hidden />
      {parts.sent}
    </span>
  );
}

/**
 * Compact "Today / 7 days / Month" traffic, all three shown inline (no toggle),
 * each split into received / sent. Used for per-server traffic on the employee
 * dashboard and admin surfaces.
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
  const { t } = useT();
  const items: Array<[string, TrafficPair | undefined]> = [
    [t("traffic.rangeToday"), today],
    [t("traffic.range7"), week],
    [t("traffic.range30"), month],
  ];
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {items.map(([label, pair]) => (
        <span key={label} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="opacity-70">{label}</span>
          <TrafficSplit pair={pair} />
        </span>
      ))}
    </span>
  );
}
