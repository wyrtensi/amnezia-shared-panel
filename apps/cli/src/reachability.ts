import type {
  AdminReachabilityBridge,
  AdminReachabilityNode,
  AdminReachabilityView,
  ProbeLevel,
} from "@amnezia/contracts";

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
          { ...base, protocol: "—", ping: "—", tcp: "—", handshake: "—", http: "—", download: "—", egress: "—", detail: node.detail ?? "—" },
        ];
      }
      return node.protocols.map((protocol) => ({
        ...base,
        protocol: protocol.protocol,
        ping: levelMark(protocol.levels?.ping),
        tcp: levelMark(protocol.levels?.tcp),
        handshake: levelMark(protocol.levels?.handshake),
        http: levelMark(protocol.levels?.http),
        download: levelMark(protocol.levels?.download),
        egress: protocol.egressIp ?? "—",
        detail: [protocol.detail, protocol.levels?.download?.ok === false && protocol.levels.download.detail]
          .filter(Boolean).join(", ") || "—",
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
  "download",
  "egress",
  "failing since",
  "detail",
];

export const endpointReachabilityLines = (node: AdminReachabilityNode): string[] => {
  const endpoints = node.publicEndpoints ?? [];
  if (endpoints.length === 0) return [];
  const lines: string[] = [];
  for (const ep of endpoints) {
    const state = !ep.enabled
      ? "disabled"
      : !ep.reachabilityEnabled
        ? `${reachabilityLabel(ep.probeStatus)} (alerts off)`
        : `${reachabilityLabel(ep.probeStatus)}${ep.incidentOpen ? " (incident)" : ""}`;
    const levels = ep.probeLevels
      ? ` [ping:${levelMark(ep.probeLevels.ping)} tcp:${levelMark(ep.probeLevels.tcp)} hs:${levelMark(ep.probeLevels.handshake)} http:${levelMark(ep.probeLevels.http)}]`
      : "";
    const since = ep.probeFailingSince ? ` since ${ep.probeFailingSince}` : "";
    const detail = ep.probeDetail ? ` (${ep.probeDetail})` : "";
    lines.push(`  endpoint ${ep.name} (${ep.publicAddress}): ${state}${levels}${since}${detail}`);
  }
  return lines;
};

export const bridgeReachabilityLines = (bridge: AdminReachabilityBridge): string[] => {
  const frps = bridge.frpsReachable === null ? "unknown" : bridge.frpsReachable ? "reachable" : "unreachable";
  const managementIncident = bridge.mgmtIncidentOpen ? " (incident)" : "";
  const externalIncident = bridge.probeIncidentOpen ? " (incident)" : "";
  const lines = [
    `bridge ${bridge.bridgeName} (${bridge.bridgeId}, ${bridge.publicIpv4}), alerts ${bridge.reachabilityEnabled ? "on" : "off"}`,
    `  management: ${bridge.managementStatus}, frps: ${frps}${managementIncident}`,
    `  external probe: ${reachabilityLabel(bridge.probeStatus)}${externalIncident}${bridge.probeCheckedAt ? ` at ${bridge.probeCheckedAt}` : ""}`,
  ];
  if (bridge.mgmtDetail) lines.push(`  management detail: ${bridge.mgmtDetail}`);
  if (bridge.probeDetail) lines.push(`  external probe detail: ${bridge.probeDetail}`);
  if (bridge.probeLevels) {
    const { ping, tcp, https } = bridge.probeLevels;
    lines.push(`  host checks: ping ${levelMark(ping)}, tcp/22 ${levelMark(tcp)}${https ? `, https ${levelMark(https)}` : ""}`);
  }
  for (const route of bridge.activeRoutes) {
    const observation = route.observedOnline === null ? "unknown" : route.observedOnline ? "online" : "offline";
    lines.push(`  ${route.nodeName}:${route.publicUdpPort} frpc: ${observation}${route.incidentOpen ? " (incident)" : ""}`);
  }
  return lines;
};

/** Settings and health, one fact per line. The API key is never shown. */
export const probeSummaryLines = (probe: NonNullable<AdminReachabilityView["probe"]>): string[] => [
  `label:          ${probe.label}`,
  `api url:        ${probe.apiBaseUrl}`,
  `enabled:        ${probe.enabled ? "yes" : "no"}`,
  `direct when bridged: ${probe.probeDirectWhenBridged ? "on" : "off"}`,
  `stealth:        ${probe.stealthMode === false ? "off" : "on"}`,
  `control url:    ${probe.controlUrl}`,
  `egress url:     ${probe.egressUrl}`,
  `every:          ${Math.round(probe.intervalSec / 60)}m`,
  `fail threshold: ${probe.failThreshold} run(s)`,
  `stale after:    ${Math.round(probe.staleAfterSec / 60)}m`,
  `time zone:      ${probe.timeZone}`,
  `last result:    ${probe.lastResultAt ?? "never"}${probe.stale ? "  (STALE)" : ""}`,
  `run in flight:  ${probe.runInFlight ? "yes" : "no"}`,
  `last error:     ${probe.lastError ? `${probe.lastError} (${probe.lastErrorAt ?? "?"})` : "—"}`,
  `tg widget:      ${probe.widgetLastError ? `error: ${probe.widgetLastError}` : probe.widgetUpdatedAt ? `updated ${probe.widgetUpdatedAt}` : "not sent"}`,
];

const intFlag = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
};

/**
 * The PUT body for `probe-set`. Required settings fall back to the registered
 * probe's values. Omitted mode flags leave the server's current values alone.
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
    timeZone?: string;
    enabled?: string;
    probeDirectWhenBridged?: string;
    stealthMode?: string;
  },
  current: AdminReachabilityView["probe"],
): Record<string, unknown> => {
  const label = flags.label ?? current?.label;
  const apiBaseUrl = flags.apiUrl ?? current?.apiBaseUrl;
  const controlUrl = flags.controlUrl ?? current?.controlUrl;
  if (!label || !apiBaseUrl || !controlUrl || (!current && !flags.apiKey)) {
    throw new Error(
      "Usage: probe-set --label= --api-url= --api-key-file=<path|-> --control-url= " +
        "[--egress-url=] [--interval-sec=3600] [--fail-threshold=2] [--stale-after-sec=10800] [--time-zone=UTC] [--enabled=on|off]",
    );
  }
  if (flags.enabled !== undefined && flags.enabled !== "on" && flags.enabled !== "off") {
    throw new Error("--enabled must be on or off");
  }
  for (const [name, value] of [["probe-direct-when-bridged", flags.probeDirectWhenBridged], ["stealth", flags.stealthMode]]) {
    if (value !== undefined && value !== "on" && value !== "off") throw new Error(`--${name} must be on or off`);
  }
  const body: Record<string, unknown> = {
    label,
    apiBaseUrl,
    controlUrl,
    egressUrl: flags.egressUrl ?? current?.egressUrl,
    intervalSec: intFlag(flags.intervalSec, "interval-sec") ?? current?.intervalSec,
    failThreshold: intFlag(flags.failThreshold, "fail-threshold") ?? current?.failThreshold,
    staleAfterSec: intFlag(flags.staleAfterSec, "stale-after-sec") ?? current?.staleAfterSec,
    timeZone: flags.timeZone ?? current?.timeZone,
    enabled: flags.enabled === undefined ? current?.enabled : flags.enabled === "on",
    probeDirectWhenBridged: flags.probeDirectWhenBridged === undefined ? undefined : flags.probeDirectWhenBridged === "on",
    stealthMode: flags.stealthMode === undefined ? undefined : flags.stealthMode === "on",
  };
  if (flags.apiKey) body.apiKey = flags.apiKey;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
};
