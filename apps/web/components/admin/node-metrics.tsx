"use client";

import { formatBytesParts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { Lang } from "@/lib/i18n/messages";
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

const bytes = (value: string | number | null | undefined, lang: Lang): string => {
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

  const handshake = endpoint?.lastHandshakeAt
    ? t("nodes.metrics.handshakeAgo", {
        minutes: String(
          Math.max(
            0,
            Math.round(
              (Date.now() - new Date(endpoint.lastHandshakeAt).getTime()) / 60_000,
            ),
          ),
        ),
      })
    : t("nodes.metrics.handshakeNever");

  const rows: Array<[string, string, boolean?]> = [
    [
      t("nodes.metrics.ram"),
      // Used / total, like the Swap and Disk rows, with what is still free
      // spelled out — that is the number the warning above is keyed on.
      `${bytes(memoryUsedBytes(metrics.memTotalBytes, metrics.memAvailableBytes), lang)} / ${bytes(metrics.memTotalBytes, lang)} · ${bytes(metrics.memAvailableBytes, lang)} ${t("nodes.metrics.free")}`,
      memLow,
    ],
    [
      t("nodes.metrics.swap"),
      `${bytes(metrics.swapUsedBytes, lang)} / ${bytes(metrics.swapTotalBytes, lang)}`,
    ],
    [
      t("nodes.metrics.disk"),
      metrics.diskUsedPercent === null
        ? "—"
        : `${metrics.diskUsedPercent}% (${bytes(metrics.diskAvailableBytes, lang)} ${t("nodes.metrics.free")})`,
      diskHigh,
    ],
    [
      t("nodes.metrics.load"),
      metrics.load1 === null
        ? "—"
        : `${metrics.load1.toFixed(2)} / ${number(metrics.cpuCores)}`,
    ],
    [
      t("nodes.metrics.pids"),
      `${number(metrics.agentPidsCurrent)} / ${number(metrics.agentPidsMax)}`,
      pidsHigh,
    ],
    [
      t("nodes.metrics.awg3"),
      metrics.awg3Up === null
        ? "—"
        : `${metrics.awg3Up ? t("nodes.metrics.up") : t("nodes.metrics.down")} · ${number(metrics.awg3Peers)}`,
      metrics.awg3Up === false,
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
          ],
        ] as Array<[string, string, boolean?]>)),
    [
      t("nodes.metrics.agentLatency"),
      metrics.agentLatencyMs === null ? "—" : `${metrics.agentLatencyMs} ms`,
    ],
    // Stated as an observation, never as a probe result: the panel cannot reach
    // a node's public endpoint, so a real user's handshake is the evidence.
    [t("nodes.metrics.lastHandshake"), handshake],
  ];

  // Label above value, not beside it. A node card is a third of a column wide,
  // which leaves a side-by-side row about 90px for "142.0 MB / 960.0 MB" - so
  // the figure wrapped under its own label, or the label collapsed to "M.".
  // Stacked, the figure gets the whole cell and every label stays a word.
  //
  // The column count is a container query, not a viewport one: this grid sits
  // inside a card in a 1-, 2- or 3-up grid, so the viewport says nothing about
  // how much room it actually has.
  return (
    <div className="@container">
      <dl className="grid grid-cols-2 gap-1.5 text-xs @lg:grid-cols-3">
        {/* Each figure sits in its own recess, the way the facts on a key card
            do. Twelve label/value pairs in a three-column grid with nothing
            between them read as one field of text, and the eye has to count
            columns to work out which number belongs to which label. */}
        {rows.map(([label, value, warn]) => (
          <div
            key={label}
            className="min-w-0 rounded-md border border-border/60 bg-well px-2 py-1 shadow-[var(--inset-shadow)]"
          >
            <dt className="truncate text-[11px] leading-tight text-muted-foreground">
              {label}
            </dt>
            <dd
              className={cn(
                "truncate leading-tight tabular-nums",
                warn && "font-medium text-destructive",
              )}
              // The cell is narrow by design; hovering still gives the figure
              // in full rather than making the operator widen the window.
              title={value}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
