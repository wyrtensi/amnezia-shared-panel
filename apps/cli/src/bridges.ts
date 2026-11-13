/**
 * Admin commands for optional AWG 3.1 node bridges and node routes.
 *
 * Everything goes through the Control API; the CLI never touches a bridge host
 * or a node over SSH. The commands take the API caller as a parameter so this
 * module does not import main.ts (which imports it). To add another bridge
 * command: write a `cmdBridge...` function here, add it to `BRIDGE_COMMANDS`,
 * and describe it in `BRIDGE_USAGE_LINES` and docs/CLI.md.
 *
 * Output carries typed non-secret fields only. Bridge responses never include
 * tokens; a `setupCommands` field is printed verbatim only when the API
 * returns it.
 */

import { lstat, writeFile } from "node:fs/promises";

import { flagOf, positionals } from "./args.js";

export type BridgeApi = <T>(path: string, init?: RequestInit) => Promise<T>;
/** A GET whose body is not JSON (a `.vpn` file), with its response headers. */
export type BridgeRawApi = (path: string) => Promise<{ body: Buffer; headers: Headers }>;

/** Same name and encoding as `BRIDGE_REGISTRATION_MARKER_HEADER` in @amnezia/contracts. */
export const REGISTRATION_MARKER_HEADER = "x-bridge-registration-marker";

type RouteState = "draft" | "active" | "retiring";

type BridgeRouteSummary = {
  id: string;
  nodeId: string;
  nodeName?: string;
  publicUdpPort: number;
  state: RouteState;
};

export type SetupCommands = { install?: string; dryRun?: string; remove?: string };

export type BridgeView = {
  id: string;
  name: string;
  publicIpv4: string;
  controlTcpPort: number;
  udpPortStart: number;
  udpPortEnd: number;
  capacity: number;
  heldPorts: number;
  managementStatus: string;
  lastObservedAt: string | null;
  routes: BridgeRouteSummary[];
  setupCommands?: SetupCommands | null;
};

export type NodeRouteView = {
  id: string;
  bridgeId: string;
  publicUdpPort: number;
  frpProxyName?: string | null;
  state: RouteState;
  bridgeName?: string;
  bridgePublicIpv4?: string;
  bridgeManagementStatus?: string;
  bridgeLastObservedAt?: string | null;
  setupCommands?: SetupCommands | null;
  observedOnline?: boolean | null;
  observedAt?: string | null;
  verificationResult?: string | null;
  verificationMethod?: string | null;
  verificationError?: string | null;
  verifiedAt?: string | null;
  activatedAt?: string | null;
  retiringSince?: string | null;
};

export type NodeRoutesView = {
  nodeId: string;
  vpnEndpointRevision: number;
  activeRoute: NodeRouteView | null;
  drafts: NodeRouteView[];
  retiring: NodeRouteView[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Write targets are UUIDs only: names are not unique and typos must not guess. */
export function requireUuid(value: string | undefined, what: string, usage: string): string {
  if (!value) throw new Error(usage);
  if (!UUID_RE.test(value)) {
    throw new Error(`${what} must be a UUID, got "${value}"\n${usage}`);
  }
  return value;
}

/** Parse an integer flag, or undefined when absent. Rejects junk instead of sending NaN. */
export function intFlag(args: string[], name: string): number | undefined {
  const raw = flagOf(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number, got "${raw}"`);
  return Number(raw);
}

const SETUP_KEYS = ["install", "dryRun", "remove"] as const;

function projectSetup(value: unknown): SetupCommands | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: SetupCommands = {};
  for (const key of SETUP_KEYS) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const nullable = <T>(value: T | null | undefined): T | null => value ?? null;

/** Explicit projection: only typed non-secret fields reach --json output. */
export function projectBridge(b: BridgeView): Record<string, unknown> {
  const setup = projectSetup(b.setupCommands);
  return {
    id: b.id,
    name: b.name,
    publicIpv4: b.publicIpv4,
    controlTcpPort: b.controlTcpPort,
    udpPortStart: b.udpPortStart,
    udpPortEnd: b.udpPortEnd,
    capacity: b.capacity,
    heldPorts: b.heldPorts,
    managementStatus: b.managementStatus,
    lastObservedAt: nullable(b.lastObservedAt),
    routes: b.routes.map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      nodeName: nullable(r.nodeName),
      publicUdpPort: r.publicUdpPort,
      state: r.state,
    })),
    ...(setup ? { setupCommands: setup } : {}),
  };
}

export function projectRoute(r: NodeRouteView): Record<string, unknown> {
  const setup = projectSetup(r.setupCommands);
  return {
    id: r.id,
    bridgeId: r.bridgeId,
    publicUdpPort: r.publicUdpPort,
    frpProxyName: nullable(r.frpProxyName),
    state: r.state,
    bridgeName: nullable(r.bridgeName),
    bridgePublicIpv4: nullable(r.bridgePublicIpv4),
    bridgeManagementStatus: nullable(r.bridgeManagementStatus),
    bridgeLastObservedAt: nullable(r.bridgeLastObservedAt),
    observedOnline: nullable(r.observedOnline),
    observedAt: nullable(r.observedAt),
    verificationMethod: nullable(r.verificationMethod),
    verificationResult: nullable(r.verificationResult),
    verificationError: nullable(r.verificationError),
    verifiedAt: nullable(r.verifiedAt),
    activatedAt: nullable(r.activatedAt),
    retiringSince: nullable(r.retiringSince),
    ...(setup ? { setupCommands: setup } : {}),
  };
}

export function projectNodeRoutes(v: NodeRoutesView): Record<string, unknown> {
  return {
    nodeId: v.nodeId,
    vpnEndpointRevision: v.vpnEndpointRevision,
    activeRoute: v.activeRoute ? projectRoute(v.activeRoute) : null,
    drafts: v.drafts.map(projectRoute),
    retiring: v.retiring.map(projectRoute),
  };
}

/**
 * Reject what the parser would otherwise drop silently: a known value flag
 * written `--port 41005` (no `=`), unknown flags, and surplus positionals.
 */
export function assertStrictArgs(
  args: string[],
  opts: { positionals: number; valueFlags?: string[]; boolFlags?: string[]; usage: string },
): void {
  const valueFlags = opts.valueFlags ?? [];
  const boolFlags = ["confirm", "json", ...(opts.boolFlags ?? [])];
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=")[0]!;
    if (valueFlags.includes(name)) {
      if (!arg.includes("=")) {
        throw new Error(`--${name} needs a value written as --${name}=<value>\n${opts.usage}`);
      }
    } else if (boolFlags.includes(name)) {
      if (arg.includes("=")) throw new Error(`--${name} takes no value\n${opts.usage}`);
    } else {
      throw new Error(`Unknown flag ${arg}\n${opts.usage}`);
    }
  }
  const extra = positionals(args);
  if (extra.length > opts.positionals) {
    throw new Error(`Unexpected argument "${extra[opts.positionals]}"\n${opts.usage}`);
  }
}

const BRIDGE_ERROR_HINTS: Record<string, string> = {
  BRIDGE_HAS_ROUTES:
    "The bridge still holds routes (draft, active or retiring). Release them with bridge-route-release first.",
  BRIDGE_ROUTE_ACTIVE:
    "That route is the node's active endpoint. Switch the node to another route or Direct first (bridge-route-direct).",
  BRIDGE_OBSERVATION_STALE:
    "The bridge has no fresh observation proving the state of this route. Wait for the bridge agent to report, then retry.",
  BRIDGE_REVISION_CONFLICT:
    "The node's endpoint changed since it was read. Re-run bridge-routes to see the current revision and try again.",
  BRIDGE_ROUTE_UNVERIFIED:
    "The route has no successful verification within the last 30 minutes for the observed registration. Verify it first.",
  BRIDGE_NODE_NOT_AWG31:
    "Only nodes serving AWG 3.1 can use a bridge route.",
  BRIDGE_NOT_FOUND: "No bridge with that id.",
  BRIDGE_ROUTE_NOT_FOUND:
    "No route with that id. Use bridge-routes <node-id> to list a node's routes; activation needs a route id from the bridge registry.",
  BRIDGE_IPV4_CONFLICT: "A bridge with that public IPv4 is already registered.",
  BRIDGE_ROUTE_PAIR_CONFLICT:
    "That node already holds a route on this bridge with a different port. Omit --port to reuse it.",
  BRIDGE_PORT_OUT_OF_RANGE: "The port is outside the bridge's UDP range.",
  BRIDGE_PORT_TAKEN: "That UDP port is already held on this bridge.",
  BRIDGE_POOL_EXHAUSTED: "The bridge has no free UDP port left in its range.",
  NODE_HAS_BRIDGE_ROUTES: "The node still holds bridge routes; release them first.",
  BRIDGE_JOBS_DISABLED:
    "Bridge jobs are disabled on this panel (VPN_BRIDGE_JOBS_ENABLED). Use --operator-verified --registration=<marker> instead.",
  BRIDGE_UNSUPPORTED_CAPABILITY:
    "No probe with the bridge-measurement capability is configured. Test the route with bridge-route-test-config, then use --operator-verified --registration=<marker>.",
  BRIDGE_TEST_KEY_WRONG_NODE:
    "The test key must be one of your own keys on the route's VPN node.",
  BRIDGE_TEST_KEY_UNSUITABLE:
    "The test key must be one of your own active AWG 3.1 keys (not AWG 2 and not the 2.0 fallback).",
};

/** One readable line appended to the API error for a known bridge error code. */
export function bridgeErrorHint(code: string | undefined): string | undefined {
  return code ? BRIDGE_ERROR_HINTS[code] : undefined;
}

const show = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === "" ? "—" : String(value);

function describeRoute(route: NodeRouteView): string {
  const target = `${show(route.bridgePublicIpv4)}:${route.publicUdpPort}`;
  const verified =
    route.verificationResult === "success"
      ? `verified ${show(route.verifiedAt)} (${show(route.verificationMethod)})`
      : route.verificationResult
        ? `verification ${route.verificationResult}${route.verificationError ? ` (${route.verificationError})` : ""}`
        : "not verified";
  const observed =
    route.observedOnline === true
      ? "online"
      : route.observedOnline === false
        ? "absent"
        : "unobserved";
  return `${route.id}  ${route.state}  ${show(route.bridgeName)} ${target}  proxy=${show(route.frpProxyName)}  ${observed}  ${verified}`;
}

/** Pure renderer for `bridge-routes`, kept separate so it is testable. */
export function renderNodeRoutes(view: NodeRoutesView): string[] {
  const lines = [
    `node ${view.nodeId}  endpoint revision ${view.vpnEndpointRevision}`,
    view.activeRoute
      ? `active: ${describeRoute(view.activeRoute)}`
      : "active: Direct (no bridge route)",
  ];
  lines.push(`drafts (${view.drafts.length}):`);
  for (const route of view.drafts) lines.push(`  ${describeRoute(route)}`);
  lines.push(`retiring (${view.retiring.length}):`);
  for (const route of view.retiring) lines.push(`  ${describeRoute(route)}`);
  return lines;
}

function renderBridgeTable(bridges: BridgeView[]): string[] {
  if (bridges.length === 0) return ["(no bridges)"];
  const header = ["id", "name", "ipv4", "mgmt", "ports", "routes", "observed"];
  const rows = bridges.map((bridge) => [
    bridge.id,
    bridge.name,
    bridge.publicIpv4,
    bridge.managementStatus,
    `${bridge.heldPorts}/${bridge.capacity}`,
    String(bridge.routes.length),
    show(bridge.lastObservedAt),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(header), ...rows.map(fmt)];
}

function printBridge(bridge: BridgeView): void {
  console.log(`bridge: ${bridge.name} (${bridge.id})`);
  console.log(
    `  ${bridge.publicIpv4}  control tcp ${bridge.controlTcpPort}  udp ${bridge.udpPortStart}-${bridge.udpPortEnd}  status ${bridge.managementStatus}`,
  );
  const setup = projectSetup(bridge.setupCommands);
  if (setup) {
    console.log("setup commands (run them on the bridge host yourself; copy infra/bridge/ to /opt/amnezia-bridge/ first):");
    for (const key of SETUP_KEYS) if (setup[key]) console.log(`  ${key}: ${setup[key]}`);
  }
}

const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const confirmed = (args: string[]) => args.includes("--confirm");

function preview(lines: string[]): void {
  for (const line of lines) console.log(line);
  console.log("Nothing was changed. Re-run with --confirm to apply it.");
}

export async function cmdBridges(api: BridgeApi, args: string[]): Promise<void> {
  assertStrictArgs(args, { positionals: 0, usage: "Usage: bridges [--json]" });
  const bridges = await api<BridgeView[]>("/api/admin/vpn-bridges");
  if (args.includes("--json")) return json(bridges.map(projectBridge));
  for (const line of renderBridgeTable(bridges)) console.log(line);
}

export async function cmdBridgeAdd(api: BridgeApi, args: string[]): Promise<void> {
  const usage =
    "Usage: bridge-add --name=<name> --ipv4=<public ipv4> [--control-port=7000] [--udp-start=41000] [--udp-end=41031] --confirm";
  assertStrictArgs(args, { positionals: 0, valueFlags: ["name", "ipv4", "control-port", "udp-start", "udp-end"], usage });
  const name = flagOf(args, "name");
  const publicIpv4 = flagOf(args, "ipv4");
  if (!name || !publicIpv4) throw new Error(usage);
  const body: Record<string, unknown> = { name, publicIpv4 };
  const controlPort = intFlag(args, "control-port");
  const udpStart = intFlag(args, "udp-start");
  const udpEnd = intFlag(args, "udp-end");
  if (controlPort !== undefined) body.controlTcpPort = controlPort;
  if (udpStart !== undefined) body.udpPortStart = udpStart;
  if (udpEnd !== undefined) body.udpPortEnd = udpEnd;
  if (!confirmed(args)) {
    return preview([
      `Would register bridge "${name}" at ${publicIpv4}` +
        (controlPort !== undefined ? ` control tcp ${controlPort}` : "") +
        (udpStart !== undefined || udpEnd !== undefined
          ? ` udp ${udpStart ?? "default"}-${udpEnd ?? "default"}`
          : "") +
        " (metadata only; nothing is installed on the host).",
    ]);
  }
  const bridge = await api<BridgeView>("/api/admin/vpn-bridges", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (args.includes("--json")) return json(projectBridge(bridge));
  printBridge(bridge);
}

export async function cmdBridgeDelete(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-delete <bridge-id> --confirm";
  assertStrictArgs(args, { positionals: 1, usage });
  const id = requireUuid(positionals(args)[0], "bridge-id", usage);
  if (!confirmed(args)) {
    return preview([`Would delete bridge ${id} (refused by the API while it holds routes).`]);
  }
  await api(`/api/admin/vpn-bridges/${id}`, { method: "DELETE" });
  console.log(`bridge ${id} deleted`);
}

export async function cmdBridgeRoutes(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-routes <node-id> [--json]";
  assertStrictArgs(args, { positionals: 1, usage });
  const nodeId = requireUuid(positionals(args)[0], "node-id", usage);
  const view = await api<NodeRoutesView>(`/api/admin/nodes/${nodeId}/vpn-bridge-routes`);
  if (args.includes("--json")) return json(projectNodeRoutes(view));
  for (const line of renderNodeRoutes(view)) console.log(line);
}

export async function cmdBridgeRoutePrepare(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-route-prepare <node-id> <bridge-id> [--port=<udp port>] --confirm";
  assertStrictArgs(args, { positionals: 2, valueFlags: ["port"], usage });
  const [rawNode, rawBridge] = positionals(args);
  const nodeId = requireUuid(rawNode, "node-id", usage);
  const bridgeId = requireUuid(rawBridge, "bridge-id", usage);
  const port = intFlag(args, "port");
  if (!confirmed(args)) {
    return preview([
      `Would reserve a bridge UDP port (${port !== undefined ? `requested ${port}` : "first free"}) on bridge ${bridgeId} for node ${nodeId}.`,
    ]);
  }
  const body: Record<string, unknown> = { bridgeId };
  if (port !== undefined) body.publicUdpPort = port;
  const result = await api<{ created: boolean; route: NodeRouteView }>(
    `/api/admin/nodes/${nodeId}/vpn-bridge-routes`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (args.includes("--json")) {
    return json({ created: result.created, route: projectRoute(result.route) });
  }
  const { route } = result;
  console.log(result.created ? "route reserved:" : "route already held (unchanged):");
  console.log(`  id ${route.id}`);
  console.log(`  bridge ${show(route.bridgePublicIpv4)} (${show(route.bridgeName)})`);
  console.log(`  public udp port ${route.publicUdpPort}`);
  console.log(`  proxy name ${show(route.frpProxyName)}`);
  console.log(`  state ${route.state}`);
  const setup = projectSetup(route.setupCommands);
  if (setup) {
    console.log("setup commands (run them on the node host yourself):");
    for (const key of SETUP_KEYS) if (setup[key]) console.log(`  ${key}: ${setup[key]}`);
    console.log("  The helper detects the local AWG port. If it asks, append --local-udp-port <udp> and/or --local-ip <ipv4> to install.");
    console.log("  An existing node gets install-frpc.sh by re-running scripts/add-node.sh (it re-syncs infra/node).");
  }
}

/**
 * Find the node a route belongs to using only the bridge list, which carries
 * `nodeId` for each route. No node scan and no extra endpoint.
 */
async function findRouteNode(
  api: BridgeApi,
  routeId: string,
): Promise<{ nodeId: string; nodeName?: string; publicUdpPort: number; state: RouteState }> {
  const bridges = await api<BridgeView[]>("/api/admin/vpn-bridges");
  for (const bridge of bridges) {
    const route = bridge.routes.find((candidate) => candidate.id === routeId);
    if (route) return route;
  }
  throw new Error(
    `BRIDGE_ROUTE_NOT_FOUND: no route ${routeId} in the bridge registry\n${BRIDGE_ERROR_HINTS.BRIDGE_ROUTE_NOT_FOUND}`,
  );
}

async function patchEndpoint(
  api: BridgeApi,
  nodeId: string,
  routeId: string | null,
): Promise<{ vpnEndpoint?: { changed: boolean; vpnEndpointRevision: number } }> {
  const current = await api<NodeRoutesView>(`/api/admin/nodes/${nodeId}/vpn-bridge-routes`);
  return api(`/api/admin/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify({
      vpnBridgeRouteId: routeId,
      expectedVpnEndpointRevision: current.vpnEndpointRevision,
    }),
  });
}

function printEndpointResult(
  result: { vpnEndpoint?: { changed: boolean; vpnEndpointRevision: number } },
  target: string,
): void {
  const endpoint = result.vpnEndpoint;
  if (!endpoint) {
    console.log(`node endpoint set to ${target}`);
  } else if (endpoint.changed) {
    console.log(`node endpoint is now ${target} (revision ${endpoint.vpnEndpointRevision})`);
  } else {
    console.log(`node endpoint already ${target}; no change (revision ${endpoint.vpnEndpointRevision})`);
  }
}

export async function cmdBridgeRouteActivate(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-route-activate <route-id> --confirm";
  assertStrictArgs(args, { positionals: 1, usage });
  const routeId = requireUuid(positionals(args)[0], "route-id", usage);
  const route = await findRouteNode(api, routeId);
  if (!confirmed(args)) {
    return preview([
      `Would switch node ${route.nodeId}${route.nodeName ? ` (${route.nodeName})` : ""} to route ${routeId} (public udp port ${route.publicUdpPort}).`,
      "The API refuses it without a fresh observation and a recent verification of the route.",
    ]);
  }
  const result = await patchEndpoint(api, route.nodeId, routeId);
  printEndpointResult(result, `route ${routeId}`);
}

export async function cmdBridgeRouteDirect(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-route-direct <node-id> --confirm";
  assertStrictArgs(args, { positionals: 1, usage });
  const nodeId = requireUuid(positionals(args)[0], "node-id", usage);
  if (!confirmed(args)) {
    return preview([`Would switch node ${nodeId} back to Direct (no bridge route).`]);
  }
  const result = await patchEndpoint(api, nodeId, null);
  printEndpointResult(result, "Direct");
}

export async function cmdBridgeRouteRelease(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-route-release <route-id> --confirm";
  assertStrictArgs(args, { positionals: 1, usage });
  const routeId = requireUuid(positionals(args)[0], "route-id", usage);
  if (!confirmed(args)) {
    return preview([
      `Would release route ${routeId} and free its bridge UDP port (refused while it is the node's active endpoint).`,
    ]);
  }
  const result = await api<{ publicUdpPort: number; nodeId: string; bridgeId: string }>(
    `/api/admin/vpn-bridge-routes/${routeId}?confirmed=true`,
    { method: "DELETE" },
  );
  console.log(`route ${routeId} released (udp port ${result.publicUdpPort} is free again)`);
}

/** Read the marker header the way the API writes it; null when absent or unreadable. */
export function registrationMarkerOf(headers: Headers): string | null {
  const raw = headers.get(REGISTRATION_MARKER_HEADER);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

export async function cmdBridgeRouteTestConfig(
  _api: BridgeApi,
  args: string[],
  raw?: BridgeRawApi,
): Promise<void> {
  const usage = "Usage: bridge-route-test-config <route-id> --key=<key-id> --out=<path>";
  assertStrictArgs(args, { positionals: 1, valueFlags: ["key", "out"], usage });
  const routeId = requireUuid(positionals(args)[0], "route-id", usage);
  const keyId = requireUuid(flagOf(args, "key"), "--key", usage);
  const out = flagOf(args, "out");
  if (!out) throw new Error(usage);
  if (!raw) throw new Error("bridge-route-test-config needs the raw download path");
  // Fail before the request when the file is already there; the exclusive
  // create below is the real guard against a file appearing meanwhile.
  const existing = await lstat(out).catch(() => null);
  if (existing) throw new Error(`Refusing to overwrite ${out}; choose a new --out path`);
  const { body, headers } = await raw(
    `/api/admin/vpn-bridge-routes/${routeId}/test-config?keyId=${encodeURIComponent(keyId)}`,
  );
  try {
    // The file grants VPN access: owner-only, created fresh, never printed.
    await writeFile(out, body, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite ${out}; choose a new --out path`, { cause: error });
    }
    throw error;
  }
  console.log(`${out} (${body.length} bytes, mode 0600): test config with the draft endpoint of route ${routeId}`);
  const marker = registrationMarkerOf(headers);
  if (marker) {
    console.log(`registration marker: ${marker}`);
    console.log(
      `After a real AWG handshake and HTTP check from a client network: bridge-route-verify ${routeId} --operator-verified --registration=${shellQuote(marker)} --confirm`,
    );
  } else {
    console.error(
      "warning: no frps registration has been observed for this route yet, so there is no marker to verify against; activation needs a fresh observation.",
    );
  }
}

type VerifyResult =
  | { method: "probe"; routeId: string; jobId: string; queued: boolean; registrationMarker: string }
  | { method: "operator"; routeId: string; route: NodeRouteView };

export async function cmdBridgeRouteVerify(api: BridgeApi, args: string[]): Promise<void> {
  const usage =
    "Usage: bridge-route-verify <route-id> [--operator-verified --registration=<marker>] --confirm";
  assertStrictArgs(args, {
    positionals: 1,
    valueFlags: ["registration"],
    boolFlags: ["operator-verified"],
    usage,
  });
  const routeId = requireUuid(positionals(args)[0], "route-id", usage);
  const operator = args.includes("--operator-verified");
  const registration = flagOf(args, "registration");
  if (operator && !registration) {
    throw new Error(`--operator-verified needs --registration=<marker> (printed by bridge-route-test-config)\n${usage}`);
  }
  if (!operator && registration !== undefined) {
    throw new Error(`--registration is only used with --operator-verified\n${usage}`);
  }
  if (!confirmed(args)) {
    return preview([
      operator
        ? `Would record that you saw a real AWG handshake and HTTP through route ${routeId} for registration ${registration ?? ""}.`
        : `Would queue an external probe check of route ${routeId} for its currently observed registration.`,
    ]);
  }
  const body = operator
    ? { method: "operator", registrationMarker: registration, confirmHandshakeAndHttp: true }
    : { method: "probe" };
  const result = await api<VerifyResult>(`/api/admin/vpn-bridge-routes/${routeId}/verify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (result.method === "probe") {
    if (args.includes("--json")) {
      return json({
        method: result.method,
        routeId: result.routeId,
        jobId: result.jobId,
        queued: result.queued,
        registrationMarker: result.registrationMarker,
      });
    }
    console.log(
      `${result.queued ? "probe check queued" : "probe check already pending"} (job ${result.jobId}) for registration ${result.registrationMarker}`,
    );
    console.log("The result appears in bridge-routes <node-id> once the probe run finishes.");
    return;
  }
  if (args.includes("--json")) {
    return json({ method: result.method, routeId: result.routeId, route: projectRoute(result.route) });
  }
  console.log(`route ${result.routeId} verified by operator: ${describeRoute(result.route)}`);
}

/** Dispatch table; main.ts routes every `bridge*` command through it. */
export const BRIDGE_COMMANDS: ReadonlyMap<
  string,
  (api: BridgeApi, args: string[], raw?: BridgeRawApi) => Promise<void>
> = new Map([  ["bridges", cmdBridges],
  ["bridge-add", cmdBridgeAdd],
  ["bridge-delete", cmdBridgeDelete],
  ["bridge-routes", cmdBridgeRoutes],
  ["bridge-route-prepare", cmdBridgeRoutePrepare],
  ["bridge-route-activate", cmdBridgeRouteActivate],
  ["bridge-route-direct", cmdBridgeRouteDirect],
  ["bridge-route-release", cmdBridgeRouteRelease],
  ["bridge-route-test-config", cmdBridgeRouteTestConfig],
  ["bridge-route-verify", cmdBridgeRouteVerify],
]);

export const BRIDGE_USAGE_LINES = `  bridges [--json]                        List AWG 3.1 bridges: management state, ports
                                          held/total, route count
  bridge-add --name= --ipv4= [--control-port=7000] [--udp-start=41000]
             [--udp-end=41031] --confirm  Register a bridge (metadata only; nothing is
                                          installed on the host)
  bridge-delete <bridge-id> --confirm     Delete an empty bridge (BRIDGE_HAS_ROUTES otherwise)
  bridge-routes <node-id> [--json]        A node's endpoint: Direct or active route, revision,
                                          drafts, retiring ports, verification state
  bridge-route-prepare <node-id> <bridge-id> [--port=<udp>] --confirm
                                          Reserve a bridge UDP port for a node
  bridge-route-activate <route-id> --confirm
                                          Switch the route's node onto it (needs a fresh
                                          observation and a verification < 30 min old)
  bridge-route-direct <node-id> --confirm Switch a node back to Direct
  bridge-route-release <route-id> --confirm
                                          Free a non-active route's port
  bridge-route-test-config <route-id> --key=<key-id> --out=<path>
                                          Download your own AWG 3.1 key on the route's node
                                          with the draft endpoint to a new 0600 file; prints
                                          the registration marker (never overwrites)
  bridge-route-verify <route-id> --confirm
                                          Queue an external probe check of a draft or
                                          retiring route
  bridge-route-verify <route-id> --operator-verified --registration=<marker> --confirm
                                          Record that you saw a real AWG handshake and HTTP
                                          through the route for that registration
`;
