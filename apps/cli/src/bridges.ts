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

import { statSync } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";

import { resolveSecret } from "./apiKey.js";
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
  registration?: { status: string; marker?: string | null; observedAt?: string | null };
  verification?: RouteVerificationView;
};

/** `candidate` (draft/retiring) or `awg_path` (active, the node's regular AWG 3.1 result). */
type RouteVerificationView = {
  kind?: string;
  status: string;
  method?: string | null;
  verifiedAt?: string | null;
  checkedAt?: string | null;
  error?: string | null;
};

function projectVerification(v: RouteVerificationView | undefined): Record<string, unknown> {
  if (v?.kind === "awg_path") {
    return { kind: "awg_path", status: v.status, checkedAt: nullable(v.checkedAt) };
  }
  return {
    kind: "candidate",
    status: v?.status ?? "none",
    method: nullable(v?.method),
    verifiedAt: nullable(v?.verifiedAt),
    error: nullable(v?.error),
  };
}

export type SetupCommands = {
  install?: string;
  dryRun?: string;
  remove?: string;
  /** The digest-pinned image already in the bridge commands; null when none is available. */
  agentImage?: string | null;
};

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
  management?: BridgeManagementView | null;
  routes: BridgeRouteSummary[];
  setupCommands?: SetupCommands | null;
};

/** Enrollment state and the agent's last report; the API never sends the credential. */
export type BridgeManagementView = {
  apiUrl?: string | null;
  enrolled?: boolean;
  enrolledAt?: string | null;
  agentVersion?: string | null;
  agentApiVersion?: number | null;
  agentCapabilities?: string[] | null;
  frpsVersion?: string | null;
  frpsReachable?: boolean | null;
  lastErrorCode?: string | null;
  lastPollAttemptAt?: string | null;
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
  registration?: { status: string; marker?: string | null; observedAt?: string | null };
  verification?: RouteVerificationView;
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

export type AgentUpdateOperationView = {
  operationId: string;
  state: string;
  requestedDigest: string;
  requestedVersion?: string | null;
  fromVersion?: string | null;
  requestedAt: string;
  sentAt?: string | null;
  acknowledgedAt?: string | null;
  lastCheckedAt?: string | null;
  contactLostSince?: string | null;
  errorCode?: string | null;
  result?: { finishedAt: string; errorCode: string | null } | null;
};

export type AgentUpdateView = {
  bridgeId: string;
  enrolled: boolean;
  installedVersion: string | null;
  updateSupported: boolean;
  jobsEnabled: boolean;
  offered: Array<{ image: string; repository: string; version: string; digest: string }>;
  operation: AgentUpdateOperationView | null;
  history: AgentUpdateOperationView[];
};

/** Explicit projection: the bounded operation fields, nothing else. */
export function projectAgentUpdateOperation(
  o: AgentUpdateOperationView | null | undefined,
): Record<string, unknown> | null {
  if (!o) return null;
  return {
    operationId: o.operationId,
    state: o.state,
    requestedDigest: o.requestedDigest,
    requestedVersion: nullable(o.requestedVersion),
    fromVersion: nullable(o.fromVersion),
    requestedAt: o.requestedAt,
    sentAt: nullable(o.sentAt),
    acknowledgedAt: nullable(o.acknowledgedAt),
    lastCheckedAt: nullable(o.lastCheckedAt),
    contactLostSince: nullable(o.contactLostSince),
    errorCode: nullable(o.errorCode),
    result: o.result ? { finishedAt: o.result.finishedAt, errorCode: nullable(o.result.errorCode) } : null,
  };
}

export function projectAgentUpdate(v: AgentUpdateView): Record<string, unknown> {
  return {
    bridgeId: v.bridgeId,
    enrolled: v.enrolled,
    installedVersion: nullable(v.installedVersion),
    updateSupported: v.updateSupported,
    jobsEnabled: v.jobsEnabled,
    offered: v.offered.map((o) => ({
      image: o.image,
      repository: o.repository,
      version: o.version,
      digest: o.digest,
    })),
    operation: projectAgentUpdateOperation(v.operation),
    history: v.history.map((o) => projectAgentUpdateOperation(o)),
  };
}

/** One readable line per operation; lost contact and a timeout are named, not hidden. */
export function describeAgentUpdateOperation(o: AgentUpdateOperationView): string[] {
  const lines = [
    `  ${o.operationId}  ${o.state}  ${show(o.fromVersion)} -> ${show(o.requestedVersion)}  requested ${o.requestedAt}`,
  ];
  if (o.state === "pickup_timeout") {
    lines.push(
      "    The host never acknowledged the request in time. It is not retried automatically: check the bridge host's updater (systemctl status amnezia-bridge-agent-update.path), then request again.",
    );
  }
  if (o.contactLostSince) {
    lines.push(
      `    management contact lost since ${o.contactLostSince} (expected while the agent is replaced; waiting for the host's result)`,
    );
  }
  if (o.errorCode) lines.push(`    code: ${o.errorCode}`);
  if (o.result) lines.push(`    finished ${o.result.finishedAt}`);
  return lines;
}

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
  const image = (value as Record<string, unknown>).agentImage;
  if (typeof image === "string" || image === null) out.agentImage = image;
  return Object.keys(out).length > 0 ? out : undefined;
}

const nullable = <T>(value: T | null | undefined): T | null => value ?? null;

/** The agent's enrollment and last report. The management URL is an internal address and is left out. */
function projectManagement(m: BridgeManagementView | null | undefined): Record<string, unknown> {
  return {
    enrolled: m?.enrolled ?? false,
    enrolledAt: nullable(m?.enrolledAt),
    agentVersion: nullable(m?.agentVersion),
    agentApiVersion: nullable(m?.agentApiVersion),
    agentCapabilities: nullable(m?.agentCapabilities),
    frpsVersion: nullable(m?.frpsVersion),
    frpsReachable: nullable(m?.frpsReachable),
    lastErrorCode: nullable(m?.lastErrorCode),
    lastPollAttemptAt: nullable(m?.lastPollAttemptAt),
  };
}

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
    management: projectManagement(b.management),
    routes: b.routes.map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      nodeName: nullable(r.nodeName),
      publicUdpPort: r.publicUdpPort,
      state: r.state,
      registration: {
        status: r.registration?.status ?? "unknown",
        marker: nullable(r.registration?.marker),
        observedAt: nullable(r.registration?.observedAt),
      },
      verification: projectVerification(r.verification),
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
    registration: {
      status: r.registration?.status ?? "unknown",
      marker: nullable(r.registration?.marker),
      observedAt: nullable(r.registration?.observedAt),
    },
    verification: projectVerification(r.verification),
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
    "No probe with the bridge-measurement capability is configured. Test the route with bridge-route-test-config, then use --operator-verified --registration=<marker>. (For bridge-enroll: the agent must speak management API v1 with the status.v1 capability. For bridge-agent-update: the installed agent does not report update.v1; update it on the host once.)",
  BRIDGE_MANAGEMENT_URL_NOT_ALLOWED:
    "The panel may only reach hosts listed in VPN_BRIDGE_MANAGEMENT_HOSTS (default host.docker.internal; host:port entries pin the port). Use the forwarded address from the bridge host setup.",
  BRIDGE_IDENTITY_MISMATCH:
    "The agent at that address reports a different bridge id. Check the SSH forwarding port and the bridge id passed to the installer.",
  BRIDGE_AGENT_UNAUTHORIZED:
    "The agent rejected the API key. Re-read the token file on the bridge host and pipe it in with --api-key-file=-.",
  BRIDGE_AGENT_UNREACHABLE:
    "The agent did not answer. Check that its compose service is running and the SSH forwarding to the bridge host is up.",
  BRIDGE_UPDATE_IN_PROGRESS:
    "Another update of this bridge's agent is outstanding. Follow it with bridge-agent-log <bridge-id>; a request for the same image returns it.",
  BRIDGE_UPDATE_NOT_OFFERED:
    "The panel offers no such image. Run bridge-agent-update <bridge-id> to see the approved image (BRIDGE_AGENT_IMAGE_REPOSITORY on the panel, resolved by the worker).",
  BRIDGE_UPDATE_NOT_ENROLLED:
    "The bridge has no enrolled management endpoint. Run bridge-enroll first.",
  BRIDGE_CHECK_PENDING:
    "A probe check for an older registration of this route is still queued or running. Wait until bridge-routes shows its result, then ask again.",
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
  // The API computes registration and verification (unknown when stale or
  // uncovered); the stored-field fallback only serves an older API.
  const verification = route.verification;
  const verified =
    verification?.kind === "awg_path"
      ? `awg path ${verification.status}${verification.checkedAt ? ` (checked ${verification.checkedAt})` : ""}`
      : verification
        ? `verification ${verification.status}${verification.verifiedAt ? ` ${verification.verifiedAt}` : ""}${verification.method ? ` (${verification.method})` : ""}${verification.error ? ` (${verification.error})` : ""}`
        : route.verificationResult === "success"
          ? `verified ${show(route.verifiedAt)} (${show(route.verificationMethod)})`
          : route.verificationResult
            ? `verification ${route.verificationResult}${route.verificationError ? ` (${route.verificationError})` : ""}`
            : "not verified";
  const observed = route.registration
    ? route.registration.status === "offline"
      ? "absent"
      : route.registration.status
    : route.observedOnline === true
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

function describeFrps(m: BridgeManagementView | null | undefined): string {
  if (!m || m.frpsReachable === null || m.frpsReachable === undefined) return "—";
  return m.frpsReachable ? show(m.frpsVersion) : "unreachable";
}

function renderBridgeTable(bridges: BridgeView[]): string[] {
  if (bridges.length === 0) return ["(no bridges)"];
  const header = ["id", "name", "ipv4", "mgmt", "agent", "frps", "ports", "routes", "observed"];
  const rows = bridges.map((bridge) => [
    bridge.id,
    bridge.name,
    bridge.publicIpv4,
    bridge.managementStatus,
    show(bridge.management?.agentVersion),
    describeFrps(bridge.management),
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
    console.log(
      setup.agentImage
        ? `  The commands carry the approved bridge-agent image (${setup.agentImage}).`
        : "  No approved bridge-agent image is available (set BRIDGE_AGENT_IMAGE_REPOSITORY on the panel and publish a bridge-agent release). Without --agent-image <name@sha256:digest> only frps is installed (exit 60).",
    );
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

/** Seams for tests: how the key is read and how its permissions are inspected. */
export type EnrollDeps = {
  readFile?: (path: string) => string;
  /** Permission bits of a key file; undefined skips the check (stdin, non-POSIX hosts). */
  fileMode?: (path: string) => number | undefined;
};

const defaultFileMode = (path: string): number | undefined =>
  process.platform === "win32" ? undefined : statSync(path).mode & 0o777;

export async function cmdBridgeEnroll(
  api: BridgeApi,
  args: string[],
  _raw?: BridgeRawApi,
  deps: EnrollDeps = {},
): Promise<void> {
  const usage =
    "Usage: bridge-enroll <bridge-id> --api-url=<http://host.docker.internal:PORT> --api-key-file=<path|-> --confirm";
  assertStrictArgs(args, { positionals: 1, valueFlags: ["api-url", "api-key-file"], usage });
  const id = requireUuid(positionals(args)[0], "bridge-id", usage);
  const managementApiUrl = flagOf(args, "api-url");
  const keyFile = flagOf(args, "api-key-file");
  if (!managementApiUrl || !keyFile) throw new Error(usage);
  if (!confirmed(args)) {
    // Nothing is read here: a preview must not consume stdin or touch the key.
    return preview([
      `Would enroll bridge ${id} with management API ${managementApiUrl}, reading the key from ${keyFile === "-" ? "stdin" : keyFile}.`,
      "The panel checks the agent's bridge id and status capability before it stores the key encrypted.",
    ]);
  }
  if (keyFile !== "-") {
    const mode = (deps.fileMode ?? defaultFileMode)(keyFile);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      throw new Error(
        `API key file ${keyFile} is accessible by group or others (mode ${mode.toString(8)}); run chmod 600 on it or pipe it with --api-key-file=-`,
      );
    }
  }
  const apiKey = resolveSecret(args, "api-key", deps.readFile);
  if (!apiKey) throw new Error(usage);
  const bridge = await api<BridgeView>(`/api/admin/vpn-bridges/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ managementApiUrl, apiKey }),
  });
  // Identity and capabilities only: no URL, no key, no setup commands.
  const m = bridge.management;
  const summary = {
    id: bridge.id,
    name: bridge.name,
    managementStatus: bridge.managementStatus,
    agentVersion: nullable(m?.agentVersion),
    agentApiVersion: nullable(m?.agentApiVersion),
    agentCapabilities: nullable(m?.agentCapabilities),
    frpsVersion: nullable(m?.frpsVersion),
    frpsReachable: nullable(m?.frpsReachable),
  };
  if (args.includes("--json")) return json(summary);
  console.log(`bridge ${summary.name} (${summary.id}) enrolled: management ${summary.managementStatus}`);
  console.log(
    `  agent ${show(summary.agentVersion)} api v${show(summary.agentApiVersion)}  capabilities: ${summary.agentCapabilities?.join(", ") || "—"}`,
  );
  console.log(`  frps ${describeFrps(m)}`);
}

/**
 * `bridge-agent-update <bridge-id> [--confirm]`. Without --confirm it only
 * shows the installed version, the approved image the panel offers and the
 * outstanding or last operation. With --confirm it requests exactly the
 * offered digest (never a tag, never an argument): a repeat of the
 * outstanding request returns that operation.
 */
export async function cmdBridgeAgentUpdate(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-agent-update <bridge-id> [--confirm] [--json]";
  assertStrictArgs(args, { positionals: 1, usage });
  const id = requireUuid(positionals(args)[0], "bridge-id", usage);
  const view = await api<AgentUpdateView>(`/api/admin/vpn-bridges/${id}/agent-update`);
  const offered = view.offered[0];
  if (!confirmed(args)) {
    if (args.includes("--json")) return json(projectAgentUpdate(view));
    const lines = [
      `bridge ${id}: agent ${show(view.installedVersion)} installed`,
      offered
        ? `  offered: ${offered.version}  ${offered.image}`
        : "  offered: none (BRIDGE_AGENT_IMAGE_REPOSITORY is not set or no release is resolved yet)",
      view.updateSupported
        ? "  The agent reports update.v1."
        : "  The installed agent does not report update.v1; it cannot be updated from the panel.",
    ];
    if (!view.jobsEnabled) lines.push("  Bridge jobs are disabled (VPN_BRIDGE_JOBS_ENABLED): a request is refused.");
    if (view.operation) {
      lines.push("  operation:", ...describeAgentUpdateOperation(view.operation));
    }
    return preview(lines);
  }
  // A confirm without anything to install, or with an outstanding operation
  // of another image, is answered by the API with its typed error.
  if (!offered && !view.operation) {
    throw new Error("The panel offers no bridge-agent image; run bridge-agent-update <bridge-id> without --confirm to see why");
  }
  const result = await api<{ created: boolean; operation: AgentUpdateOperationView }>(
    `/api/admin/vpn-bridges/${id}/agent-update`,
    { method: "POST", body: JSON.stringify({ imageDigest: (offered ?? { digest: view.operation?.requestedDigest }).digest }) },
  );
  if (args.includes("--json")) {
    return json({ created: result.created, operation: projectAgentUpdateOperation(result.operation) });
  }
  console.log(
    result.created
      ? `bridge ${id}: update to ${show(result.operation.requestedVersion)} requested`
      : `bridge ${id}: the same update is already outstanding`,
  );
  for (const line of describeAgentUpdateOperation(result.operation)) console.log(line);
  console.log(`Follow it with: bridge-agent-log ${id}`);
}

/** `bridge-agent-log <bridge-id> [--json]`: the current or last update and the history. */
export async function cmdBridgeAgentLog(api: BridgeApi, args: string[]): Promise<void> {
  const usage = "Usage: bridge-agent-log <bridge-id> [--json]";
  assertStrictArgs(args, { positionals: 1, usage });
  const id = requireUuid(positionals(args)[0], "bridge-id", usage);
  const view = await api<AgentUpdateView>(`/api/admin/vpn-bridges/${id}/agent-update`);
  if (args.includes("--json")) return json(projectAgentUpdate(view));
  console.log(`bridge ${id}: agent ${show(view.installedVersion)} installed`);
  if (!view.operation) {
    console.log("  no agent update was requested");
    return;
  }
  console.log("  latest:");
  for (const line of describeAgentUpdateOperation(view.operation)) console.log(line);
  if (view.history.length > 0) {
    console.log("  earlier:");
    for (const operation of view.history) {
      for (const line of describeAgentUpdateOperation(operation)) console.log(line);
    }
  }
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
  | {
      method: "probe";
      routeId: string;
      jobId: string | null;
      queued: boolean;
      status?: "queued" | "pending" | "running";
      runId?: string | null;
      registrationMarker: string;
    }
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
        jobId: result.jobId ?? null,
        queued: result.queued,
        status: result.status ?? (result.queued ? "queued" : "pending"),
        runId: result.runId ?? null,
        registrationMarker: result.registrationMarker,
      });
    }
    const state =
      result.status === "running"
        ? `probe check already running (run ${result.runId ?? "?"})`
        : result.queued
          ? `probe check queued (job ${result.jobId ?? "?"})`
          : `probe check already pending (job ${result.jobId ?? "?"})`;
    console.log(`${state} for registration ${result.registrationMarker}`);
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
> = new Map([
  ["bridges", cmdBridges],
  ["bridge-add", cmdBridgeAdd],
  ["bridge-enroll", cmdBridgeEnroll],
  ["bridge-agent-update", cmdBridgeAgentUpdate],
  ["bridge-agent-log", cmdBridgeAgentLog],
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
  bridge-enroll <bridge-id> --api-url=<url> --api-key-file=<path|-> --confirm
                                          Connect the bridge-agent: verifies its bridge id and
                                          status capability, stores the key encrypted. The key
                                          comes from a 0600 file or stdin (-), never an argument
  bridge-agent-update <bridge-id> [--confirm] [--json]
                                          Show the installed bridge-agent version and the
                                          approved image on offer; --confirm requests that
                                          update (one outstanding operation per bridge)
  bridge-agent-log <bridge-id> [--json]   The current or last agent update and its history
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
