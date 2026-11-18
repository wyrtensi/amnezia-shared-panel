"use client";

import { formatBytesParts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { Lang, MessageKey } from "@/lib/i18n/messages";
import type { AdminNodeMetrics, NodeEndpointSignal } from "@/lib/types";

/**
 * The thresholds an admin is shown in colour, in one place.
 *
 * They come from docs/SMALL-HOSTS.md rather than from taste: 200 MiB of
 * MemAvailable is where a deploy starts failing its own gate, 85 % disk is where
 * an image pull stops fitting, and 80 % of the cgroup task cap is the signature
 * failure of a small host - a container that looks healthy and cannot fork.
 */
export const METRIC_WARNINGS = {
  memAvailableBytes: 200 * 1024 * 1024,
  diskUsedPercent: 85,
  pidsFraction: 0.8,
} as const;

export const metricBytes = (value: string | number | null | undefined, lang: Lang): string => {
  if (value === null || value === undefined) return "—";
  const parts = formatBytesParts(String(value), lang);
  return parts ? `${parts.value} ${parts.unit}` : "—";
};

const number = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : String(value);

/**
 * How much memory is actually in use: total minus MemAvailable, never total
 * minus free — the difference is the page cache, which the kernel hands back
 * on demand and which would otherwise read as a nearly full machine.
 *
 * The row used to show MemAvailable itself, directly above a Swap row showing
 * the opposite (used, not free). Two adjacent numbers with opposite meanings
 * and nothing to tell them apart: a host with 706 MiB of its 961 MiB in use
 * read as "280 / 961", which is not a smaller number for the same thing but a
 * different thing entirely.
 *
 * Values arrive as strings (bigint columns), so the arithmetic is BigInt: at
 * this size Number would still be exact, but the parsing would be the only
 * place in this file that quietly assumes it.
 */
export const memoryUsedBytes = (
  total: string | number | null | undefined,
  available: string | number | null | undefined,
): string | null => {
  if (total === null || total === undefined) return null;
  if (available === null || available === undefined) return null;
  try {
    const used = BigInt(String(total)) - BigInt(String(available));
    // A node reporting more available than total is reporting nonsense; show a
    // dash rather than a negative "in use".
    return used < 0n ? null : String(used);
  } catch {
    return null;
  }
};

/**
 * The scales that have no natural ceiling get one here. Latency is drawn
 * against half a second (an agent answering slower than that is already a
 * problem), and handshake age against an hour: WireGuard renews a live
 * session every two minutes, so an hour of silence means nobody is connected.
 */
export const METRIC_BAR_SCALES = {
  agentLatencyMs: 500,
  handshakeMinutes: 60,
} as const;

export type MetricBarTone = "ok" | "warn" | "bad";

export type MetricBar = { fraction: number; tone: MetricBarTone };

/**
 * A fraction of its ceiling, clamped to the bar. Null when either side is
 * missing: an empty track would read as "zero used", which is a measurement.
 */
export const barFraction = (
  value: number | null | undefined,
  max: number | null | undefined,
): number | null => {
  if (value === null || value === undefined) return null;
  if (max === null || max === undefined || !(max > 0)) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(1, value / max);
};

/**
 * Amber from 70 %, red from 85 % - the disk warning's own threshold, used for
 * every bar so one colour means the same thing on all of them. A metric with a
 * sharper threshold of its own (free memory, the task cap) forces red past it.
 */
export const barTone = (fraction: number, forceBad = false): MetricBarTone => {
  if (forceBad || fraction >= 0.85) return "bad";
  if (fraction >= 0.7) return "warn";
  return "ok";
};

export const metricBar = (fraction: number | null, forceBad = false): MetricBar | null =>
  fraction === null ? null : { fraction, tone: barTone(fraction, forceBad) };
const bar = metricBar;
const bytes = metricBytes;

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type CpuCell = {
  label: string;
  value: string;
  hover: string;
  bar: MetricBar | null;
};

/**
 * The CPU cell: real utilisation as a share of every core, with each core,
 * iowait, steal and the load average in the hover.
 *
 * It used to be load1 / cores, and on a small VPS that is mostly iowait: a host
 * whose CPU was 12-20 % busy drew a 40-90 % bar. An agent older than 1.1.17
 * reports no utilisation, and for it the cell stays exactly what it was.
 */
export const cpuCell = (metrics: AdminNodeMetrics, t: Translate): CpuCell => {
  const used = metrics.cpuUsedPercent;
  if (used === null || used === undefined) {
    const value =
      metrics.load1 === null
        ? "—"
        : `${metrics.load1.toFixed(2)} / ${number(metrics.cpuCores)}`;
    return {
      label: t("nodes.metrics.load"),
      value,
      hover: value,
      bar: bar(barFraction(metrics.load1, metrics.cpuCores)),
    };
  }

  const percent = (value: number) => value.toFixed(1);
  const hover = [t("nodes.metrics.cpuTotal", { value: percent(used) })];
  (metrics.cpuPerCorePercent ?? []).forEach((core, index) =>
    hover.push(t("nodes.metrics.cpuCore", { index, value: percent(core) })),
  );
  if (metrics.cpuIowaitPercent !== null && metrics.cpuIowaitPercent !== undefined) {
    hover.push(t("nodes.metrics.cpuIowait", { value: percent(metrics.cpuIowaitPercent) }));
  }
  if (metrics.cpuStealPercent !== null && metrics.cpuStealPercent !== undefined) {
    hover.push(t("nodes.metrics.cpuSteal", { value: percent(metrics.cpuStealPercent) }));
  }
  // Kept as text: it is still the number an operator compares against `uptime`
  // on the host, it just no longer draws the bar.
  const loads = [metrics.load1, metrics.load5, metrics.load15];
  if (loads.every((value) => typeof value === "number")) {
    hover.push(
      t("nodes.metrics.cpuLoad", {
        load: loads.map((value) => value.toFixed(2)).join(" / "),
      }),
    );
  }

  return {
    label: t("nodes.metrics.cpu"),
    value: `${Math.round(used)}%`,
    hover: hover.join("\n"),
    bar: bar(barFraction(used, 100)),
  };
};

const BAR_TONE_CLASS: Record<MetricBarTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

export type MetricRow = [string, string, boolean | undefined, MetricBar | null, string?];

export function MetricMeter({ meter }: { meter: MetricBar | null }) {
  if (!meter) return null;
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-well shadow-[var(--inset-shadow)]" aria-hidden>
      <div
        className={cn("h-full rounded-full", BAR_TONE_CLASS[meter.tone])}
        style={{ width: `${Math.max(meter.fraction * 100, meter.fraction > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}

/** A dash, never a zero. A zero here reads as a measurement. */
export function NodeMetrics({
  metrics,
  endpoint,
}: {
  metrics?: AdminNodeMetrics | null;
  endpoint?: NodeEndpointSignal | null;
}) {
  const { t, lang } = useT();
  if (!metrics) {
    return (
      <p className="text-xs text-muted-foreground">{t("nodes.metrics.never")}</p>
    );
  }

  const memLow =
    metrics.memAvailableBytes !== null &&
    Number(metrics.memAvailableBytes) < METRIC_WARNINGS.memAvailableBytes;
  const diskHigh =
    metrics.diskUsedPercent !== null &&
    metrics.diskUsedPercent >= METRIC_WARNINGS.diskUsedPercent;
  const pidsHigh =
    metrics.agentPidsCurrent !== null &&
    metrics.agentPidsMax !== null &&
    metrics.agentPidsMax > 0 &&
    metrics.agentPidsCurrent / metrics.agentPidsMax >= METRIC_WARNINGS.pidsFraction;

  const handshakeMinutes = endpoint?.lastHandshakeAt
    ? Math.max(
        0,
        Math.round((Date.now() - new Date(endpoint.lastHandshakeAt).getTime()) / 60_000),
      )
    : null;
  const handshake =
    handshakeMinutes === null
      ? t("nodes.metrics.handshakeNever")
      : t("nodes.metrics.handshakeAgo", { minutes: String(handshakeMinutes) });

  const memUsed = memoryUsedBytes(metrics.memTotalBytes, metrics.memAvailableBytes);
  // An interface state has no fraction: the bar is simply full, green when up
  // and red when down, so the row still carries the same visual cue.
  const stateBar = (up: boolean | null): MetricBar | null =>
    up === null ? null : { fraction: 1, tone: up ? "ok" : "bad" };

  const cpu = cpuCell(metrics, t);

  // The optional fifth element is the hover text, for a cell whose detail does
  // not fit in it; every other cell hovers its own figure in full.
  const rows: MetricRow[] = [
    [
      t("nodes.metrics.ram"),
      // Used / total, like the Swap and Disk rows, with what is still free
      // spelled out — that is the number the warning above is keyed on.
      `${bytes(memUsed, lang)} / ${bytes(metrics.memTotalBytes, lang)} · ${bytes(metrics.memAvailableBytes, lang)} ${t("nodes.metrics.free")}`,
      memLow,
      bar(barFraction(memUsed === null ? null : Number(memUsed), Number(metrics.memTotalBytes)), memLow),
    ],
    [
      t("nodes.metrics.swap"),
      `${bytes(metrics.swapUsedBytes, lang)} / ${bytes(metrics.swapTotalBytes, lang)}`,
      undefined,
      bar(
        barFraction(
          metrics.swapUsedBytes === null ? null : Number(metrics.swapUsedBytes),
          metrics.swapTotalBytes === null ? null : Number(metrics.swapTotalBytes),
        ),
      ),
    ],
    [
      t("nodes.metrics.disk"),
      metrics.diskUsedPercent === null
        ? "—"
        : `${metrics.diskUsedPercent}% (${bytes(metrics.diskAvailableBytes, lang)} ${t("nodes.metrics.free")})`,
      diskHigh,
      bar(barFraction(metrics.diskUsedPercent, 100), diskHigh),
    ],
    [cpu.label, cpu.value, undefined, cpu.bar, cpu.hover],
    [
      t("nodes.metrics.pids"),
      `${number(metrics.agentPidsCurrent)} / ${number(metrics.agentPidsMax)}`,
      pidsHigh,
      bar(barFraction(metrics.agentPidsCurrent, metrics.agentPidsMax), pidsHigh),
    ],
    [
      t("nodes.metrics.awg3"),
      metrics.awg3Up === null
        ? "—"
        : `${metrics.awg3Up ? t("nodes.metrics.up") : t("nodes.metrics.down")} · ${number(metrics.awg3Peers)}`,
      metrics.awg3Up === false,
      stateBar(metrics.awg3Up),
    ],
    // Reported only where AWG 2.0 is actually enabled, so a dash here means
    // "this node does not serve it", not "we failed to read it".
    ...(metrics.awg2Up === null
      ? []
      : ([
          [
            t("nodes.metrics.awg2"),
            `${metrics.awg2Up ? t("nodes.metrics.up") : t("nodes.metrics.down")} · ${number(metrics.awg2Peers)}`,
            metrics.awg2Up === false,
            stateBar(metrics.awg2Up),
          ],
        ] as MetricRow[])),
    [
      t("nodes.metrics.agentLatency"),
      metrics.agentLatencyMs === null ? "—" : `${metrics.agentLatencyMs} ms`,
      undefined,
      bar(barFraction(metrics.agentLatencyMs, METRIC_BAR_SCALES.agentLatencyMs)),
    ],
    // Stated as an observation, never as a probe result: the panel cannot reach
    // a node's public endpoint, so a real user's handshake is the evidence.
    [
      t("nodes.metrics.lastHandshake"),
      handshake,
      undefined,
      bar(barFraction(handshakeMinutes, METRIC_BAR_SCALES.handshakeMinutes)),
    ],
  ];

  return <MetricGrid rows={rows} />;
}

export function MetricGrid({ rows }: { rows: MetricRow[] }) {
  return (
    <div className="@container">
      <dl className="grid grid-cols-1 gap-1.5 text-xs @min-[14rem]:grid-cols-2 @min-[27rem]:grid-cols-3">
        {rows.map(([label, value, warn, meter, hover]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col rounded-md border border-border/60 bg-well px-2 py-1.5 shadow-[var(--inset-shadow)]"
          >
            <dt className="break-words text-[11px] leading-tight text-muted-foreground">
              {label}
            </dt>
            <dd
              className={cn(
                "break-words font-medium leading-snug tabular-nums",
                warn && "font-medium text-destructive",
              )}
              title={hover ?? value}
            >
              {value}
            </dd>
            {meter && <div className="mt-auto"><MetricMeter meter={meter} /></div>}
          </div>
        ))}
      </dl>
    </div>
  );
}
