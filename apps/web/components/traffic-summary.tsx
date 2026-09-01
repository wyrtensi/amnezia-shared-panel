"use client";

import * as React from "react";
import { ArrowUpDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/api";
import { TrafficSplit } from "@/components/inline-traffic";
import { useT } from "@/lib/i18n/provider";
import type { TrafficPair } from "@/lib/types";

type Point = { date: string; receivedBytes: string; sentBytes: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES: Array<{ days: number; label: string }> = [
  { days: 1, label: "traffic.rangeToday" },
  { days: 7, label: "traffic.range7" },
  { days: 30, label: "traffic.range30" },
];

/**
 * First UTC calendar day of a `days`-long window ending today, as `YYYY-MM-DD`
 * — the same convention the API uses (days=1 means today only).
 */
function windowStart(days: number): string {
  return new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Sum the daily series over the last `days` days. The series is sparse (only
 * days with traffic are returned), so buckets are filtered by date rather than
 * by position, and summed with BigInt to stay exact.
 */
function sumWindow(points: Point[], days: number): TrafficPair {
  const since = windowStart(days);
  let received = 0n;
  let sent = 0n;
  for (const point of points) {
    if (point.date < since) continue;
    try {
      received += BigInt(point.receivedBytes);
      sent += BigInt(point.sentBytes);
    } catch {
      // Skip a malformed bucket instead of dropping the whole range.
    }
  }
  return { receivedBytes: received.toString(), sentBytes: sent.toString() };
}

/**
 * Compact traffic summary: totals for today / 7 days / 30 days, each with its
 * received and sent split. Fetches the daily series from `endpoint`
 * (`/api/admin/traffic` for the admin overview) and aggregates it client-side.
 */
export function TrafficSummary({
  endpoint,
  title,
}: {
  endpoint: string;
  title: string;
}) {
  const { t } = useT();
  const [points, setPoints] = React.useState<Point[] | null>(null);

  React.useEffect(() => {
    let active = true;
    setPoints(null);
    apiRequest<Point[]>(`${endpoint}?days=30`)
      .then((rows) => {
        if (active) setPoints(rows);
      })
      .catch(() => {
        if (active) setPoints([]);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <ArrowUpDown className="h-4 w-4 text-chart-5" />
          {title}
        </h2>
        {points === null ? (
          <Skeleton className="h-9 w-72 max-w-full" />
        ) : points.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("traffic.noData")}</p>
        ) : (
          <dl className="flex flex-wrap items-start gap-x-8 gap-y-3">
            {RANGES.map(({ days, label }) => (
              <div key={days} className="space-y-0.5">
                <dt className="text-[11px] text-muted-foreground">
                  {t(label)}
                </dt>
                <dd className="text-sm">
                  <TrafficSplit pair={sumWindow(points, days)} showTotal />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
