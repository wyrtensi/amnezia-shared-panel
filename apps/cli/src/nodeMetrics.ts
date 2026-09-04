/**
 * Formatting host metrics for a terminal, and the thresholds the panel paints
 * red.
 *
 * The thresholds live here rather than only inside a `.tsx` file because an
 * operator over SSH was otherwise given the raw figures and no idea which one
 * the panel considers a problem. They are the same three numbers, from
 * docs/SMALL-HOSTS.md: 200 MiB of MemAvailable is where a deploy starts failing
 * its own gate, 85 % disk is where an image pull stops fitting, and 80 % of the
 * cgroup task cap is the signature failure of a small host - a container that
 * looks healthy and cannot fork.
 */

export const METRIC_WARNINGS = {
  memAvailableBytes: 200 * 1024 * 1024,
  diskUsedPercent: 85,
  pidsFraction: 0.8,
} as const;

export type NodeMetricsView = {
  memTotalBytes?: string | null;
  memAvailableBytes?: string | null;
  swapTotalBytes?: string | null;
  swapUsedBytes?: string | null;
  diskUsedPercent?: number | null;
  load1?: number | null;
  cpuCores?: number | null;
  agentPidsCurrent?: number | null;
  agentPidsMax?: number | null;
  awg3Up?: boolean | null;
  awg3Peers?: number | null;
  awg2Up?: boolean | null;
  awg2Peers?: number | null;
  agentLatencyMs?: number | null;
};

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Bytes as a short string. A dash for anything unreported - never a zero. */
export const formatBytes = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  let size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "—";
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)}${UNITS[unit]}`;
};

export const metricPair = (
  used: string | number | null | undefined,
  total: string | number | null | undefined,
): string =>
  used === null || used === undefined
    ? "—"
    : `${formatBytes(used)}/${formatBytes(total)}`;

/** An AWG interface: up or down, and how many peers. A dash means not served. */
export const awgCell = (
  up: boolean | null | undefined,
  peers: number | null | undefined,
): string => (up === null || up === undefined ? "—" : `${up ? "up" : "down"}:${peers ?? "?"}`);

/**
 * How long ago a peer last completed a handshake.
 *
 * Phrased as an age rather than as a verdict: the panel cannot probe a node's
 * public endpoint, so this is a real user's connection succeeding, and it can
 * only under-report.
 */
export const handshakeCell = (
  lastHandshakeAt: string | null,
  now: Date = new Date(),
): string => {
  if (!lastHandshakeAt) return "never";
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - new Date(lastHandshakeAt).getTime()) / 60_000),
  );
  return `${minutes}m ago`;
};

/** The panel's own warnings for one node, in words rather than in colour. */
export const metricWarnings = (
  nodeName: string,
  metrics: NodeMetricsView | null | undefined,
): string[] => {
  if (!metrics) return [];
  const warnings: string[] = [];
  const available = metrics.memAvailableBytes;
  if (
    available !== null &&
    available !== undefined &&
    Number(available) < METRIC_WARNINGS.memAvailableBytes
  ) {
    warnings.push(
      `${nodeName}: ${formatBytes(available)} of memory available, below the ${formatBytes(METRIC_WARNINGS.memAvailableBytes)} the deploy gate wants`,
    );
  }
  if (
    metrics.diskUsedPercent !== null &&
    metrics.diskUsedPercent !== undefined &&
    metrics.diskUsedPercent >= METRIC_WARNINGS.diskUsedPercent
  ) {
    warnings.push(
      `${nodeName}: disk ${metrics.diskUsedPercent}% used (reclaim: docker image prune -a, journalctl --vacuum-size=100M)`,
    );
  }
  const current = metrics.agentPidsCurrent;
  const max = metrics.agentPidsMax;
  if (
    current !== null &&
    current !== undefined &&
    max !== null &&
    max !== undefined &&
    max > 0 &&
    current / max >= METRIC_WARNINGS.pidsFraction
  ) {
    warnings.push(
      `${nodeName}: ${current}/${max} tasks in the agent's cgroup - at the cap it cannot fork, while still looking healthy`,
    );
  }
  if (metrics.awg3Up === false) {
    warnings.push(`${nodeName}: the AWG 3.1 interface is down`);
  }
  return warnings;
};
