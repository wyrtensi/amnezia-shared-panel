#!/usr/bin/env node
/**
 * amnezia-panel — admin CLI for the control plane.
 *
 * A thin, dependency-free client over the control-api's admin endpoints, so the
 * panel can be driven from a shell / cron / another host in addition to the web
 * UI. Auth mirrors how the API resolves identity:
 *   - dev:  PANEL_ADMIN_EMAIL          -> x-dev-user-email header
 *   - prod: CF_ACCESS_CLIENT_ID +
 *           CF_ACCESS_CLIENT_SECRET    -> Cloudflare Access service-token headers
 *
 * Config:
 *   CONTROL_API_URL (default http://127.0.0.1:3001)
 */

import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  keyNeedsRouteProfileWarning,
  routeProfileWarning,
} from "./deviceProfiles.js";
import {
  cliInstallVideoEmbed,
  describeVideoTarget,
} from "./installVideo.js";
import { buildRequestHeaders } from "./http.js";
import { authHeaders } from "./identity.js";
import {
  KEY_LIMIT_MODES,
  annotateNodeOrder,
  checkRecommendedPrefix,
  deviceTypeUsage,
  effectiveKeyLimitMode,
  flagOf,
  formatAccessSyncStatus,
  formatDeviceType,
  formatPolicyValue,
  formatUpdateStatus,
  matchesNodeFilter,
  parseDeviceType,
  parseEnumFlag,
  parseKeyLimitMode,
  positionals,
  csvList,
  parseNodeLimits,
  parseNodeSpec,
  parsePolicyNodeList,
  quotaCurrentLimit,
  quotaTargetLabel,
} from "./args.js";
import type { AccessSyncStatusView, UpdateStatusView } from "./args.js";
import { classifyNodeHost, formatNodeAddress } from "./nodeAddress.js";
import {
  awgCell,
  handshakeCell,
  metricPair,
  metricWarnings,
  type NodeMetricsView,
} from "./nodeMetrics.js";
import {
  assertionUsageLines,
  describeAssertions,
  parseAssertions,
  parseProbe,
  resultLabel,
} from "./serviceChecks.js";
import {
  CLI_CONFIG_FORMATS,
  configFrameName,
  configOutputName,
  confirmedFromArgs,
  configRequestPath,
  formatQrParams,
  type CliConfigFormat,
} from "./configPath.js";
import {
  CLIENT_RELEASE_COLUMNS,
  clientReleaseRows,
  clientReleaseSummary,
  formatVersionLine,
  type CliClientRelease,
  type CliVersionInfo,
} from "./clientReleases.js";
import { resolveApiKey, resolveSecret } from "./apiKey.js";

const API = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: buildRequestHeaders(
      init as { body?: BodyInit | null; headers?: Record<string, string> },
      authHeaders(),
    ),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(describeApiError(res.status, res.statusText, body));
  }
  return (body ? JSON.parse(body) : undefined) as T;
}

/**
 * Turn a failed response body into a line an operator can act on. The API
 * answers most errors as `{ error, message }`, and the one this command hits
 * most is `422 QR_TOO_LARGE` — a routine, expected answer for a split-tunnel
 * key, not a malfunction. Printing the raw JSON envelope for it would read
 * like a crash.
 *
 * A raw Zod validation failure (e.g. a rejected Access domain) has no
 * top-level `message` at all — only `issues`, one per failed field. The
 * first issue's own message is the readable reason ("not a domain name"), so
 * it stands in for `message` here, the same fallback the web admin's own
 * apiRequest uses for the same response shape.
 */
function describeApiError(status: number, statusText: string, body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return `HTTP ${status} ${statusText} — ${body.slice(0, 400)}`;
  }
  const { error, message, issues } = (parsed ?? {}) as {
    error?: unknown;
    message?: unknown;
    issues?: Array<{ message?: unknown }>;
  };
  const code = typeof error === "string" ? error : undefined;
  const firstIssue = Array.isArray(issues) ? issues[0]?.message : undefined;
  const detail =
    typeof message === "string"
      ? message
      : typeof firstIssue === "string"
        ? firstIssue
        : undefined;
  if (!code && !detail) {
    return `HTTP ${status} ${statusText} — ${body.slice(0, 400)}`;
  }
  const head = `${code ?? `HTTP ${status}`}: ${detail ?? statusText}`;
  return code === "QR_TOO_LARGE"
    ? `${head}\nThis key's route profile carries too many routes to fit a scannable code. Use --format=conf.`
    : head;
}

/**
 * Fetch a non-JSON response body. `api()` parses JSON, which would corrupt a
 * PNG; this is the raw-bytes path used by `key-config`. The headers come back
 * with the body because the QR formats carry the chosen render parameters there.
 */
async function apiRaw(
  path: string,
): Promise<{ body: Buffer; headers: Headers }> {
  const res = await fetch(`${API}${path}`, {
    headers: buildRequestHeaders(undefined, authHeaders()),
  });
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      describeApiError(res.status, res.statusText, body.toString("utf8")),
    );
  }
  return { body, headers: res.headers };
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
function bytes(raw: string | number | null | undefined): string {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value)) return "—";
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit > 1 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

function table(rows: Array<Record<string, string>>, columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => (row[col] ?? "").length)),
  );
  const pad = (text: string, i: number) =>
    text.padEnd(widths[i] ?? text.length);
  const header = columns.map((col, i) => pad(col, i)).join("  ");
  const sep = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = rows.map((row) =>
    columns.map((col, i) => pad(row[col] ?? "", i)).join("  "),
  );
  return [header, sep, ...lines].join("\n");
}

type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  keyLimitOverride: number | null;
  // Per-node limits ({ nodeId: limit }) and the per-user policy override that
  // carries node availability. Both are null when nothing is overridden.
  nodeKeyLimits?: Record<string, number> | null;
  policyOverride?: {
    allowedNodeIds?: string[] | null;
    // Absent = this user inherits the panel-wide key-limit mode.
    keyLimitMode?: string | null;
  } | null;
};
type AdminKey = {
  id: string;
  ownerId: string;
  nodeId: string;
  state: string;
  protocol: string;
  deviceLabel: string;
  /** Operator-only note; served on /api/admin/keys and nowhere else. */
  internalName?: string | null;
  deviceType?: string;
  routeProfile: string;
  online?: boolean;
  traffic?: { receivedBytes: string; sentBytes: string } | null;
};
type AdminNode = {
  id: string;
  name: string;
  /** Whether this node takes part in service checks at all. */
  checksEnabled?: boolean;
  /** Checks this node skips, by id. */
  disabledCheckIds?: string[];
  /** Host metrics from the last poll; null until this node has been polled. */
  metrics?: NodeMetricsView | null;
  /** Derived from the newest peer handshake, never probed. */
  endpoint?: { status: string; lastHandshakeAt: string | null } | null;
  // How the PANEL reaches the agent, as opposed to publicHost below, which is
  // how CLIENTS reach the node. Optional for the same reason as publicHost.
  apiBaseUrl?: string;
  enabled: boolean;
  protocol: string;
  enabledProtocols?: string[] | null;
  supportedProtocols?: string[];
  peerCount?: number;
  maxPeers: number;
  // Where clients reach the node: the agent's own SERVER_PUBLIC_HOST and what
  // the panel resolved it to, plus when. Optional so a CLI newer than the API
  // it talks to still lists nodes instead of printing "undefined".
  publicHost?: string | null;
  publicIp?: string | null;
  publicIpResolvedAt?: string | null;
  lastError: string | null;
  // The node's own view of its last agent update, mirrored by the telemetry
  // poll, plus the release the panel currently offers. All optional so a CLI
  // newer than the API it talks to still lists nodes.
  agentUpdateState?: string;
  agentUpdateImage?: string | null;
  agentUpdateMessage?: string | null;
  agentUpdateLog?: string;
  agentUpdateAt?: string | null;
  capacityState?: string;
  capacityRequestedPeers?: number | null;
  capacityMessage?: string | null;
  capacityLog?: string;
  capacityAt?: string | null;
  availableAgent?: {
    repository: string;
    version: string;
    image: string;
    resolvedAt: string;
  } | null;
};
type AuditEvent = {
  id: string;
  actorType: string;
  action: string;
  targetType: string;
  createdAt: string;
};
type QuotaRequest = {
  id: string;
  userId: string;
  requestedLimit: number;
  // Target server: null = every server. `nodeName` is resolved by the API.
  nodeId: string | null;
  nodeName: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
};

const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const wantsJson = (args: string[]) => args.includes("--json");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept a user UUID or an email (resolved to its id via the admin list). */
async function resolveUserId(ref: string | undefined, usage: string): Promise<string> {
  if (!ref) throw new Error(usage);
  if (UUID_RE.test(ref)) return ref;
  const users = await api<AdminUser[]>("/api/admin/users");
  const match = users.find((u) => u.email.toLowerCase() === ref.toLowerCase());
  if (!match) throw new Error(`No user with email "${ref}"`);
  return match.id;
}

const userAction = (id: string, action: string, body: unknown): Promise<unknown> =>
  api(`/api/admin/users/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });

type Overview = {
  activeKeys?: number;
  onlineDevices?: number;
  totalTrafficBytes?: string;
  totalUsers?: number;
  pendingQuotaRequests?: number;
  nodes?: { healthy: number; total: number };
};

async function cmdOverview(args: string[]): Promise<void> {
  const overview = await api<Overview>("/api/admin/overview");
  if (wantsJson(args)) return json(overview);
  console.log(`Active keys:   ${overview.activeKeys ?? 0}`);
  console.log(`Online now:    ${overview.onlineDevices ?? 0}`);
  console.log(`Total traffic: ${bytes(overview.totalTrafficBytes)}`);
  console.log(`Users:         ${overview.totalUsers ?? 0}`);
  const nodes = overview.nodes;
  console.log(
    `Nodes healthy: ${nodes ? `${nodes.healthy}/${nodes.total}` : "—"}`,
  );
  console.log(`Quota requests pending: ${overview.pendingQuotaRequests ?? 0}`);
}

/**
 * Compact "which servers, how many custom limits" cell for the users table:
 * "all" / "3 of N" node availability plus the number of per-node limits.
 */
function describeUserNodes(user: AdminUser): string {
  const allowed = user.policyOverride?.allowedNodeIds ?? null;
  const availability =
    allowed === null ? "all" : allowed.length ? `${allowed.length} allowed` : "none";
  const perNode = Object.keys(user.nodeKeyLimits ?? {}).length;
  return perNode > 0 ? `${availability}, ${perNode} custom` : availability;
}

/**
 * The two portal-policy fields the users / quota tables need to state a limit
 * correctly. Read out of the untyped policy row and narrowed here because the
 * CLI carries no contract dependency: a panel older than the key-limit modes
 * returns neither field, and both call sites have to survive that.
 */
function policyLimitContext(rows: Array<Record<string, unknown>>): {
  globalMode: string | undefined;
  defaultKeyLimit: number | undefined;
} {
  const policy = rows[0] ?? {};
  const mode = policy.keyLimitMode;
  const fallback = policy.defaultKeyLimit;
  return {
    globalMode: typeof mode === "string" ? mode : undefined,
    defaultKeyLimit: typeof fallback === "number" ? fallback : undefined,
  };
}

/**
 * The key-limit mode cell: the mode that actually applies to this user, with
 * `*` marking one set on the user rather than inherited from the panel. The
 * effective value is what matters — it decides whether the `limit` column next
 * to it reads as a per-server number or as one shared total.
 */
function describeUserMode(
  user: AdminUser,
  globalMode: string | undefined,
): string {
  const own = user.policyOverride?.keyLimitMode ?? null;
  return `${effectiveKeyLimitMode(globalMode, own)}${own ? "*" : ""}`;
}

async function cmdUsers(args: string[]): Promise<void> {
  const [users, policyRows] = await Promise.all([
    api<AdminUser[]>("/api/admin/users"),
    api<Array<Record<string, unknown>>>("/api/admin/portal-policy"),
  ]);
  if (wantsJson(args)) return json(users);
  const { globalMode } = policyLimitContext(policyRows);
  console.log(
    table(
      users.map((user) => ({
        email: user.email,
        role: user.role,
        status: user.status,
        limit: user.keyLimitOverride?.toString() ?? "default",
        mode: describeUserMode(user, globalMode),
        // Counts only; `user-limit --node-limits=` shows and sets the detail.
        nodes: describeUserNodes(user),
      })),
      ["email", "role", "status", "limit", "mode", "nodes"],
    ),
  );
}

async function cmdKeys(args: string[]): Promise<void> {
  const [keys, users] = await Promise.all([
    api<AdminKey[]>("/api/admin/keys"),
    api<AdminUser[]>("/api/admin/users"),
  ]);
  // Filter before rendering AND before --json, so `keys --device-type=unspecified
  // --json` is a scriptable census of the rows that still need re-classifying.
  const deviceFilter = flagOf(args, "device-type");
  const nodeFilter = flagOf(args, "node");
  const byDevice = keys
    .filter((key) => matchesNodeFilter(key.nodeId, nodeFilter))
    .filter((key) =>
      deviceFilter ? (key.deviceType ?? "unspecified") === deviceFilter : true,
    );
  // The audit behind the key card's warning: which existing keys pair a
  // platform whose client ignores route profiles with a split tunnel. The
  // wizard can no longer create that pair, but older keys, the CLI and an
  // admin still can, so an operator needs a way to count them.
  const needsWarning = args.includes("--needs-profile-warning");
  const shown = needsWarning
    ? byDevice.filter((key) => keyNeedsRouteProfileWarning(key))
    : byDevice;
  if (wantsJson(args)) return json(shown);
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  console.log(
    table(
      shown.map((key) => ({
        device: key.deviceLabel || "—",
        // The operator's own note, so `keys` answers "whose key is this really"
        // without a second lookup. Empty for the keys that have none.
        internal: key.internalName || "—",
        // The label is free text the user typed and D3 deliberately preserves
        // it across the migration, so "Laptop" can sit on an `unspecified` row.
        // The platform is the stored value; showing both is the only way an
        // operator can see which rows still need re-classifying.
        platform: formatDeviceType(key.deviceType),
        // The value the filter's predicate read, so a listed row shows why it
        // is listed. Only under --needs-profile-warning: the default table is
        // already wide.
        route: key.routeProfile,
        owner: emailById.get(key.ownerId) ?? key.ownerId.slice(0, 8),
        state: key.state,
        proto: key.protocol,
        online: key.online ? "yes" : "no",
        traffic: key.traffic
          ? bytes(
              (
                BigInt(key.traffic.receivedBytes) +
                BigInt(key.traffic.sentBytes)
              ).toString(),
            )
          : "—",
      })),
      needsWarning
        ? [
            "device",
            "internal",
            "platform",
            "route",
            "owner",
            "state",
            "proto",
            "online",
            "traffic",
          ]
        : [
            "device",
            "internal",
            "platform",
            "owner",
            "state",
            "proto",
            "online",
            "traffic",
          ],
    ),
  );
}

async function cmdNodes(args: string[]): Promise<void> {
  const [nodes, policyRows] = await Promise.all([
    api<AdminNode[]>("/api/admin/nodes"),
    api<Array<{ nodeOrder?: string[]; recommendedNodeIds?: string[] }>>(
      "/api/admin/portal-policy",
    ),
  ]);
  if (wantsJson(args)) return json(nodes);
  // The panel->node half of the IP-vs-DNS audit, as one command rather than a
  // script pasted out of a runbook. Its own table: the default one is about
  // capacity and health, this one about how the panel dials each agent.
  if (args.includes("--hosts")) {
    console.log(
      table(
        nodes.map((node) => ({
          name: node.name,
          id: node.id,
          "api host": node.apiBaseUrl ?? "—",
          kind: classifyNodeHost(node.apiBaseUrl ?? ""),
        })),
        ["name", "id", "api host", "kind"],
      ),
    );
    return;
  }
  // The list users actually see: the admin's stored order first, then the
  // nodes nobody has placed, by name. `#` is the position a user sees and `-`
  // marks a node that has never been placed - which is worth noticing, since
  // an unplaced node sorts last and cannot be recommended.
  const policy = policyRows[0] ?? {};
  const ordered = annotateNodeOrder(
    nodes,
    policy.nodeOrder ?? [],
    policy.recommendedNodeIds ?? [],
  );
  console.log(
    table(
      ordered.map((node) => ({
        "#": node.rank,
        rec: node.rec,
        id: node.id,
        name: node.name,
        enabled: node.enabled ? "yes" : "no",
        protocols: (node.enabledProtocols?.length
          ? node.enabledProtocols
          : (node.supportedProtocols ?? [node.protocol])
        ).join(","),
        peers: `${node.peerCount ?? 0}/${node.maxPeers}`,
        // The address clients reach this node at, including whether a DNS name
        // has actually resolved — the same distinction the node card draws.
        address: formatNodeAddress(node.publicHost ?? null, node.publicIp ?? null),
        health: node.lastError ? "ERROR" : "ok",
      })),
      ["#", "rec", "id", "name", "enabled", "protocols", "peers", "address", "health"],
    ),
  );
}

async function cmdAudit(args: string[]): Promise<void> {
  const events = await api<AuditEvent[]>("/api/admin/audit");
  if (wantsJson(args)) return json(events);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 20;
  console.log(
    table(
      events.slice(0, limit).map((event) => ({
        time: new Date(event.createdAt).toISOString().replace("T", " ").slice(0, 19),
        actor: event.actorType,
        action: event.action,
        target: event.targetType,
      })),
      ["time", "actor", "action", "target"],
    ),
  );
}

async function cmdUserCreate(args: string[]): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const email = positional[0];
  if (!email) throw new Error("Usage: user-create <email> [displayName] [--admin]");
  const displayName = positional[1];
  const role = args.includes("--admin") ? "admin" : "user";
  const created = await api<{ id: string }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, displayName, role }),
  });
  console.log(`Created user ${email} (${role}) — id ${created.id}`);
}

async function cmdUserRole(args: string[]): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const usage = "Usage: user-role <id|email> <admin|user>";
  const id = await resolveUserId(positional[0], usage);
  const role = positional[1];
  if (role !== "admin" && role !== "user") throw new Error(usage);
  await userAction(id, "set-role", { role });
  console.log(`user ${positional[0]}: role → ${role}`);
}

async function cmdUserLimit(args: string[]): Promise<void> {
  const positional = positionals(args);
  const usage =
    "Usage: user-limit <id|email> <n|default> [--node-limits=<uuid>:<n>,…|none] [--allowed-nodes=all|none|uuid,…] [--mode=per_node|global|inherit]";
  const id = await resolveUserId(positional[0], usage);
  const raw = positional[1];
  if (raw === undefined) throw new Error(usage);
  const keyLimitOverride = raw === "default" || raw === "null" ? null : Number(raw);
  if (
    keyLimitOverride !== null &&
    (!Number.isInteger(keyLimitOverride) ||
      keyLimitOverride < 0 ||
      keyLimitOverride > 1000)
  ) {
    throw new Error("limit must be an integer 0..1000, or 'default'");
  }
  // Both extras are optional: an omitted flag leaves that part untouched, so
  // this command stays a plain "set the flat limit" when neither is given.
  const body: Record<string, unknown> = { keyLimitOverride };
  const nodeLimitsFlag = flagOf(args, "node-limits");
  if (nodeLimitsFlag !== undefined) {
    body.nodeKeyLimits = parseNodeLimits(nodeLimitsFlag);
  }
  const allowedNodesFlag = flagOf(args, "allowed-nodes");
  if (allowedNodesFlag !== undefined) {
    body.allowedNodeIds = parseNodeSpec(allowedNodesFlag);
  }
  // How this user's number is counted. Null is meaningful here (it clears the
  // per-user override), so the flag's presence — not its value — decides
  // whether the field is sent at all.
  const modeFlag = flagOf(args, "mode");
  if (modeFlag !== undefined) body.keyLimitMode = parseKeyLimitMode(modeFlag);
  await userAction(id, "set-limit", body);
  console.log(`user ${positional[0]}: key limit → ${keyLimitOverride ?? "default"}`);
  if (nodeLimitsFlag !== undefined) {
    const limits = body.nodeKeyLimits as Record<string, number> | null;
    const shown = limits
      ? Object.entries(limits)
          .map(([nodeId, limit]) => `${nodeId}:${limit}`)
          .join(",") || "none"
      : "none";
    console.log(`  per-node limits → ${shown}`);
  }
  if (allowedNodesFlag !== undefined) {
    const allowed = body.allowedNodeIds as string[] | null;
    const shown =
      allowed === null ? "all" : allowed.length ? allowed.join(",") : "none";
    console.log(`  node availability → ${shown}`);
  }
  if (modeFlag !== undefined) {
    console.log(`  key limit mode → ${modeFlag}`);
    if (modeFlag === "global" && nodeLimitsFlag !== undefined) {
      // The per-node write is kept, but it does not bite until the mode goes
      // back to per_node. Saying so is the difference between a stored value
      // and a silently ignored one.
      console.log("  (per-node limits are stored but dormant in global mode)");
    }
  }
}

async function cmdUserDisable(args: string[]): Promise<void> {
  const id = await resolveUserId(
    args.find((arg) => !arg.startsWith("--")),
    "Usage: user-disable <id|email>",
  );
  await userAction(id, "offboard", {});
  console.log("user disabled — their keys are queued for revoke");
}

async function cmdUserEnable(args: string[]): Promise<void> {
  const id = await resolveUserId(
    args.find((arg) => !arg.startsWith("--")),
    "Usage: user-enable <id|email>",
  );
  await userAction(id, "reinstate", {});
  console.log("user reinstated — status active");
}

async function cmdQuota(args: string[]): Promise<void> {
  const [requests, users, policyRows] = await Promise.all([
    api<QuotaRequest[]>("/api/admin/quota-requests"),
    api<AdminUser[]>("/api/admin/users"),
    api<Array<Record<string, unknown>>>("/api/admin/portal-policy"),
  ]);
  if (wantsJson(args)) return json(requests);
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const userById = new Map(users.map((user) => [user.id, user]));
  const { globalMode, defaultKeyLimit } = policyLimitContext(policyRows);
  // Both cells below are read in that requester's own mode: what a click on
  // quota-approve changes depends on it, and the per-node numbers it would
  // otherwise quote are dormant under a shared pool.
  const modeFor = (userId: string) =>
    effectiveKeyLimitMode(
      globalMode,
      userById.get(userId)?.policyOverride?.keyLimitMode ?? null,
    );
  // Default to the actionable set (pending); `--all` shows every request.
  const showAll = args.includes("--all");
  const rows = requests
    .filter((req) => showAll || req.status === "pending")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  if (rows.length === 0) {
    console.log(showAll ? "(no quota requests)" : "(no pending requests)");
    return;
  }
  console.log(
    table(
      rows.map((req) => {
        const mode = modeFor(req.userId);
        const current = quotaCurrentLimit(
          mode,
          userById.get(req.userId) ?? {},
          req.nodeId,
          defaultKeyLimit,
        );
        return {
          id: req.id,
          user: emailById.get(req.userId) ?? req.userId.slice(0, 8),
          // A request names one server or every server; in per_node mode
          // approving it grants the limit exactly there, in global mode it
          // always raises the shared total, whatever the request named.
          target: quotaTargetLabel(
            mode,
            req.nodeId ? (req.nodeName ?? req.nodeId.slice(0, 8)) : null,
          ),
          change: `${current} → ${req.requestedLimit}`,
          status: req.status,
          created: (req.createdAt ?? "").replace("T", " ").slice(0, 16),
          reason: (req.reason ?? "").replace(/\s+/g, " ").slice(0, 36) || "—",
        };
      }),
      ["id", "user", "target", "change", "status", "created", "reason"],
    ),
  );
}

async function cmdQuotaReview(
  action: "approve" | "reject",
  args: string[],
): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const id = positional[0];
  if (!id) throw new Error(`Usage: quota-${action} <request-id> [note]`);
  const note = positional.slice(1).join(" ") || undefined;
  await api(`/api/admin/quota-requests/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
  console.log(
    `quota request ${id}: ${action === "approve" ? "approved" : "rejected"}`,
  );
}

async function cmdCfToken(args: string[]): Promise<void> {
  // Prefer --token-file=<path|->: a token passed as an argument is visible in
  // `ps` and in shell history for as long as the process lives. The positional
  // form stays supported so existing scripts keep working.
  const token =
    resolveSecret(args, "token") ?? args.find((arg) => !arg.startsWith("--"));
  if (!token) {
    throw new Error(
      "Usage: cf-token --token-file=<path|-> (or cf-token <cloudflare-api-token>)",
    );
  }
  await api("/api/admin/portal-policy/global/update", {
    method: "POST",
    body: JSON.stringify({ cfApiToken: token }),
  });
  console.log("Cloudflare API token stored (encrypted, write-only).");
}

async function cmdCfConfig(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found ? found.split("=").slice(1).join("=") : undefined;
  };
  const body: Record<string, string> = {};
  const account = flag("account");
  const app = flag("app");
  const policy = flag("policy");
  if (account) body.cfAccessAccountId = account;
  if (app) body.cfAccessAppId = app;
  if (policy) body.cfAccessPolicyId = policy;
  if (Object.keys(body).length === 0) {
    throw new Error("Usage: cf-config --account=… --app=… --policy=…");
  }
  await api("/api/admin/portal-policy/global/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(`Updated Cloudflare config: ${Object.keys(body).join(", ")}`);
}

/**
 * Cloudflare is configured once every id is set and a token has been stored.
 * `/api/admin/portal-policy` returns a one-row list, as everywhere else in
 * this file (see `cmdPolicy`, `cmdCfConfig`'s siblings).
 */
function cfAccessConfigured(rows: Array<Record<string, unknown>>): boolean {
  const row = rows[0] ?? {};
  // Truthiness, not `typeof === "string"`: the worker's own
  // `getCloudflareConfig` treats a cleared id (stored as "") as unconfigured,
  // and this check must agree — otherwise cf-sync would queue a run the
  // worker then fails.
  return (
    Boolean(row.cfAccessAccountId) &&
    Boolean(row.cfAccessAppId) &&
    Boolean(row.cfAccessPolicyId) &&
    row.cfApiTokenSet === true
  );
}

/**
 * Ask the outbox to reconcile the Cloudflare Access allowlist now, instead of
 * waiting for the hourly timer or the next panel-side user change. Refuses
 * up front when Cloudflare is not configured: the worker would fail the run
 * anyway, and an operator who explicitly asked for this deserves an
 * immediate answer instead of a queued run that dies later.
 *
 * `--status` reads the same job the worker executes and prints its last
 * outcome. A run that refused to act (unconfigured, or the blast-radius cap
 * tripped) finishes as "failed" with the reason, which shows up here too.
 */
async function cmdCfSync(args: string[]): Promise<void> {
  if (args.includes("--status")) {
    const status = await api<AccessSyncStatusView>("/api/admin/access-sync");
    if (wantsJson(args)) return json(status);
    console.log(formatAccessSyncStatus(status));
    return;
  }
  const policy = await api<Array<Record<string, unknown>>>(
    "/api/admin/portal-policy",
  );
  if (!cfAccessConfigured(policy)) {
    throw new Error(
      "Cloudflare Access is not configured — set the account/app/policy ids " +
        "with cf-config and the API token with cf-token, then run cf-sync again.",
    );
  }
  const result = await api<AccessSyncStatusView>(
    "/api/admin/access-sync/global/run",
    { method: "POST" },
  );
  // The run endpoint arms the outbox row and hands back its resulting state.
  // A row already mid-flight (locked by the worker's poller) stays
  // "processing" through the arm, which is the one case that is genuinely a
  // coalesce into a run already on its way rather than a fresh queue.
  const alreadyRunning = result.status === "processing";
  console.log(
    alreadyRunning
      ? "cf-sync: coalesced into a run already on its way"
      : "cf-sync: queued a reconcile",
  );
}

/**
 * Light client-side cleanup for an Access domain entry: trim, lower-case, and
 * drop a leading "@" someone might paste from a dashboard rule that reads
 * "emails ending in @company.tld". Deliberately shallow — the CLI carries no
 * dependency on packages/contracts, so accessDomainSchema, run by the API, is
 * the one place that decides whether the result is actually a valid domain.
 */
function normalizeCfDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

/**
 * List, or edit, the domains the panel keeps as `email_domain` rules in the
 * Cloudflare Access policy. Reads the current list, computes the new one
 * locally, and posts only `cfAccessAllowedDomains` — never the rest of the
 * policy row — so a stale copy of unrelated fields can never overwrite a
 * concurrent edit made from the Users page.
 *
 * `--add`, `--remove` and `--set` all touch the same list in incompatible
 * ways (grow it, shrink it, replace it outright), so combining more than one
 * in a single call is refused rather than silently picking a winner.
 *
 * A bare `--set=` (nothing after the `=`) is refused rather than treated as
 * "replace with an empty list": that is exactly what an unset shell variable
 * produces by accident (`--set=$DOMAINS` with `$DOMAINS` empty), and silently
 * posting `[]` would wipe every domain rule the panel owns on the next sync.
 * `--set=none` is the explicit, unambiguous way to ask for that — and it
 * prints what it is about to remove before doing it, since this is a
 * security-relevant allowlist.
 */
async function cmdCfDomains(args: string[]): Promise<void> {
  const add = flagOf(args, "add");
  const remove = flagOf(args, "remove");
  const set = flagOf(args, "set");
  if ([add, remove, set].filter((value) => value !== undefined).length > 1) {
    throw new Error(
      "Usage: cf-domains [--add=<domain> | --remove=<domain> | --set=<a,b,...>] — one at a time",
    );
  }
  if (set !== undefined && set.trim() === "") {
    throw new Error(
      'cf-domains: --set needs a value — use --set=none to clear the list explicitly, or --set=<a,b,...> to replace it',
    );
  }

  const policy = await api<Array<Record<string, unknown>>>(
    "/api/admin/portal-policy",
  );
  const current =
    (policy[0]?.cfAccessAllowedDomains as string[] | undefined) ?? [];

  if (add === undefined && remove === undefined && set === undefined) {
    console.log(
      `Access domains (${current.length}): ${current.join(", ") || "(none)"}`,
    );
    return;
  }

  let next: string[];
  if (set !== undefined && set.trim().toLowerCase() === "none") {
    if (current.length === 0) {
      console.log("cf-domains: list is already empty — nothing to clear");
      return;
    }
    // Say what is being removed before doing it — this wipes a
    // security-relevant allowlist, so the operator sees the blast radius up
    // front rather than discovering it from the next sync.
    console.log(`cf-domains: clearing ${current.join(", ")}`);
    next = [];
  } else if (set !== undefined) {
    next = [...new Set(csvList(set).map(normalizeCfDomain))];
  } else if (add !== undefined) {
    const domain = normalizeCfDomain(add);
    if (current.some((existing) => existing.toLowerCase() === domain)) {
      console.log(
        `cf-domains: "${domain}" is already in the list — nothing to add`,
      );
      return;
    }
    next = [...current, domain];
  } else {
    const domain = normalizeCfDomain(remove as string);
    if (!current.some((existing) => existing.toLowerCase() === domain)) {
      console.log(
        `cf-domains: "${domain}" is not in the list — nothing to remove`,
      );
      return;
    }
    next = current.filter((existing) => existing.toLowerCase() !== domain);
  }

  await api("/api/admin/portal-policy/global/update", {
    method: "POST",
    body: JSON.stringify({ cfAccessAllowedDomains: next }),
  });
  console.log(`cf-domains: now ${next.join(", ") || "(none)"}`);
}

// Every settable portal-policy field, grouped by how the flag value is coerced.
const POLICY_BOOL_FIELDS = [
  "allowKeyCreation",
  "allowNodeSelection",
  "allowRouteProfileSelection",
  "allowCustomRoutes",
  "allowConfigRedownload",
  "allowQrDownload",
  "allowConfDownload",
  "allowSelfRevoke",
  "showPublicKey",
  "showLastUsed",
  "showTraffic",
  // Off by default: a node's address is operational information about the
  // fleet, so showing it to ordinary users is an operator's decision rather
  // than something an upgrade makes on their behalf. Admins always see it.
  "showNodeAddress",
  // On by default: a user seeing which services work from a server is the whole
  // point of collecting the checks. What it gates is the check chips, never a
  // node state word.
  "showNodeStatus",
] as const;
const POLICY_INT_FIELDS = ["defaultKeyLimit"] as const;
const POLICY_INT_NULL_FIELDS = ["dailyRetentionDays"] as const;
const POLICY_STR_NULL_FIELDS = [
  "cfAccessAccountId",
  "cfAccessAppId",
  "cfAccessPolicyId",
] as const;
const POLICY_STR_FIELDS = ["cfApiToken"] as const;
/**
 * Policy fields whose value is one of a fixed word list. Unlike `user-limit
 * --mode`, the panel-wide switch has no `inherit`: it is the value everything
 * else inherits from.
 */
const POLICY_ENUM_FIELDS: Record<string, readonly string[]> = {
  keyLimitMode: KEY_LIMIT_MODES,
};
/** Audiences the connection guide is split into; mirrors the contract. */
const GUIDE_AUDIENCE_VALUES = ["desktop", "android", "ios"] as const;

async function cmdPolicy(args: string[]): Promise<void> {
  const rows = await api<Array<Record<string, unknown>>>(
    "/api/admin/portal-policy",
  );
  const policy = rows[0] ?? {};
  if (wantsJson(args)) return json(policy);
  for (const [key, value] of Object.entries(policy)) {
    console.log(`${key.padEnd(28)} ${formatPolicyValue(key, value)}`);
  }
  // The API validates the recommended-must-be-a-prefix rule when it accepts a
  // write and never re-checks it afterwards, so a row edited in SQL can
  // violate it with nothing to say so. This is the only read-side guard.
  const verdict = checkRecommendedPrefix(
    (policy.recommendedNodeIds as string[] | undefined) ?? [],
    (policy.nodeOrder as string[] | undefined) ?? [],
  );
  console.log(
    verdict.ok
      ? "order check                  ok"
      : `order check                  FAIL - ${verdict.nodeId} is recommended but is ${
          verdict.reason === "behind"
            ? "not in the top of the server order"
            : "not in the server order at all"
        }`,
  );
}

async function cmdPolicySet(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found ? found.split("=").slice(1).join("=") : undefined;
  };
  const body: Record<string, unknown> = {};
  for (const field of POLICY_BOOL_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = parseBoolFlag(field, value);
  }
  for (const field of POLICY_INT_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = Number(value);
  }
  for (const field of POLICY_INT_NULL_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = value === "null" ? null : Number(value);
  }
  for (const field of POLICY_STR_NULL_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = value === "null" ? null : value;
  }
  for (const field of POLICY_STR_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = value;
  }
  for (const [field, allowed] of Object.entries(POLICY_ENUM_FIELDS)) {
    const value = flag(field);
    if (value !== undefined) body[field] = parseEnumFlag(field, value, allowed);
  }
  // The hand-made server order and the recommended servers. Both take a
  // comma-separated id list; "none" clears one. Passing both in one call is
  // how you reorder past a recommended set that would no longer be the top of
  // the list - the API validates them together.
  for (const field of ["nodeOrder", "recommendedNodeIds"] as const) {
    const value = flag(field);
    if (value !== undefined) body[field] = parsePolicyNodeList(value);
  }
  // Walkthrough videos are a nested map, one entry per guide audience, so they
  // cannot ride the flat --field=value loops above. Setting one audience must
  // not clear the others, so the current map is read first and merged into --
  // the update replaces the whole object.
  const videoFlags = GUIDE_AUDIENCE_VALUES.map(
    (audience) => [audience, flag(`video-${audience}`)] as const,
  ).filter(([, value]) => value !== undefined);
  if (videoFlags.length > 0) {
    const rows = await api<Array<Record<string, unknown>>>(
      "/api/admin/portal-policy",
    );
    const current = (rows[0]?.installGuideVideos ?? {}) as Record<
      string,
      string | null
    >;
    const videos: Record<string, string | null> = { ...current };
    const summary: string[] = [];
    for (const [audience, value] of videoFlags) {
      const cleared = value === "none" || value === "null";
      const next = cleared ? null : value!;
      // Refuse a URL the panel cannot play now, rather than storing it and
      // leaving the guide showing its placeholder with no explanation.
      if (next !== null && !cliInstallVideoEmbed(next)) {
        throw new Error(
          `--video-${audience}: not a playable video link. Use a Google Drive ` +
            "share link (https://drive.google.com/file/d/<id>/view), a direct " +
            "http(s) video file, or 'none' to clear it.",
        );
      }
      videos[audience] = next;
      summary.push(describeVideoTarget(audience, next));
    }
    body.installGuideVideos = videos;
    for (const line of summary) console.log(line);
  }

  const protocols = flag("allowedProtocols");
  if (protocols !== undefined) {
    body.allowedProtocols = protocols
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const nodeIds = flag("allowedNodeIds");
  if (nodeIds !== undefined) {
    body.allowedNodeIds =
      nodeIds === "null"
        ? null
        : nodeIds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
  }
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Usage: policy-set --<field>=<value> …  (run `help` for the field list)",
    );
  }
  await api("/api/admin/portal-policy/global/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(`Updated policy: ${Object.keys(body).join(", ")}`);
}

async function cmdAction(
  resource: string,
  action: string,
  args: string[],
): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error(`Usage: ${resource}-${action} <id>`);
  await api(`/api/admin/${resource}/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  console.log(`${resource} ${id}: ${action} done`);
}

/**
 * Set (or clear) a key's operator-only note.
 *
 * `--name=` with nothing after it clears the note, which is why the flag is
 * read rather than taken as a positional: an empty positional is indistinguishable
 * from a missing one, and "clear it" must not be spelt the same way as a typo.
 */
async function cmdKeyInternalName(args: string[]): Promise<void> {
  const usage = 'Usage: key-internal-name <id> --name="<text>"';
  const id = positionals(args)[0];
  const name = flagOf(args, "name");
  if (!id || name === undefined) throw new Error(usage);
  if (name.length > 80) {
    throw new Error("An internal name is at most 80 characters");
  }
  await api(`/api/admin/keys/${id}/set-internal-name`, {
    method: "POST",
    body: JSON.stringify({ internalName: name }),
  });
  console.log(
    name === ""
      ? `key ${id}: internal name cleared`
      : `key ${id}: internal name set to ${name}`,
  );
}

/** The one node `id` names, by id or by exact name. */
async function findAdminNode(id: string): Promise<AdminNode> {
  const nodes = await api<AdminNode[]>("/api/admin/nodes");
  const node = nodes.find((row) => row.id === id || row.name === id);
  if (!node) throw new Error(`No node with id or name ${id}`);
  return node;
}

async function cmdNodeAgentUpdate(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    throw new Error(
      "Usage: node-agent-update <id> [--image=<repo@sha256:...>] [--confirm]",
    );
  }
  const node = await findAdminNode(id);
  const image = flagOf(args, "image") ?? node.availableAgent?.image;
  if (!image) {
    throw new Error(
      "The panel has not resolved a published node-agent image yet, so there is " +
        "nothing to install. Check NODE_AGENT_UPDATE_REPO on the worker.",
    );
  }
  // Same shape as the panel's confirm dialog: see the digest, then say yes. The
  // update replaces software on a live host, so it is never the default.
  if (!args.includes("--confirm")) {
    console.log(`node ${node.name} (${node.id})`);
    console.log(`  running:  ${node.agentUpdateImage ?? "unknown"}`);
    console.log(`  install:  ${image}`);
    if (node.availableAgent) {
      console.log(
        `  version:  ${node.availableAgent.version} (resolved ${node.availableAgent.resolvedAt})`,
      );
    }
    console.log("Re-run with --confirm to install it.");
    return;
  }
  const result = await api<{ image: string }>(
    `/api/admin/nodes/${node.id}/agent-update`,
    { method: "POST", body: JSON.stringify({ image }) },
  );
  console.log(`node ${node.name}: update to ${result.image} requested`);
  console.log("Follow it with: node-agent-log " + node.id);
}

async function cmdNodeAgentLog(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: node-agent-log <id>");
  const node = await findAdminNode(id);
  if (wantsJson(args)) {
    return json({
      state: node.agentUpdateState ?? "idle",
      image: node.agentUpdateImage ?? null,
      message: node.agentUpdateMessage ?? null,
      updatedAt: node.agentUpdateAt ?? null,
      log: node.agentUpdateLog ?? "",
    });
  }
  console.log(`node ${node.name} (${node.id})`);
  console.log(`  state:    ${node.agentUpdateState ?? "idle"}`);
  console.log(`  image:    ${node.agentUpdateImage ?? "—"}`);
  console.log(`  finished: ${node.agentUpdateAt ?? "—"}`);
  if (node.agentUpdateMessage) console.log(`  message:  ${node.agentUpdateMessage}`);
  const log = node.agentUpdateLog ?? "";
  if (log.trim()) {
    console.log("");
    console.log(log.trimEnd());
  }
}

async function cmdKeyPurge(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: key-purge <id> --confirm");
  // Irreversible and silent: the row and its traffic history stop existing, and
  // there is no state left to notice afterwards. Never the default.
  if (!args.includes("--confirm")) {
    console.log(`key ${id}`);
    console.log(
      "This deletes the key from the panel: the row, its traffic history and any",
    );
    console.log(
      "pending jobs. The peer is already gone from the node - that is what being",
    );
    console.log("revoked means. Only the audit log will remember it.");
    console.log("Re-run with --confirm to delete it.");
    return;
  }
  await api(`/api/admin/keys/${id}/purge`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  console.log(`key ${id}: deleted from the panel`);
}

async function cmdNodeCapacity(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: node-capacity <id> [--set=<peers>] [--confirm]");
  const node = await findAdminNode(id);
  const requested = flagOf(args, "set");

  if (requested === undefined) {
    if (wantsJson(args)) {
      return json({
        maxPeers: node.maxPeers,
        state: node.capacityState ?? "idle",
        requestedMaxPeers: node.capacityRequestedPeers ?? null,
        message: node.capacityMessage ?? null,
        updatedAt: node.capacityAt ?? null,
        log: node.capacityLog ?? "",
      });
    }
    console.log(`node ${node.name} (${node.id})`);
    console.log(`  panel limit: ${node.maxPeers}`);
    console.log(`  state:       ${node.capacityState ?? "idle"}`);
    console.log(`  requested:   ${node.capacityRequestedPeers ?? "—"}`);
    console.log(`  finished:    ${node.capacityAt ?? "—"}`);
    if (node.capacityMessage) console.log(`  message:     ${node.capacityMessage}`);
    const log = node.capacityLog ?? "";
    if (log.trim()) {
      console.log("");
      console.log(log.trimEnd());
    }
    return;
  }

  const maxPeers = Number(requested);
  if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 500) {
    throw new Error("--set must be a whole number between 1 and 500");
  }
  // Same shape as the panel's dialog: see what changes, then say yes. This
  // recreates a container on a live host, so it is never the default.
  if (!args.includes("--confirm")) {
    console.log(`node ${node.name} (${node.id})`);
    console.log(`  panel limit now: ${node.maxPeers}`);
    console.log(`  change to:       ${maxPeers}`);
    console.log(
      "The node-agent is recreated to pick this up; tunnels stay up and no peer is lost.",
    );
    console.log("Re-run with --confirm to apply it.");
    return;
  }
  const result = await api<{ maxPeers: number }>(
    `/api/admin/nodes/${node.id}/set-capacity`,
    { method: "POST", body: JSON.stringify({ maxPeers }) },
  );
  console.log(`node ${node.name}: capacity change to ${result.maxPeers} requested`);
  console.log("Follow it with: node-capacity " + node.id);
}

async function cmdNodeAdd(args: string[]): Promise<void> {
  const name = flagOf(args, "name");
  const apiBaseUrl = flagOf(args, "api-url");
  const apiKey = resolveApiKey(args);
  if (!name || !apiBaseUrl || !apiKey) {
    throw new Error(
      "Usage: node-add --name= --api-url= --api-key-file=<path|-> (or --api-key=) " +
        "[--public-name=] [--protocol=awg3] [--max-peers=500] [--enabled-protocols=awg3,awg2] [--disabled]",
    );
  }
  const body: Record<string, unknown> = { name, apiBaseUrl, apiKey };
  const publicName = flagOf(args, "public-name");
  if (publicName) body.publicName = publicName;
  const protocol = flagOf(args, "protocol");
  if (protocol) body.protocol = protocol;
  const maxPeers = flagOf(args, "max-peers");
  if (maxPeers) body.maxPeers = Number(maxPeers);
  const enabledProtocols = flagOf(args, "enabled-protocols");
  if (enabledProtocols) {
    body.enabledProtocols = enabledProtocols
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (args.includes("--disabled")) body.enabled = false;
  const node = await api<{ id: string; name: string }>("/api/admin/nodes", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(`node added: ${node.name} (${node.id})`);
}

async function cmdNodeUpdate(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: node-update <id> --<field>=<value> …");
  const body: Record<string, unknown> = {};
  const strFields: Array<[string, string]> = [
    ["name", "name"],
    ["public-name", "publicName"],
    ["api-url", "apiBaseUrl"],
    ["protocol", "protocol"],
  ];
  for (const [cli, field] of strFields) {
    const value = flagOf(args, cli);
    if (value !== undefined) body[field] = value;
  }
  const apiKey = resolveApiKey(args);
  if (apiKey !== undefined) body.apiKey = apiKey;
  const maxPeers = flagOf(args, "max-peers");
  if (maxPeers !== undefined) body.maxPeers = Number(maxPeers);
  const enabled = flagOf(args, "enabled");
  if (enabled !== undefined) body.enabled = enabled === "true";
  const enabledProtocols = flagOf(args, "enabled-protocols");
  if (enabledProtocols !== undefined) {
    body.enabledProtocols =
      enabledProtocols === "null"
        ? null
        : enabledProtocols
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
  }
  // A flag, not a value: the resolved address is something the panel observed,
  // never something an operator types. The panel looks a node's host up once
  // and keeps the answer -- correct, because a server's address does not change
  // under it. If one ever does while keeping the same DNS name, this is the
  // recovery: clear the stored IP and the next telemetry tick resolves again.
  if (args.includes("--clear-public-ip")) body.publicIp = null;
  if (Object.keys(body).length === 0) {
    throw new Error("Usage: node-update <id> --<field>=<value> …");
  }
  await api(`/api/admin/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  console.log(`node ${id} updated: ${Object.keys(body).join(", ")}`);
}

async function cmdNodeRemove(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  const usage =
    "Usage: node-remove <id> [--with-keys --confirm=<node name>]";
  if (!id) throw new Error(usage);
  const withKeys = args.includes("--with-keys");

  if (!withKeys) {
    // Plain delete. The API refuses with 409 NODE_HAS_KEYS when the node still
    // has keys, and its message already tells the operator what to do.
    await api(`/api/admin/nodes/${id}`, { method: "DELETE" });
    console.log(`node ${id} removed`);
    return;
  }

  // Deleting a node WITH its keys is destructive and irreversible, so it needs a
  // confirmation that cannot be produced by a stray flag: the operator has to
  // type the node's own name. A prompt is not an option — the CLI normally runs
  // through `docker exec` with no TTY.
  const nodes = await api<AdminNode[]>("/api/admin/nodes");
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`node ${id} not found`);
  const keys = await api<AdminKey[]>("/api/admin/keys");
  const affected = keys.filter((key) => key.nodeId === id);
  const owners = new Set(affected.map((key) => key.ownerId)).size;
  const confirm = flagOf(args, "confirm");
  if (confirm !== node.name) {
    throw new Error(
      [
        `About to DELETE node "${node.name}" and ${affected.length} key(s) of ${owners} user(s).`,
        "This cannot be undone, and peers already configured on that server keep",
        "working until the server itself is wiped — the panel cannot reach a node",
        "it is deleting.",
        "",
        `To proceed, repeat the command with: --confirm=${node.name}`,
      ].join("\n"),
    );
  }

  const result = await api<{
    deletedKeys: number;
    affectedOwners: number;
  }>(`/api/admin/nodes/${id}?deleteKeys=true`, { method: "DELETE" });
  console.log(
    `node ${node.name} removed with ${result.deletedKeys} key(s) of ${result.affectedOwners} user(s)`,
  );
}

async function cmdUserNodes(args: string[]): Promise<void> {
  const pos = positionals(args);
  const usage = "Usage: user-nodes <id|email> <all|none|uuid,uuid,…>";
  const id = await resolveUserId(pos[0], usage);
  if (pos[1] === undefined) throw new Error(usage);
  // set-policy REPLACES the user's per-user policy override with this object.
  const allowedNodeIds = parseNodeSpec(pos[1]);
  await userAction(id, "set-policy", { allowedNodeIds });
  const shown =
    allowedNodeIds === null
      ? "all"
      : allowedNodeIds.length
        ? allowedNodeIds.join(",")
        : "none";
  console.log(`user ${pos[0]}: node availability → ${shown}`);
}

async function cmdUserRoutes(args: string[]): Promise<void> {
  const pos = positionals(args);
  const usage =
    "Usage: user-routes <id|email> [--wl-domains=a,b] [--wl-cidrs=…] [--bl-domains=…] [--bl-cidrs=…]  (replaces the user's custom routes)";
  const id = await resolveUserId(pos[0], usage);
  const body = {
    ru_whitelist: {
      cidrs: csvList(flagOf(args, "wl-cidrs") ?? ""),
      domains: csvList(flagOf(args, "wl-domains") ?? ""),
    },
    ru_blacklist: {
      cidrs: csvList(flagOf(args, "bl-cidrs") ?? ""),
      domains: csvList(flagOf(args, "bl-domains") ?? ""),
    },
  };
  await userAction(id, "set-custom-routes", body);
  console.log(`user ${pos[0]}: custom routes updated`);
}

async function cmdUserCreateKey(args: string[]): Promise<void> {
  const pos = positionals(args);
  const usage =
    `Usage: user-create-key <id|email> --node=<uuid> [--device=<label>] [--protocol=awg3|awg2] [--route=full_tunnel|ru_whitelist|ru_blacklist] [${deviceTypeUsage()}] [--name-server=true|false] [--name-label=true|false] [--name-number=true|false]\n  --device-type=ios with a --route other than full_tunnel is warned about: route profiles do not filter on iPhone or iPad.`;
  const id = await resolveUserId(pos[0], usage);
  const nodeId = flagOf(args, "node");
  if (!nodeId) throw new Error(usage);
  const body: Record<string, unknown> = { nodeId };
  // Which parts the AmneziaVPN client shows as the connection name. Omitted
  // flags keep the API defaults (server + label, no number).
  const nameDisplay: Record<string, boolean> = {};
  for (const [flag, field] of [
    ["name-server", "server"],
    ["name-label", "label"],
    ["name-number", "number"],
  ] as const) {
    const value = flagOf(args, flag);
    if (value !== undefined) nameDisplay[field] = parseBoolFlag(flag, value);
  }
  if (Object.keys(nameDisplay).length > 0) body.nameDisplay = nameDisplay;
  const protocol = flagOf(args, "protocol");
  if (protocol) body.protocol = protocol;
  const device = flagOf(args, "device");
  if (device) body.deviceLabel = device;
  const route = flagOf(args, "route");
  if (route) body.routeProfile = route;
  const deviceType = flagOf(args, "device-type");
  if (deviceType) body.deviceType = parseDeviceType(deviceType);
  // Same check the create-key wizard applies (contracts:
  // deviceSupportsRouteProfiles). A warning, not a refusal — see the plan's D9.
  const warning = routeProfileWarning(deviceType, route);
  if (warning) console.error(warning);
  const result = (await userAction(id, "create-key", body)) as { id?: string };
  console.log(`key created for ${pos[0]}: ${result?.id ?? "(ok)"}`);
}

/**
 * Download one key's config. `--format=qr` writes the exact PNG a user is shown
 * for download, `--format=qr-svg` the exact SVG the panel displays to a camera
 * app, and `--format=qr-frames` the chunk-envelope series an in-app scanner
 * reads — AmneziaVPN and DefaultVPN alike, the format is the same — so either
 * half of a "the QR does not scan" report can be reproduced from a shell.
 */
async function cmdKeyConfig(args: string[]): Promise<void> {
  const usageText =
    "Usage: key-config <key-id> [--format=vpn|conf|qr|qr-svg|qr-frames] [--out=<path>] [--confirm]";
  const [keyId] = positionals(args);
  if (!keyId) throw new Error(usageText);
  const rawFormat = flagOf(args, "format") ?? "vpn";
  const format = CLI_CONFIG_FORMATS.find(
    (candidate): candidate is CliConfigFormat => candidate === rawFormat,
  );
  if (!format) throw new Error(usageText);
  const { body, headers } = await apiRaw(
    configRequestPath(keyId, format, confirmedFromArgs(args)),
  );
  // stderr, so `key-config --format=qr-svg > key.svg` still pipes cleanly.
  const params = formatQrParams(headers);
  if (params) console.error(`qr params: ${params}`);

  if (format === "qr-frames") {
    const parsed = JSON.parse(body.toString("utf8")) as {
      total: number;
      frames: string[];
    };
    // Frames are only useful as separate images, so `--out` names the stem.
    const base = (flagOf(args, "out") ?? keyId).replace(/\.svg$/i, "");
    for (const [index, frame] of parsed.frames.entries()) {
      const name = configFrameName(base, index);
      await writeFile(name, frame, "utf8");
      console.log(`${name} (${Buffer.byteLength(frame)} bytes)`);
    }
    console.log(`${parsed.total} frame(s) — readable only by the AmneziaVPN app`);
    return;
  }

  // Only `qr` gets a default file name: its bytes are binary and would be
  // mangled by a terminal. The text formats print, so they stay pipeable.
  const out =
    flagOf(args, "out") ??
    (format === "qr" ? configOutputName(keyId, format) : undefined);
  if (out) {
    await writeFile(out, body);
    console.log(`${out} (${body.length} bytes)`);
    return;
  }
  console.log(body.toString("utf8"));
}

/** Parse a `--flag=true|false` value, rejecting anything else. */
function parseBoolFlag(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} expects true/false, got "${value}"`);
}

type GlobalRouteList = { cidrs: string[]; domains: string[] };
type GlobalRouteProfile = { add: GlobalRouteList; exclude: GlobalRouteList };
type GlobalRoutes = Record<"ru_whitelist" | "ru_blacklist", GlobalRouteProfile>;

const emptyRouteList = (): GlobalRouteList => ({ cidrs: [], domains: [] });
const emptyRouteProfile = (): GlobalRouteProfile => ({
  add: emptyRouteList(),
  exclude: emptyRouteList(),
});

async function fetchGlobalRoutes(): Promise<GlobalRoutes> {
  const rows = await api<GlobalRoutes[]>("/api/admin/global-routes");
  const current = rows[0];
  return {
    ru_whitelist: current?.ru_whitelist ?? emptyRouteProfile(),
    ru_blacklist: current?.ru_blacklist ?? emptyRouteProfile(),
  };
}

async function cmdGlobalRoutes(args: string[]): Promise<void> {
  const routes = await fetchGlobalRoutes();
  if (wantsJson(args)) return json(routes);
  for (const profile of ["ru_whitelist", "ru_blacklist"] as const) {
    const entry = routes[profile];
    console.log(profile);
    for (const bucket of ["add", "exclude"] as const) {
      const list = entry[bucket];
      console.log(
        `  ${bucket} cidrs   (${list.cidrs.length}): ${list.cidrs.join(", ") || "-"}`,
      );
      console.log(
        `  ${bucket} domains (${list.domains.length}): ${list.domains.join(", ") || "-"}`,
      );
    }
  }
}

async function cmdGlobalRoutesSet(args: string[]): Promise<void> {
  const usage =
    "Usage: global-routes-set --profile=ru_whitelist|ru_blacklist [--add-domains=a,b] [--add-cidrs=...] [--exclude-domains=...] [--exclude-cidrs=...]  (each list given REPLACES that list)";
  const profile = flagOf(args, "profile");
  if (profile !== "ru_whitelist" && profile !== "ru_blacklist") {
    throw new Error(usage);
  }
  // The endpoint replaces the whole object, so read first and patch in place to
  // leave the other profile (and the lists no flag mentions) untouched.
  const routes = await fetchGlobalRoutes();
  const target = routes[profile];
  const changed: string[] = [];
  const apply = (
    bucket: "add" | "exclude",
    field: "cidrs" | "domains",
    flag: string,
  ) => {
    const value = flagOf(args, flag);
    if (value === undefined) return;
    target[bucket][field] = csvList(value);
    changed.push(flag);
  };
  apply("add", "cidrs", "add-cidrs");
  apply("add", "domains", "add-domains");
  apply("exclude", "cidrs", "exclude-cidrs");
  apply("exclude", "domains", "exclude-domains");
  if (changed.length === 0) throw new Error(usage);
  await api("/api/admin/global-routes/global/update", {
    method: "POST",
    body: JSON.stringify(routes),
  });
  console.log(`global routes ${profile}: updated ${changed.join(", ")}`);
}

async function cmdVersion(args: string[]): Promise<void> {
  const info = await api<CliVersionInfo>("/api/admin/version");
  if (wantsJson(args)) return json(info);
  console.log(formatVersionLine(info));
}

async function cmdTraffic(args: string[]): Promise<void> {
  const days = Number(flagOf(args, "days")) || 30;
  const data = await api<unknown>(`/api/admin/traffic?days=${days}`);
  json(data);
}

async function cmdPanelUpdate(args: string[]): Promise<void> {
  if (args.includes("--status")) {
    const status = await api<UpdateStatusView>("/api/admin/update");
    // --json stays byte-identical to the previous behaviour; the default is a
    // line an operator can read, including the updater's refusal reason.
    if (wantsJson(args)) return json(status);
    console.log(formatUpdateStatus(status));
    return;
  }
  const result = await api<unknown>("/api/admin/update", { method: "POST" });
  console.log("panel update requested (host updater runs backup → pull → migrate → restart)");
  json(result);
}

/**
 * What the panel currently hands users for each platform, and (with --refresh)
 * a forced re-resolve. The read uses the same route the web dialog uses, so
 * what this prints is exactly what a user sees.
 */
async function cmdClientReleases(args: string[]): Promise<void> {
  const release = args.includes("--refresh")
    ? await api<CliClientRelease>("/api/admin/client-releases/refresh", {
        method: "POST",
      })
    : await api<CliClientRelease>("/api/client-releases");
  if (wantsJson(args)) return json(release);
  console.log(clientReleaseSummary(release));
  console.log("");
  console.log(table(clientReleaseRows(release), CLIENT_RELEASE_COLUMNS));
}

function usage(): void {
  console.log(`amnezia-panel — control-plane admin CLI

Usage: amnezia-panel <command> [args] [--json]

Read:
  overview                 Key metrics
  users                    List users (with each user's effective key-limit mode;
                          * marks a mode set on the user rather than inherited)
  keys [--device-type=X]   List keys (with owner, platform + traffic); the flags filter
      [--node=<id>]       to one stored platform, "unspecified" included, and/or to
      [--needs-profile-warning]
                          one node — the non-destructive way to count what a
                          node-remove would take with it.
                          --needs-profile-warning lists only the keys whose platform
                          ignores route profiles yet carry a split tunnel, and adds
                          the route column
  nodes [--hosts]          List nodes (with protocols, capacity and the public
                          address clients connect to: "name (ip)" once the panel
                          has resolved a DNS name, "name (unresolved)" when it
                          never could, "—" when the node-agent does not report
                          one. --json also carries publicIpResolvedAt.
                          --hosts instead shows how the PANEL reaches each agent
                          (apiBaseUrl) classified ip / docker-local / dns
  audit [--limit=N]        Recent audit events
  quota [--all] [--json]   Key-limit requests (pending by default; --all = every state).
                          The target and "now → requested" cells are read in that
                          user's own key-limit mode: under a global (shared) limit a
                          request that named a server still reads "all servers"
  policy [--json]          Show all panel settings + Cloudflare config
  global-routes [--json]   Admin-wide route additions / exclusions
  version [--json]         Panel version + commit + the AWG 3.1 client floor
  traffic [--days=N]       Aggregate traffic series (JSON)
  client-releases [--refresh]  What the panel hands users per platform (Windows,
                          macOS, Android + APK, iOS), which release it resolved and
                          whether it is serving the offline fallback.
                          --refresh forces a re-resolve now (admin) instead of
                          waiting out the 6 h cache.

Users (accept a user id OR email):
  user-create <email> [name] [--admin]   Add a user
  user-role <id|email> <admin|user>      Promote / demote (last admin is protected)
  user-limit <id|email> <n|default> [--node-limits=<uuid>:<n>,…|none] [--allowed-nodes=all|none|uuid,…]
             [--mode=per_node|global|inherit]
                                         Set the key limit (default = clear the override).
                                         --node-limits REPLACES the per-node limits (none = clear);
                                         --allowed-nodes sets node availability (all = every node);
                                         --mode overrides how the number is counted for this user
                                         (global = one total across every server, per-server limits
                                         kept but dormant; inherit = clear the override).
                                         Omitted flags leave that part unchanged.
  user-disable <id|email>                Offboard: disable + revoke their keys
  user-enable <id|email>                 Reinstate a disabled user
  user-nodes <id|email> <all|none|uuid,…>  Per-user node availability (all=every node; overrides global).
                                         REPLACES the whole per-user policy override; use
                                         user-limit --allowed-nodes to change only availability.
  user-routes <id|email> [--wl-domains=] [--wl-cidrs=] [--bl-domains=] [--bl-cidrs=]  Replace a user's custom routes
  user-create-key <id|email> --node=<uuid> [--device=] [--protocol=awg3] [--route=full_tunnel]
                  [${deviceTypeUsage()}]
                  [--name-server=true|false] [--name-label=true|false] [--name-number=true|false]
                                         Create a key for a user. --device-type names the
                                         platform (ios covers iPhone and iPad). The --name-*
                                         flags pick which parts the VPN client shows as the
                                         connection name (default: server + label, no number)
  quota-approve <request-id> [note]      Approve a quota request. In per_node mode the limit
                                        lands on the request's own target (one server, or all
                                        servers); in global mode it always raises the shared
                                        total and leaves per-server limits untouched
  quota-reject <request-id> [note]       Reject a quota request

Nodes:
  node-add --name= --api-url= --api-key-file=<path|->  Register a node (see flags below;
                                          --api-key=<key> still works but lands in ps/history)
  node-update <id> --<field>=<value> …    Edit a node (name, api-url, api-key-file|api-key,
                                          public-name, protocol, max-peers,
                                          enabled=true|false, enabled-protocols)
  node-update <id> --clear-public-ip      Forget the resolved public IP so the
                                          worker looks it up again next tick
  node-remove <id>                        Delete a node (refused while it has keys)
  node-remove <id> --with-keys            Delete a node AND every key ever issued
             --confirm=<node name>        on it. Irreversible; the name must match
  node-reconcile <id>                     Trigger a node sync
  node-capacity <id> [--set=<peers>]     Show or change a node's peer capacity.
                       [--confirm]         Recreates only the node-agent, so no
                                           tunnel drops. Needs the host-side
                                           applier installed on that node.
  node-agent-update <id> [--image=<ref>]  Replace a node's agent with the published
                    [--confirm]           image. Without --confirm it prints what would
                                          be installed and changes nothing. One node at
                                          a time on purpose; there is no fleet variant
  node-agent-log <id>                     Show the node's last agent update and its log

  node-metrics [--json]                   Host metrics per node, with the panel's own warnings
  checks                                  List service checks and what each asserts
  check-results [<id>]                    Per-node verdicts (ok / failed / error)
  check-create --name= --url= <asserts>   Add a check; needs at least one assertion
  check-set <id> [flags] [<asserts>]      Change only the fields you name
  check-delete <id> [--confirm]           Delete a check and every node's result for it
  check-run <id>                          Mark it due on every node (result after the next poll)
  check-reset <id> | check-reset --all    Clear stored results; every node measures again next poll
  node-checks <node>                      What this node runs, and what it last answered
  node-checks <node> --all=on|off         Take one node in or out of checking entirely
  node-checks <node> --enable|--disable=<check>
                                          Turn one check on or off for this node only
    Assertion flags (repeatable; all must hold):
${assertionUsageLines().join("\n")}
  node-add flags: [--public-name=] [--protocol=awg3] [--max-peers=500]
                  [--enabled-protocols=awg3,awg2] [--disabled]

Write:
  key-purge <id> --confirm  Delete a revoked key from the panel entirely.
                            Refused in any other state.
  key-revoke <id>                         Revoke a key. Also retries a delete stuck in
                                          "revoking" because a node was unreachable
  key-disable <id> / key-enable <id>      Disable / enable a key
  key-internal-name <id> --name="<text>"  Set the operator-only note on a key; --name=
                                          with nothing after it clears it. Never shown
                                          to the key's owner, never in a config
  key-config <id> [--format=vpn|conf|qr|qr-svg|qr-frames]
             [--out=<path>] [--confirm]   Download a key's config. --format=qr writes a
                                          PNG (defaults to <id>.png unless --out is given);
                                          --format=qr-frames writes <id>.frame-N.svg, which
                                          only a VPN app's own scanner can read
                                          (AmneziaVPN and DefaultVPN alike);
                                          --confirm is required to read another user's key
  cf-token --token-file=<path|->          Store the Cloudflare API token (encrypted).
                                          cf-token <token> still works but lands in
                                          ps/history
  cf-config --account= --app= --policy=   Set Cloudflare Access IDs
  cf-sync [--status] [--json]             Ask for a Cloudflare Access reconcile now instead of
                                          waiting for the hourly timer (refuses if Cloudflare
                                          isn't configured — see cf-config / cf-token).
                                          --status shows the last run as one line, including a
                                          refused run's reason ("failed: …"); --json = the raw
                                          status object
  cf-domains [--add=<d> | --remove=<d> | --set=<a,b,...>|none]
                                          List, or edit, the domains admitted by the Access
                                          policy (one flag at a time). A bare --set= is refused
                                          (an unset shell variable, not a deliberate wipe) —
                                          use --set=none to clear the list explicitly, which
                                          prints what it removes first. Removing a domain
                                          disables nobody: it only drops the domain rule, and
                                          the next sync re-emits every signed-in user's own
                                          rule. A rejected domain shows the API's own reason.
  policy-set --<field>=<value> …          Set any panel setting(s), see below
  global-routes-set --profile=ru_whitelist|ru_blacklist [--add-domains=] [--add-cidrs=]
                    [--exclude-domains=] [--exclude-cidrs=]
                                          Admin-wide route overrides for a split-tunnel profile.
                                          Each list given REPLACES that list; omitted lists stay.
                                          Exclusions drop feed entries (excluding a domain also
                                          drops its subdomains); a user's own custom routes are
                                          applied last and can opt back in.
  panel-update [--status] [--json]        Trigger the in-panel update, or show its status
                                          as one line (--json = the raw status object)

policy-set fields:
  Booleans (true/false): allowKeyCreation, allowNodeSelection,
    allowRouteProfileSelection, allowCustomRoutes, allowConfigRedownload,
    allowQrDownload, allowConfDownload, allowSelfRevoke, showPublicKey,
    showLastUsed, showTraffic, showNodeAddress, showNodeStatus
    showNodeStatus=false hides the service-check chips from ordinary users
    showNodeAddress=true also shows ordinary users the address of each node
    they may use (off by default; admins always see it on the node card).
  defaultKeyLimit=<int 0..1000>
    Per server in per_node mode, the shared total in global mode — the number
    does not move, its meaning does.
  keyLimitMode=per_node|global            Panel-wide default for how every key
    limit is counted; a user can be moved off it with user-limit --mode=
  dailyRetentionDays=<int 1..36500 | null>
  allowedProtocols=awg3[,awg2]            allowedNodeIds=<uuid,…|null>
  nodeOrder=<uuid,…|none>                 (the order users see; the rest follow)
  recommendedNodeIds=<uuid,…|none>        (badge only; must be the top of nodeOrder)
  cfAccessAccountId / cfAccessAppId / cfAccessPolicyId=<id|null>
  cfApiToken=<token>   (write-only, encrypted)
  video-desktop / video-android / video-ios=<url|none>
    Walkthrough video shown in the panel's connection guide, per audience.
    A Google Drive share link (the file must be readable by anyone with the
    link) is embedded as a Drive preview; any other http(s) URL is played as a
    direct video file. Merges with the ones already set, so naming one audience
    does not clear the other two. These URLs are deployment settings and belong
    on your panel, never in the repository.
  e.g.  amnezia-panel policy-set --allowQrDownload=false --defaultKeyLimit=10
        amnezia-panel policy-set --video-ios=https://example.com/ios.mp4

Env (auth, in priority order):
  CONTROL_API_URL          default http://127.0.0.1:3001
  PANEL_IDENTITY_SECRET    co-located admin: mint an x-panel-identity token
  CLI_ADMIN_EMAIL          identity to act as (default: first BOOTSTRAP_ADMIN_EMAILS)
  BOOTSTRAP_ADMIN_EMAILS   fallback identity source for the above
  CF_ACCESS_CLIENT_ID
  CF_ACCESS_CLIENT_SECRET  auth through Cloudflare Access (service token)
  PANEL_ADMIN_EMAIL        dev auth (x-dev-user-email; dev API only)
`);
}


type AdminServiceCheck = {
  id: string;
  name: string;
  probe: { kind: string; url?: string; method?: string };
  assertions: Array<Record<string, unknown>>;
  intervalSec: number;
  enabled: boolean;
  results?: Array<{
    nodeId: string;
    nodeName: string;
    status: string;
    httpStatus: number | null;
    latencyMs: number | null;
    detail: string | null;
    finalUrl: string | null;
    checkedAt: string;
    failingSince: string | null;
  }>;
};

async function findServiceCheck(id: string): Promise<AdminServiceCheck> {
  const checks = await api<AdminServiceCheck[]>("/api/admin/service-checks");
  const check = checks.find((row) => row.id === id || row.name === id);
  if (!check) throw new Error(`No service check with id or name ${id}`);
  return check;
}

async function cmdChecks(args: string[]): Promise<void> {
  const checks = await api<AdminServiceCheck[]>("/api/admin/service-checks");
  if (wantsJson(args)) return json(checks);
  if (checks.length === 0) {
    console.log("No service checks are defined.");
    return;
  }
  console.log(
    table(
      checks.map((check) => ({
        id: check.id,
        name: check.name,
        target: check.probe?.url ?? check.probe?.kind ?? "—",
        every: `${Math.round(check.intervalSec / 60)}m`,
        enabled: check.enabled ? "yes" : "no",
        asserts: describeAssertions(check.assertions ?? []),
      })),
      ["id", "name", "target", "every", "enabled", "asserts"],
    ),
  );
}

async function cmdCheckResults(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  const checks = await api<AdminServiceCheck[]>("/api/admin/service-checks");
  const selected = id
    ? checks.filter((check) => check.id === id || check.name === id)
    : checks;
  if (id && selected.length === 0) {
    throw new Error(`No service check with id or name ${id}`);
  }
  if (wantsJson(args)) {
    return json(
      selected.map((check) => ({ name: check.name, results: check.results ?? [] })),
    );
  }
  const rows = selected.flatMap((check) =>
    (check.results ?? []).map((result) => ({
      check: check.name,
      node: result.nodeName,
      // The three statuses stay distinct here for the same reason they do in
      // the UI: `error` means the node could not look, so nothing is known
      // about the service.
      result: resultLabel(result),
      when: result.checkedAt,
      "failing since": result.failingSince ?? "—",
      "final url": result.finalUrl ?? "—",
    })),
  );
  if (rows.length === 0) {
    console.log("No results yet. Run `check-run <id>` and wait for a poll.");
    return;
  }
  console.log(
    table(rows, ["check", "node", "result", "when", "failing since", "final url"]),
  );
}

async function cmdCheckCreate(args: string[]): Promise<void> {
  const name = flagOf(args, "name");
  if (!name) throw new Error("Usage: check-create --name=<name> --url=<url> <assertion flags>");
  const probe = parseProbe(
    flagOf(args, "url"),
    flagOf(args, "method"),
    flagOf(args, "timeout-ms"),
  );
  const assertions = parseAssertions(args);
  if (assertions.length === 0) {
    throw new Error(
      "A check needs at least one assertion, or it is always green. Try --status-in=200.",
    );
  }
  const interval = flagOf(args, "interval-sec");
  const created = await api<AdminServiceCheck>("/api/admin/service-checks", {
    method: "POST",
    body: JSON.stringify({
      name,
      probe,
      assertions,
      ...(interval === undefined ? {} : { intervalSec: Number(interval) }),
    }),
  });
  console.log(`check ${created.name} created (${created.id})`);
}

async function cmdCheckSet(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: check-set <id> [--name=] [--url=] [--interval-sec=] [--enabled=true|false] <assertion flags>");
  const check = await findServiceCheck(id);
  const url = flagOf(args, "url");
  const assertions = parseAssertions(args);
  const enabled = flagOf(args, "enabled");
  const interval = flagOf(args, "interval-sec");
  const name = flagOf(args, "name");
  // Only what was named. The API refuses an empty patch, and sending the whole
  // check back would silently overwrite fields this invocation never mentioned.
  const patch = {
    ...(name === undefined ? {} : { name }),
    ...(url === undefined
      ? {}
      : {
          probe: parseProbe(url, flagOf(args, "method"), flagOf(args, "timeout-ms")),
        }),
    ...(assertions.length === 0 ? {} : { assertions }),
    ...(interval === undefined ? {} : { intervalSec: Number(interval) }),
    ...(enabled === undefined ? {} : { enabled: enabled !== "false" }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("Nothing to change. Give at least one of --name, --url, --interval-sec, --enabled or an assertion flag.");
  }
  await api(`/api/admin/service-checks/${check.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  console.log(`check ${check.name}: ${Object.keys(patch).join(", ")} updated`);
}

async function cmdCheckDelete(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: check-delete <id> [--confirm]");
  const check = await findServiceCheck(id);
  if (!args.includes("--confirm")) {
    console.log(`check ${check.name} (${check.id})`);
    console.log("  every node's result for it is deleted with it.");
    console.log("Re-run with --confirm to delete it.");
    return;
  }
  await api(`/api/admin/service-checks/${check.id}`, { method: "DELETE" });
  console.log(`check ${check.name} deleted`);
}

async function cmdCheckRun(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: check-run <id>");
  const check = await findServiceCheck(id);
  await api(`/api/admin/service-checks/${check.id}/run`, { method: "POST" });
  // Deliberately not "done": this marks the check due. The reading appears
  // after the next telemetry poll, and saying otherwise would have an operator
  // reading a stale row and concluding the check is broken.
  console.log(
    `check ${check.name}: marked due on every node; results appear after the next poll`,
  );
}


async function cmdNodeMetrics(args: string[]): Promise<void> {
  const nodes = await api<AdminNode[]>("/api/admin/nodes");
  if (wantsJson(args)) {
    return json(
      nodes.map((node) => ({
        id: node.id,
        name: node.name,
        metrics: node.metrics ?? null,
        endpoint: node.endpoint ?? null,
      })),
    );
  }
  if (nodes.length === 0) {
    console.log("No nodes are registered.");
    return;
  }
  console.log(
    table(
      nodes.map((node) => {
        const metrics = node.metrics;
        return {
          node: node.name,
          // A dash, never a zero. A zero here reads as a measurement, and "this
          // agent does not report swap" is not "this host has no swap".
          ram: metricPair(metrics?.memAvailableBytes, metrics?.memTotalBytes),
          swap: metricPair(metrics?.swapUsedBytes, metrics?.swapTotalBytes),
          disk:
            metrics?.diskUsedPercent === null || metrics?.diskUsedPercent === undefined
              ? "—"
              : `${metrics.diskUsedPercent}%`,
          load:
            metrics?.load1 === null || metrics?.load1 === undefined
              ? "—"
              : `${metrics.load1.toFixed(2)}/${metrics.cpuCores ?? "?"}`,
          pids: `${metrics?.agentPidsCurrent ?? "—"}/${metrics?.agentPidsMax ?? "—"}`,
          awg3: awgCell(metrics?.awg3Up, metrics?.awg3Peers),
          // Reported only where AWG 2.0 is actually enabled - a dash means the
          // node does not serve it, not that the reading failed. It is in the
          // table rather than only in --json because hiding a protocol the panel
          // deliberately reports would undo that decision for anyone without a
          // browser.
          awg2: awgCell(metrics?.awg2Up, metrics?.awg2Peers),
          agent: metrics?.agentLatencyMs === null || metrics?.agentLatencyMs === undefined
            ? "—"
            : `${metrics.agentLatencyMs}ms`,
          handshake: handshakeCell(node.endpoint?.lastHandshakeAt ?? null),
        };
      }),
      ["node", "ram", "swap", "disk", "load", "pids", "awg3", "awg2", "agent", "handshake"],
    ),
  );
  const warnings = nodes.flatMap((node) => metricWarnings(node.name, node.metrics));
  if (warnings.length > 0) {
    // The same three numbers the admin card paints red. An operator over SSH
    // got the raw figures and no idea which one the panel considers a problem.
    console.log("");
    for (const warning of warnings) console.log(warning);
  }
}


async function cmdCheckReset(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id && !args.includes("--all")) {
    throw new Error("Usage: check-reset <id> | check-reset --all");
  }
  if (id) {
    const check = await findServiceCheck(id);
    const result = await api<{ cleared: number }>(
      `/api/admin/service-checks/${check.id}/results`,
      { method: "DELETE" },
    );
    console.log(`check ${check.name}: ${result.cleared} result(s) cleared`);
  } else {
    const result = await api<{ cleared: number }>(
      "/api/admin/service-checks/results",
      { method: "DELETE" },
    );
    console.log(`${result.cleared} result(s) cleared across every check`);
  }
  // Not "deleted": the stored result IS the schedule, so a cleared check is due
  // again and measures itself afresh. Saying "deleted" would read as data loss.
  console.log("Every node measures the check again on its next poll.");
}

async function cmdNodeChecks(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    throw new Error(
      "Usage: node-checks <node> [--all=on|off] [--enable=<check>] [--disable=<check>]",
    );
  }
  const node = await findAdminNode(id);
  const all = flagOf(args, "all");
  const enable = flagOf(args, "enable");
  const disable = flagOf(args, "disable");

  if (all === undefined && enable === undefined && disable === undefined) {
    // Report, not a no-op error: "what does this node run" is the question an
    // operator asks first, and it needs no flags.
    const checks = await api<AdminServiceCheck[]>("/api/admin/service-checks");
    const disabled = new Set(node.disabledCheckIds ?? []);
    console.log(
      `node ${node.name}: service checks ${node.checksEnabled === false ? "OFF" : "on"}`,
    );
    console.log(
      table(
        checks.map((check) => ({
          check: check.name,
          runs:
            node.checksEnabled === false
              ? "no (node off)"
              : disabled.has(check.id)
                ? "no"
                : "yes",
          result:
            check.results?.find((row) => row.nodeId === node.id)?.status ?? "—",
        })),
        ["check", "runs", "result"],
      ),
    );
    return;
  }

  const patch: { checksEnabled?: boolean; disabledCheckIds?: string[] } = {};
  if (all !== undefined) patch.checksEnabled = all !== "off" && all !== "false";
  if (enable !== undefined || disable !== undefined) {
    const check = await findServiceCheck((enable ?? disable) as string);
    const current = new Set(node.disabledCheckIds ?? []);
    if (enable !== undefined) current.delete(check.id);
    else current.add(check.id);
    patch.disabledCheckIds = [...current];
  }
  await api(`/api/admin/nodes/${node.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  console.log(`node ${node.name}: ${Object.keys(patch).join(", ")} updated`);
}

/**
 * Parse a command line and run it. Exported so tests can drive the CLI
 * end-to-end (stubbing `fetch`) without spawning a subprocess; the bottom of
 * this file only calls it when the file is executed directly, so importing
 * main.ts for a test never runs a command against `process.argv`.
 */
export async function dispatch(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "overview":
      return cmdOverview(args);
    case "users":
      return cmdUsers(args);
    case "keys":
      return cmdKeys(args);
    case "nodes":
      return cmdNodes(args);
    case "audit":
      return cmdAudit(args);
    case "version":
      return cmdVersion(args);
    case "traffic":
      return cmdTraffic(args);
    case "panel-update":
      return cmdPanelUpdate(args);
    case "client-releases":
      return cmdClientReleases(args);
    case "user-create":
      return cmdUserCreate(args);
    case "user-role":
      return cmdUserRole(args);
    case "user-limit":
      return cmdUserLimit(args);
    case "user-disable":
      return cmdUserDisable(args);
    case "user-enable":
      return cmdUserEnable(args);
    case "user-nodes":
      return cmdUserNodes(args);
    case "user-routes":
      return cmdUserRoutes(args);
    case "user-create-key":
      return cmdUserCreateKey(args);
    case "quota":
    case "quota-requests":
      return cmdQuota(args);
    case "quota-approve":
      return cmdQuotaReview("approve", args);
    case "quota-reject":
      return cmdQuotaReview("reject", args);
    case "node-add":
    case "node-register":
      return cmdNodeAdd(args);
    case "node-update":
      return cmdNodeUpdate(args);
    case "node-remove":
    case "node-delete":
      return cmdNodeRemove(args);
    case "node-reconcile":
      return cmdAction("nodes", "reconcile", args);
    case "node-capacity":
      return cmdNodeCapacity(args);
    case "node-agent-update":
      return cmdNodeAgentUpdate(args);
    case "node-agent-log":
      return cmdNodeAgentLog(args);
    case "key-purge":
      return cmdKeyPurge(args);
    case "key-revoke":
      return cmdAction("keys", "revoke", args);
    case "key-disable":
      return cmdAction("keys", "disable", args);
    case "key-enable":
      return cmdAction("keys", "enable", args);
    case "key-internal-name":
      return cmdKeyInternalName(args);
    case "key-config":
      return cmdKeyConfig(args);
    case "cf-token":
      return cmdCfToken(args);
    case "cf-config":
      return cmdCfConfig(args);
    case "cf-sync":
      return cmdCfSync(args);
    case "cf-domains":
      return cmdCfDomains(args);
    case "policy":
      return cmdPolicy(args);
    case "policy-set":
      return cmdPolicySet(args);
    case "global-routes":
      return cmdGlobalRoutes(args);
    case "node-metrics":
      return cmdNodeMetrics(args);
    case "checks":
      return cmdChecks(args);
    case "check-results":
      return cmdCheckResults(args);
    case "check-create":
      return cmdCheckCreate(args);
    case "check-set":
      return cmdCheckSet(args);
    case "check-delete":
      return cmdCheckDelete(args);
    case "check-run":
      return cmdCheckRun(args);
    case "check-reset":
      return cmdCheckReset(args);
    case "node-checks":
      return cmdNodeChecks(args);
    case "global-routes-set":
      return cmdGlobalRoutesSet(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exitCode = 1;
  }
}

/**
 * Only run as a CLI when this file is the entry point — importing it (e.g.
 * from main.test.ts) must never dispatch a command against process.argv.
 *
 * Both sides are resolved to a real path before comparing: Node leaves
 * `process.argv[1]` as the path the shell invoked (no symlink resolution),
 * while the ESM loader always realpaths the module it turns into
 * `import.meta.url`. Comparing the raw values is fine for a direct `node
 * dist/main.js` invocation, but is false whenever `dist/main.js` is reached
 * through a symlink — exactly what `apps/cli/package.json`'s `bin` produces
 * under `npm link` or a `.bin` shim — which would make the CLI exit 0 having
 * dispatched nothing. `realpathSync` throws if the path does not exist at
 * all, which a real invocation of this file never hits.
 */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  dispatch(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
