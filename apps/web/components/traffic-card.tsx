"use client";

import * as React from "react";
import { ArrowUpDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

type Point = { date: string; receivedBytes: string; sentBytes: string };

const RANGES: Array<[number, string]> = [
  [1, "traffic.rangeToday"],
  [7, "traffic.range7"],
  [30, "traffic.range30"],
];

/**
 * Traffic-over-time card with a range selector (default 30 days). Fetches its
 * own daily series from `endpoint` (`/api/traffic` for a user, `/api/admin/
 * traffic` for the admin overview).
 */
export function TrafficCard({
  endpoint,
  title,
}: {
  endpoint: string;
  title: string;
}) {
  const { t, lang } = useT();
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState<Point[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    apiRequest<Point[]>(`${endpoint}?days=${days}`)
      .then((rows) => {
        if (active) {
          setData(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setData([]);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [endpoint, days]);

  // Parse received+sent together per point so a bad value drops BOTH — keeps
  // sent = sum - received from ever going negative.
  const parsed = data.map((point) => {
    try {
      return {
        received: Number(BigInt(point.receivedBytes)),
        sent: Number(BigInt(point.sentBytes)),
      };
    } catch {
      return { received: 0, sent: 0 };
    }
  });
  const totals = parsed.map((point) => point.received + point.sent);
  const max = Math.max(1, ...totals);
  const received = parsed.reduce((acc, point) => acc + point.received, 0);
  const sent = parsed.reduce((acc, point) => acc + point.sent, 0);
  const sum = received + sent;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <ArrowUpDown className="h-4 w-4 text-chart-5" />
            {title}
          </h2>
          <div className="flex rounded-lg border p-0.5">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setDays(value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  days === value
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <Skeleton className="h-28 w-full" />
        ) : data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("traffic.noData")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                <span className="text-muted-foreground">{t("traffic.total")}</span>
                <span className="tabular-nums font-semibold">
                  {formatBytes(String(sum), lang)}
                </span>
              </span>
              <span className="text-muted-foreground">
                ↓ {formatBytes(String(received), lang)} · ↑{" "}
                {formatBytes(String(sent), lang)}
              </span>
            </div>
            <div className="flex h-28 items-end gap-0.5">
              {data.map((point, index) => (
                <div
                  key={point.date}
                  title={`${point.date}: ${formatBytes(String(totals[index] ?? 0), lang)}`}
                  className="min-h-[2px] flex-1 rounded-t bg-chart-1/70 transition-[height]"
                  style={{ height: `${((totals[index] ?? 0) / max) * 100}%` }}
                />
              ))}
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{data[0]?.date}</span>
              <span>{data[data.length - 1]?.date}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
