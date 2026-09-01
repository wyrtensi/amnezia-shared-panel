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

import { authHeaders } from "./identity.js";
import {
  flagOf,
  positionals,
  csvList,
  parseNodeLimits,
  parseNodeSpec,
} from "./args.js";

const API = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 400)}`);
  }
  return (body ? JSON.parse(body) : undefined) as T;
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
  policyOverride?: { allowedNodeIds?: string[] | null } | null;
};
type AdminKey = {
  id: string;
  ownerId: string;
  state: string;
  protocol: string;
  deviceLabel: string;
  routeProfile: string;
  online?: boolean;
  traffic?: { receivedBytes: string; sentBytes: string } | null;
};
type AdminNode = {
  id: string;
  name: string;
  enabled: boolean;
  protocol: string;
  enabledProtocols?: string[] | null;
  supportedProtocols?: string[];
  peerCount?: number;
  maxPeers: number;
  lastError: string | null;
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

async function cmdUsers(args: string[]): Promise<void> {
  const users = await api<AdminUser[]>("/api/admin/users");
  if (wantsJson(args)) return json(users);
  console.log(
    table(
      users.map((user) => ({
        email: user.email,
        role: user.role,
        status: user.status,
        limit: user.keyLimitOverride?.toString() ?? "default",
        // Counts only; `user-limit --node-limits=` shows and sets the detail.
        nodes: describeUserNodes(user),
      })),
      ["email", "role", "status", "limit", "nodes"],
    ),
  );
}

async function cmdKeys(args: string[]): Promise<void> {
  const [keys, users] = await Promise.all([
    api<AdminKey[]>("/api/admin/keys"),
    api<AdminUser[]>("/api/admin/users"),
  ]);
  if (wantsJson(args)) return json(keys);
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  console.log(
    table(
      keys.map((key) => ({
        device: key.deviceLabel || "—",
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
      ["device", "owner", "state", "proto", "online", "traffic"],
    ),
  );
}

async function cmdNodes(args: string[]): Promise<void> {
  const nodes = await api<AdminNode[]>("/api/admin/nodes");
  if (wantsJson(args)) return json(nodes);
  console.log(
    table(
      nodes.map((node) => ({
        name: node.name,
        enabled: node.enabled ? "yes" : "no",
        protocols: (node.enabledProtocols?.length
          ? node.enabledProtocols
          : (node.supportedProtocols ?? [node.protocol])
        ).join(","),
        peers: `${node.peerCount ?? 0}/${node.maxPeers}`,
        health: node.lastError ? "ERROR" : "ok",
      })),
      ["name", "enabled", "protocols", "peers", "health"],
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
    "Usage: user-limit <id|email> <n|default> [--node-limits=<uuid>:<n>,…|none] [--allowed-nodes=all|none|uuid,…]";
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
  const [requests, users] = await Promise.all([
    api<QuotaRequest[]>("/api/admin/quota-requests"),
    api<AdminUser[]>("/api/admin/users"),
  ]);
  if (wantsJson(args)) return json(requests);
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const limitById = new Map(
    users.map((user) => [user.id, user.keyLimitOverride]),
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
      rows.map((req) => ({
        id: req.id,
        user: emailById.get(req.userId) ?? req.userId.slice(0, 8),
        change: `${limitById.get(req.userId) ?? "default"} → ${req.requestedLimit}`,
        status: req.status,
        created: (req.createdAt ?? "").replace("T", " ").slice(0, 16),
        reason: (req.reason ?? "").replace(/\s+/g, " ").slice(0, 36) || "—",
      })),
      ["id", "user", "change", "status", "created", "reason"],
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
  const token = args.find((arg) => !arg.startsWith("--"));
  if (!token) throw new Error("Usage: cf-token <cloudflare-api-token>");
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
] as const;
const POLICY_INT_FIELDS = ["defaultKeyLimit"] as const;
const POLICY_INT_NULL_FIELDS = ["dailyRetentionDays"] as const;
const POLICY_STR_NULL_FIELDS = [
  "cfAccessAccountId",
  "cfAccessAppId",
  "cfAccessPolicyId",
] as const;
const POLICY_STR_FIELDS = ["cfApiToken"] as const;

async function cmdPolicy(args: string[]): Promise<void> {
  const rows = await api<Array<Record<string, unknown>>>(
    "/api/admin/portal-policy",
  );
  const policy = rows[0] ?? {};
  if (wantsJson(args)) return json(policy);
  for (const [key, value] of Object.entries(policy)) {
    const shown = Array.isArray(value)
      ? value.length
        ? value.join(",")
        : "(all)"
      : String(value);
    console.log(`${key.padEnd(28)} ${shown}`);
  }
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

async function cmdNodeAdd(args: string[]): Promise<void> {
  const name = flagOf(args, "name");
  const apiBaseUrl = flagOf(args, "api-url");
  const apiKey = flagOf(args, "api-key");
  if (!name || !apiBaseUrl || !apiKey) {
    throw new Error(
      "Usage: node-add --name= --api-url= --api-key= [--public-name=] " +
        "[--protocol=awg3] [--max-peers=500] [--enabled-protocols=awg3,awg2] [--disabled]",
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
    ["api-key", "apiKey"],
    ["protocol", "protocol"],
  ];
  for (const [cli, field] of strFields) {
    const value = flagOf(args, cli);
    if (value !== undefined) body[field] = value;
  }
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
  if (!id) throw new Error("Usage: node-remove <id>");
  await api(`/api/admin/nodes/${id}`, { method: "DELETE" });
  console.log(`node ${id} removed`);
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
    "Usage: user-create-key <id|email> --node=<uuid> [--device=<label>] [--protocol=awg3|awg2] [--route=full_tunnel|ru_whitelist|ru_blacklist] [--device-type=<type>] [--name-server=true|false] [--name-label=true|false] [--name-number=true|false]";
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
  if (deviceType) body.deviceType = deviceType;
  const result = (await userAction(id, "create-key", body)) as { id?: string };
  console.log(`key created for ${pos[0]}: ${result?.id ?? "(ok)"}`);
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
  const info = await api<{ version?: string; commit?: string }>(
    "/api/admin/version",
  );
  if (wantsJson(args)) return json(info);
  console.log(`version: ${info.version ?? "?"}   commit: ${info.commit ?? "?"}`);
}

async function cmdTraffic(args: string[]): Promise<void> {
  const days = Number(flagOf(args, "days")) || 30;
  const data = await api<unknown>(`/api/admin/traffic?days=${days}`);
  json(data);
}

async function cmdPanelUpdate(args: string[]): Promise<void> {
  if (args.includes("--status")) {
    json(await api<unknown>("/api/admin/update"));
    return;
  }
  const result = await api<unknown>("/api/admin/update", { method: "POST" });
  console.log("panel update requested (host updater runs backup → pull → migrate → restart)");
  json(result);
}

function usage(): void {
  console.log(`amnezia-panel — control-plane admin CLI

Usage: amnezia-panel <command> [args] [--json]

Read:
  overview                 Key metrics
  users                    List users
  keys                     List keys (with owner + traffic)
  nodes                    List nodes (with protocols + capacity)
  audit [--limit=N]        Recent audit events
  quota [--all] [--json]   Key-limit requests (pending by default; --all = every state)
  policy [--json]          Show all panel settings + Cloudflare config
  global-routes [--json]   Admin-wide route additions / exclusions
  version [--json]         Panel version + commit
  traffic [--days=N]       Aggregate traffic series (JSON)

Users (accept a user id OR email):
  user-create <email> [name] [--admin]   Add a user
  user-role <id|email> <admin|user>      Promote / demote (last admin is protected)
  user-limit <id|email> <n|default> [--node-limits=<uuid>:<n>,…|none] [--allowed-nodes=all|none|uuid,…]
                                         Set the per-node key limit (default = clear the override).
                                         --node-limits REPLACES the per-node limits (none = clear);
                                         --allowed-nodes sets node availability (all = every node).
                                         Omitted flags leave that part unchanged.
  user-disable <id|email>                Offboard: disable + revoke their keys
  user-enable <id|email>                 Reinstate a disabled user
  user-nodes <id|email> <all|none|uuid,…>  Per-user node availability (all=every node; overrides global).
                                         REPLACES the whole per-user policy override; use
                                         user-limit --allowed-nodes to change only availability.
  user-routes <id|email> [--wl-domains=] [--wl-cidrs=] [--bl-domains=] [--bl-cidrs=]  Replace a user's custom routes
  user-create-key <id|email> --node=<uuid> [--device=] [--protocol=awg3] [--route=full_tunnel]
                  [--name-server=true|false] [--name-label=true|false] [--name-number=true|false]
                                         Create a key for a user. The --name-* flags pick which
                                         parts the VPN client shows as the connection name
                                         (default: server + label, no number)
  quota-approve <request-id> [note]      Approve a quota request (applies the limit)
  quota-reject <request-id> [note]       Reject a quota request

Nodes:
  node-add --name= --api-url= --api-key=  Register a node (see flags below)
  node-update <id> --<field>=<value> …    Edit a node (name, api-url, api-key,
                                          public-name, protocol, max-peers,
                                          enabled=true|false, enabled-protocols)
  node-remove <id>                        Delete a node
  node-reconcile <id>                     Trigger a node sync
  node-add flags: [--public-name=] [--protocol=awg3] [--max-peers=500]
                  [--enabled-protocols=awg3,awg2] [--disabled]

Write:
  key-revoke <id>                         Revoke a key
  key-disable <id> / key-enable <id>      Disable / enable a key
  cf-token <token>                        Store the Cloudflare API token (encrypted)
  cf-config --account= --app= --policy=   Set Cloudflare Access IDs
  policy-set --<field>=<value> …          Set any panel setting(s), see below
  global-routes-set --profile=ru_whitelist|ru_blacklist [--add-domains=] [--add-cidrs=]
                    [--exclude-domains=] [--exclude-cidrs=]
                                          Admin-wide route overrides for a split-tunnel profile.
                                          Each list given REPLACES that list; omitted lists stay.
                                          Exclusions drop feed entries (excluding a domain also
                                          drops its subdomains); a user's own custom routes are
                                          applied last and can opt back in.
  panel-update [--status]                 Trigger the in-panel update (or show its status)

policy-set fields:
  Booleans (true/false): allowKeyCreation, allowNodeSelection,
    allowRouteProfileSelection, allowCustomRoutes, allowConfigRedownload,
    allowQrDownload, allowConfDownload, allowSelfRevoke, showPublicKey,
    showLastUsed, showTraffic
  defaultKeyLimit=<int 0..1000>
  dailyRetentionDays=<int 1..36500 | null>
  allowedProtocols=awg3[,awg2]            allowedNodeIds=<uuid,…|null>
  cfAccessAccountId / cfAccessAppId / cfAccessPolicyId=<id|null>
  cfApiToken=<token>   (write-only, encrypted)
  e.g.  amnezia-panel policy-set --allowQrDownload=false --defaultKeyLimit=10

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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
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
    case "key-revoke":
      return cmdAction("keys", "revoke", args);
    case "key-disable":
      return cmdAction("keys", "disable", args);
    case "key-enable":
      return cmdAction("keys", "enable", args);
    case "cf-token":
      return cmdCfToken(args);
    case "cf-config":
      return cmdCfConfig(args);
    case "policy":
      return cmdPolicy(args);
    case "policy-set":
      return cmdPolicySet(args);
    case "global-routes":
      return cmdGlobalRoutes(args);
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
