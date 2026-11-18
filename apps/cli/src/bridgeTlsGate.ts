import { addAbortSignal, type Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";

import type { BridgeRotationEvidence } from "@amnezia/contracts";

const USAGE = "Usage: bridge-tls-gate <bridge-id> <baseline|verify> [<since-UTC>] [--timeout-sec=180]";
const MAX_BASELINE_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 2_000;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);

type Route = BridgeRotationEvidence["routes"][number];
type RouteIdentity = Pick<Route, "id" | "nodeId" | "publicUdpPort" | "vpnEndpointRevision">;
type SnapshotRoute = RouteIdentity & { downloadRequired: boolean };
type Baseline = { version: 1; bridgeId: string; routes: SnapshotRoute[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRouteIdentity = (value: unknown): value is RouteIdentity => {
  if (!isRecord(value)) return false;
  const { id, nodeId, publicUdpPort, vpnEndpointRevision } = value;
  return isUuid(id) && isUuid(nodeId) && typeof publicUdpPort === "number" &&
    Number.isInteger(publicUdpPort) && publicUdpPort >= 1 && publicUdpPort <= 65535 &&
    typeof vpnEndpointRevision === "number" && Number.isSafeInteger(vpnEndpointRevision) && vpnEndpointRevision >= 0;
};

const isSnapshotRoute = (value: unknown): value is SnapshotRoute =>
  isRecord(value) && typeof value.downloadRequired === "boolean" && isRouteIdentity(value);

const routeIdentity = ({ id, nodeId, publicUdpPort, vpnEndpointRevision }: RouteIdentity) =>
  ({ id, nodeId, publicUdpPort, vpnEndpointRevision });

const routeTopology = (routes: readonly (Route | SnapshotRoute)[]) =>
  JSON.stringify(routes.map(routeIdentity).sort((a, b) => a.id.localeCompare(b.id)));

const activeRoutes = (evidence: BridgeRotationEvidence, bridgeId: string): Route[] => {
  if (evidence.bridgeId !== bridgeId) throw new Error("Received rotation evidence for a different bridge");
  if (!Array.isArray(evidence.routes) || evidence.routes.length > 500 || evidence.routes.some((route) =>
    !isRouteIdentity(route) || (route.state !== "active" && route.state !== "retiring"))) {
    throw new Error("Invalid bridge route topology in the Control API response");
  }
  if (evidence.routes.some(({ state }) => state === "retiring")) {
    throw new Error("Bridge has retiring routes that cannot be covered by the regular probe");
  }
  return evidence.routes.filter(({ state }) => state === "active");
};

const readBaseline = async (input: Readable, signal: AbortSignal): Promise<Baseline> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of addAbortSignal(signal, input)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > MAX_BASELINE_BYTES) throw new Error("The rotation baseline is too large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid rotation baseline input");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isUuid(parsed.bridgeId) ||
    !Array.isArray(parsed.routes) || parsed.routes.length > 500 || !parsed.routes.every(isSnapshotRoute)) {
    throw new Error("Invalid rotation baseline input");
  }
  return { version: 1, bridgeId: parsed.bridgeId, routes: parsed.routes };
};

const validateTraffic = (routes: Route[], prior?: ReadonlyMap<string, SnapshotRoute>): void => {
  for (const route of routes) {
    const { id, result } = route;
    if (result?.handshake !== true) throw new Error(`Route ${id} has no successful AWG handshake in the requested run`);
    if (result.http !== true) throw new Error(`Route ${id} has no successful HTTP through AWG in the requested run`);
    if ((result.download !== true && result.download !== null) ||
      (prior?.get(id)?.downloadRequired && result.download !== true)) {
      throw new Error(`Route ${id} has no successful HTTPS download in the requested run`);
    }
  }
};

const isRegistered = ({ registration }: Route, since: number | null): boolean =>
  registration?.status === "online" && typeof registration.marker === "string" && registration.marker.length > 0 &&
  typeof registration.observedAt === "string" && Date.parse(registration.observedAt) > (since ?? -Infinity);

export async function runBridgeTlsGate(args: string[], {
  api,
  input = process.stdin,
  output = console.log,
  sleep = (signal) => setTimeout(POLL_INTERVAL_MS, undefined, { signal }),
}: {
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  input?: Readable;
  output?: (line: string) => void;
  sleep?: (signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const [bridgeId, mode, ...rest] = args;
  const sinceText = mode === "verify" ? rest.shift() : undefined;
  if (!isUuid(bridgeId) ||
    (mode !== "baseline" && (mode !== "verify" || !sinceText))) {
    throw new Error(USAGE);
  }
  let since = null;
  if (sinceText !== undefined) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(sinceText) ||
      !Number.isFinite(Date.parse(sinceText))) throw new Error(USAGE);
    since = Date.parse(sinceText);
  }
  const [timeoutArg] = rest;
  const timeoutMatch = timeoutArg?.match(/^--timeout-sec=(\d{2,3})$/);
  const timeoutSec = timeoutMatch ? Number(timeoutMatch[1]) : 180;
  if (rest.length > 1 || (timeoutArg && !timeoutMatch) || timeoutSec < 30 || timeoutSec > 300) {
    throw new Error(USAGE);
  }
  const signal = AbortSignal.timeout(timeoutSec * 1_000);
  const baseline = mode === "verify" ? await readBaseline(input, signal) : null;
  if (baseline && baseline.bridgeId !== bridgeId) throw new Error("Baseline belongs to a different bridge");
  const prior = baseline ? new Map(baseline.routes.map((route) => [route.id, route])) : undefined;
  const expectedTopology = baseline ? routeTopology(baseline.routes) : null;
  const path = `/api/admin/vpn-bridges/${bridgeId}/rotation-evidence`;
  const readEvidence = async () => {
    const evidence = await api(path, { signal });
    if (!isRecord(evidence)) throw new Error("Invalid bridge rotation evidence in the Control API response");
    return evidence as BridgeRotationEvidence;
  };
  const first = await readEvidence();
  let routes = activeRoutes(first, bridgeId);
  const topology = routeTopology(routes);
  if (expectedTopology !== null && topology !== expectedTopology) throw new Error("Bridge route topology changed");

  if (routes.length > 0) {
    if (first.probeReady !== true) throw new Error("No enabled bridge-capable reachability probe");
    if (mode === "baseline" && !routes.every((route) => isRegistered(route, null))) {
      throw new Error("At least one active route lacks a current FRP registration");
    }
    const pollEvidence = async () => {
      signal.throwIfAborted();
      const evidence = await readEvidence();
      routes = activeRoutes(evidence, bridgeId);
      if (routeTopology(routes) !== topology) throw new Error("Bridge route topology changed");
      if (evidence.probeReady !== true) throw new Error("The bridge-capable reachability probe became unavailable");
      return evidence;
    };
    // TLS accepts connections before frpc has necessarily registered every
    // UDP proxy. Allow the fresh poll to see them before requesting AWG.
    while (!routes.every((route) => isRegistered(route, since))) {
      await sleep(signal);
      await pollEvidence();
    }
    const registrations = new Map(routes.map(({ id, registration }) => [id, registration.marker]));
    const reply = await api("/api/admin/reachability/run", { method: "POST", signal });
    if (!isRecord(reply) || !isUuid(reply.requestedRunId)) {
      throw new Error("The Control API cannot identify the newly requested probe run");
    }

    for (;;) {
      const evidence = await pollEvidence();
      const changed = routes.find(({ id, registration }) =>
        registration?.status !== "online" || registration.marker !== registrations.get(id));
      if (changed) throw new Error(`FRP registration changed during the probe run for route ${changed.id}`);
      if (evidence.latestRunId === reply.requestedRunId) {
        validateTraffic(routes, prior);
        if (routes.every((route) => isRegistered(route, since))) break;
      }
      await sleep(signal);
    }
  }

  if (mode === "baseline") {
    const token = JSON.stringify({
      version: 1,
      bridgeId,
      routes: routes.map((route) => ({
        ...routeIdentity(route),
        downloadRequired: route.result?.download === true,
      })),
    });
    if (Buffer.byteLength(token) + 1 > MAX_BASELINE_BYTES) throw new Error("The rotation baseline is too large");
    output(token);
  }
}
