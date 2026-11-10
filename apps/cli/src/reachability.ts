import type { AdminReachabilityView, ProbeLevel } from "@amnezia/contracts";

/** ok / fail / — for a level that passed, failed, or was not attempted. */
export const levelMark = (level: ProbeLevel | null | undefined): string =>
  level?.ok === true ? "ok" : level?.ok === false ? "fail" : "—";

/**
 * The three verdicts stay distinct: `error` means the probe could not look,
 * so nothing is known about the node — never "unavailable".
 */
export const reachabilityLabel = (status: string | null | undefined): string => {
  switch (status) {
    case "ok":
      return "available";
    case "failed":
      return "UNAVAILABLE";
    case "error":
      return "unknown";
    default:
      return "no data";
  }
};

/** One row per (node, protocol); nodes without a protocol yet get one row. */
export const reachabilityRows = (
  view: AdminReachabilityView,
  nodeFilter?: string,
): Array<Record<string, string>> =>
  view.nodes
    .filter(
      (node) => !nodeFilter || node.nodeId === nodeFilter || node.nodeName === nodeFilter,
    )
    .flatMap((node) => {
      const base = {
        node: node.reachabilityEnabled ? node.nodeName : `${node.nodeName} (off)`,
        status: reachabilityLabel(node.status),
        "failing since": node.failingSince ?? "—",
      };
      if (node.protocols.length === 0) {
        return [
          { ...base, protocol: "—", ping: "—", tcp: "—", handshake: "—", http: "—", egress: "—", detail: node.detail ?? "—" },
        ];
      }
      return node.protocols.map((protocol) => ({
        ...base,
        protocol: protocol.protocol,
        ping: levelMark(protocol.levels?.ping),
        tcp: levelMark(protocol.levels?.tcp),
        handshake: levelMark(protocol.levels?.handshake),
        http: levelMark(protocol.levels?.http),
        egress: protocol.egressIp ?? "—",
        detail: protocol.detail ?? "—",
      }));
    });

export const REACHABILITY_COLUMNS = [
  "node",
  "status",
  "protocol",
  "ping",
  "tcp",
  "handshake",
  "http",
  "egress",
  "failing since",
  "detail",
];

/** Settings and health, one fact per line. The API key is never shown. */
export const probeSummaryLines = (probe: NonNullable<AdminReachabilityView["probe"]>): string[] => [
  `label:          ${probe.label}`,
  `api url:        ${probe.apiBaseUrl}`,
  `enabled:        ${probe.enabled ? "yes" : "no"}`,
  `control url:    ${probe.controlUrl}`,
  `egress url:     ${probe.egressUrl}`,
  `every:          ${Math.round(probe.intervalSec / 60)}m`,
  `fail threshold: ${probe.failThreshold} run(s)`,
  `stale after:    ${Math.round(probe.staleAfterSec / 60)}m`,
  `last result:    ${probe.lastResultAt ?? "never"}${probe.stale ? "  (STALE)" : ""}`,
  `run in flight:  ${probe.runInFlight ? "yes" : "no"}`,
  `last error:     ${probe.lastError ? `${probe.lastError} (${probe.lastErrorAt ?? "?"})` : "—"}`,
];

const intFlag = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
};

/**
 * The PUT body for `probe-set`. The endpoint replaces the settings, so fields
 * the operator did not name are carried over from the current probe; on a new
 * probe the required ones must be given.
 */
export const buildProbeUpsert = (
  flags: {
    label?: string;
    apiUrl?: string;
    apiKey?: string;
    controlUrl?: string;
    egressUrl?: string;
    intervalSec?: string;
    failThreshold?: string;
    staleAfterSec?: string;
    enabled?: string;
  },
  current: AdminReachabilityView["probe"],
): Record<string, unknown> => {
  const label = flags.label ?? current?.label;
  const apiBaseUrl = flags.apiUrl ?? current?.apiBaseUrl;
  const controlUrl = flags.controlUrl ?? current?.controlUrl;
  if (!label || !apiBaseUrl || !controlUrl || (!current && !flags.apiKey)) {
    throw new Error(
      "Usage: probe-set --label= --api-url= --api-key-file=<path|-> --control-url= " +
        "[--egress-url=] [--interval-sec=3600] [--fail-threshold=2] [--stale-after-sec=10800] [--enabled=on|off]",
    );
  }
  if (flags.enabled !== undefined && flags.enabled !== "on" && flags.enabled !== "off") {
    throw new Error("--enabled must be on or off");
  }
  const body: Record<string, unknown> = {
    label,
    apiBaseUrl,
    controlUrl,
    egressUrl: flags.egressUrl ?? current?.egressUrl,
    intervalSec: intFlag(flags.intervalSec, "interval-sec") ?? current?.intervalSec,
    failThreshold: intFlag(flags.failThreshold, "fail-threshold") ?? current?.failThreshold,
    staleAfterSec: intFlag(flags.staleAfterSec, "stale-after-sec") ?? current?.staleAfterSec,
    enabled: flags.enabled === undefined ? current?.enabled : flags.enabled === "on",
  };
  if (flags.apiKey) body.apiKey = flags.apiKey;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
};
