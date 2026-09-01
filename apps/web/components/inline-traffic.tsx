"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import {
  formatBytesParts,
  formatExactBytes,
  parseTraffic,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { TrafficPair } from "@/lib/types";

/**
 * Placeholder for a readout with nothing to show. `label` explains which case
 * it is (no data at all vs. no traffic yet) on hover and for screen readers.
 */
function TrafficDash({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn("text-muted-foreground", className)}
      title={label}
      aria-label={label}
    >
      —
    </span>
  );
}

/**
 * One byte figure: the amount carries the weight, the unit stays a step smaller
 * and dimmer, digits are tabular so stacked rows line up.
 */
function Figure({
  bytes,
  strong,
  className,
}: {
  bytes: string | bigint;
  strong?: boolean;
  className?: string;
}) {
  const { t, lang } = useT();
  const parts = formatBytesParts(bytes, lang);
  if (!parts) return <TrafficDash label={t("common.noData")} />;
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-px whitespace-nowrap tabular-nums",
        className,
      )}
    >
      <span className={strong ? "font-semibold" : "font-medium"}>
        {parts.value}
      </span>
      <span className="text-[0.85em] font-normal opacity-70">{parts.unit}</span>
    </span>
  );
}

/**
 * One direction of a transfer: a small tinted arrow plus its figure. Down =
 * received (into the device), up = sent (out of the device).
 */
function Direction({
  direction,
  bytes,
}: {
  direction: "down" | "up";
  bytes: bigint;
}) {
  const Icon = direction === "down" ? ArrowDown : ArrowUp;
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <Icon
        className={cn(
          "size-3 shrink-0 self-center",
          direction === "down" ? "text-chart-2" : "text-chart-5",
        )}
        aria-hidden
      />
      <Figure bytes={bytes} />
    </span>
  );
}

/**
 * A standalone byte total (no direction split). Renders a dash with an
 * explanatory tooltip when there is no data or no traffic yet, and carries the
 * exact byte count as a `title`.
 */
export function TrafficBytes({
  bytes,
  strong,
  className,
}: {
  bytes?: string | bigint | null;
  strong?: boolean;
  className?: string;
}) {
  const { t, lang } = useT();
  const raw = bytes ?? null;
  if (raw === null || formatBytesParts(raw, lang) === null) {
    return <TrafficDash label={t("common.noData")} className={className} />;
  }
  if (Number(raw) === 0) {
    return <TrafficDash label={t("traffic.none")} className={className} />;
  }
  return (
    <span
      className={cn("inline-flex whitespace-nowrap", className)}
      title={formatExactBytes(raw, lang)}
    >
      <Figure bytes={raw} strong={strong} />
    </span>
  );
}

/**
 * Received / sent for a single traffic pair, shown as "↓ received ↑ sent" and
 * optionally prefixed by the total. Hovering reveals the exact byte counts.
 */
export function TrafficSplit({
  pair,
  showTotal = false,
  className,
}: {
  pair?: TrafficPair | null;
  showTotal?: boolean;
  className?: string;
}) {
  const { t, lang } = useT();
  const totals = parseTraffic(pair ?? null);
  if (!totals) {
    return <TrafficDash label={t("common.noData")} className={className} />;
  }
  if (totals.total === 0n) {
    return <TrafficDash label={t("traffic.none")} className={className} />;
  }
  const title = [
    `${t("traffic.total")}${formatExactBytes(totals.total, lang)}`,
    `${t("traffic.received")}: ${formatExactBytes(totals.received, lang)}`,
    `${t("traffic.sent")}: ${formatExactBytes(totals.sent, lang)}`,
  ].join("\n");
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-x-2 whitespace-nowrap",
        className,
      )}
      title={title}
    >
      {showTotal ? <Figure bytes={totals.total} strong /> : null}
      <span
        className={cn(
          "inline-flex items-baseline gap-x-2",
          showTotal && "text-muted-foreground",
        )}
      >
        <Direction direction="down" bytes={totals.received} />
        <Direction direction="up" bytes={totals.sent} />
      </span>
    </span>
  );
}

/**
 * Compact "Today / 7 days / Month" traffic, all three shown inline (no toggle),
 * each split into received / sent behind a small range chip. Used for per-server
 * traffic on the employee dashboard and admin surfaces.
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
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs",
        className,
      )}
    >
      {items.map(([label, pair]) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none font-medium text-muted-foreground">
            {label}
          </span>
          <TrafficSplit pair={pair} className="text-foreground" />
        </span>
      ))}
    </span>
  );
}
