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

const API = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);

function authHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  }
  const email = process.env.PANEL_ADMIN_EMAIL;
  if (email) return { "x-dev-user-email": email };
  throw new Error(
    "No credentials. Set PANEL_ADMIN_EMAIL (dev) or CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET (prod).",
  );
}

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
      })),
      ["email", "role", "status", "limit"],
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
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const usage = "Usage: user-limit <id|email> <n|default>";
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
  await userAction(id, "set-limit", { keyLimitOverride });
  console.log(`user ${positional[0]}: key limit → ${keyLimitOverride ?? "default"}`);
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
  console.log(
    table(
      requests.map((req) => ({
        id: req.id,
        user: emailById.get(req.userId) ?? req.userId.slice(0, 8),
        change: `${limitById.get(req.userId) ?? "default"} → ${req.requestedLimit}`,
        status: req.status,
        reason: (req.reason ?? "").replace(/\s+/g, " ").slice(0, 40),
      })),
      ["id", "user", "change", "status", "reason"],
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
  const parseBool = (name: string, value: string): boolean => {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`--${name} expects true/false, got "${value}"`);
  };
  const body: Record<string, unknown> = {};
  for (const field of POLICY_BOOL_FIELDS) {
    const value = flag(field);
    if (value !== undefined) body[field] = parseBool(field, value);
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

function usage(): void {
  console.log(`amnezia-panel — control-plane admin CLI

Usage: amnezia-panel <command> [args] [--json]

Read:
  overview                 Key metrics
  users                    List users
  keys                     List keys (with owner + traffic)
  nodes                    List nodes (with protocols + capacity)
  audit [--limit=N]        Recent audit events
  quota [--json]           Pending key-limit (quota) requests, with ids
  policy [--json]          Show all panel settings + Cloudflare config

Users (accept a user id OR email):
  user-create <email> [name] [--admin]   Add a user
  user-role <id|email> <admin|user>      Promote / demote (last admin is protected)
  user-limit <id|email> <n|default>      Set key-limit override (default = clear)
  user-disable <id|email>                Offboard: disable + revoke their keys
  user-enable <id|email>                 Reinstate a disabled user
  quota-approve <request-id> [note]      Approve a quota request (applies the limit)
  quota-reject <request-id> [note]       Reject a quota request

Write:
  node-reconcile <id>                     Trigger a node sync
  key-revoke <id>                         Revoke a key
  key-disable <id> / key-enable <id>      Disable / enable a key
  cf-token <token>                        Store the Cloudflare API token (encrypted)
  cf-config --account= --app= --policy=   Set Cloudflare Access IDs
  policy-set --<field>=<value> …          Set any panel setting(s), see below

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

Env:
  CONTROL_API_URL          default http://127.0.0.1:3001
  PANEL_ADMIN_EMAIL        dev auth (x-dev-user-email)
  CF_ACCESS_CLIENT_ID
  CF_ACCESS_CLIENT_SECRET  prod auth (Cloudflare Access service token)
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
    case "quota":
    case "quota-requests":
      return cmdQuota(args);
    case "quota-approve":
      return cmdQuotaReview("approve", args);
    case "quota-reject":
      return cmdQuotaReview("reject", args);
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
