/** Pure argument helpers, kept out of main.ts so they are unit-testable. */

/** Value of a `--name=value` flag, or undefined. Values may contain `=`. */
export const flagOf = (args: string[], name: string): string | undefined => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : undefined;
};

/** Positional args (everything not starting with `--`). */
export const positionals = (args: string[]): string[] =>
  args.filter((arg) => !arg.startsWith("--"));

/** Split a comma-separated value into a trimmed, non-empty list. */
export const csvList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Parse a node-availability spec for the per-user override:
 *   "all"  -> null  (no restriction: every node)
 *   "none" -> []    (no node available)
 *   "a,b"  -> ["a","b"]
 */
export const parseNodeSpec = (spec: string): string[] | null => {
  if (spec === "all") return null;
  if (spec === "none") return [];
  return csvList(spec);
};

/**
 * Parse a per-node key-limit spec for the per-user override:
 *   ""/"none"/"clear" -> null            (drop every per-node limit)
 *   "<id>:2,<id>:0"   -> { id: 2, id: 0 }
 *
 * Limits must be integers in 0..1000; 0 means "no keys on that node".
 */
export const parseNodeLimits = (
  spec: string,
): Record<string, number> | null => {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "none" || trimmed === "clear") return null;
  const limits: Record<string, number> = {};
  for (const entry of csvList(trimmed)) {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(`Invalid node limit "${entry}" — expected <nodeId>:<n>`);
    }
    const nodeId = entry.slice(0, separator).trim();
    const raw = entry.slice(separator + 1).trim();
    const limit = Number(raw);
    if (!nodeId || raw === "" || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
      throw new Error(
        `Invalid node limit "${entry}" — limit must be an integer 0..1000`,
      );
    }
    limits[nodeId] = limit;
  }
  return limits;
};

/**
 * Shape of `GET /api/admin/update` as far as the rendering below cares. Every
 * field is optional so a host running an older updater (or a run that was
 * refused before it could name an id) still renders.
 */
export type UpdateStatusView = {
  enabled: boolean;
  pending?: { id?: string; requestedAt?: string } | null;
  lastResult?: {
    id?: string;
    ok?: boolean;
    finishedAt?: string;
    /** Written by panel-updater.sh. */
    message?: string;
    /** Alternate spelling accepted so a refusal reason is never dropped. */
    error?: string;
  } | null;
};

/**
 * Human-readable `panel-update --status`. Pure: it prints the timestamps it is
 * handed and never reads a clock, so the output is reproducible under test.
 *
 * The failure line matters most — the host updater can refuse a request and
 * exit without ever running an update, and that outcome is otherwise invisible
 * from the panel and the CLI (there is no TTY on the host).
 */
export const formatUpdateStatus = (status: UpdateStatusView): string => {
  if (!status.enabled) return "update mechanism not configured on this host";
  const lines: string[] = [];
  const pending = status.pending;
  lines.push(
    pending
      ? `pending: ${pending.id ?? "unknown"}${
          pending.requestedAt ? ` (requested ${pending.requestedAt})` : ""
        }`
      : "pending: none",
  );
  const last = status.lastResult;
  if (!last) {
    lines.push("last run: none recorded");
    return lines.join("\n");
  }
  const outcome = last.ok ? "ok" : "FAILED";
  const detail = last.error ?? last.message;
  lines.push(
    `last run: ${outcome} — ${last.id ?? "unknown"}${
      last.finishedAt ? ` at ${last.finishedAt}` : ""
    }${detail ? `: ${detail}` : ""}`,
  );
  return lines.join("\n");
};

/**
 * Shape of `GET /api/admin/access-sync` as far as the rendering below cares.
 * `job_outbox` shares this status machine with `rules.refresh`, and "idle"
 * (no row at all) means nobody has ever asked for a reconcile.
 */
export type AccessSyncStatusView = {
  status: "idle" | "pending" | "processing" | "completed" | "failed";
  queuedAt?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
};

/**
 * Human-readable `cf-sync --status`, one line.
 *
 * A run that refused to act — Cloudflare unconfigured, or the blast-radius
 * cap tripped — still finishes as "failed" with the reason, deliberately not
 * reported as success, so the failed branch is the one that matters most.
 */
export const formatAccessSyncStatus = (status: AccessSyncStatusView): string => {
  switch (status.status) {
    case "idle":
      return "no reconcile requested yet";
    case "pending":
      return `pending since ${status.queuedAt ?? "unknown"}`;
    case "processing":
      return "running";
    case "completed":
      return `completed at ${status.completedAt ?? "unknown"}`;
    case "failed":
      return `failed: ${status.lastError ?? "unknown reason"}`;
  }
};

/**
 * Device types `--device-type` accepts. A deliberate copy of
 * `deviceTypeSchema.options` in @amnezia/contracts: this CLI ships with no
 * dependencies, so the list is duplicated and each side asserts the same
 * literal array in its own test.
 */
export const DEVICE_TYPES = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
  "unspecified",
] as const;

/**
 * The device types the panel actually offers, in the order the wizard shows
 * them. A copy of `DEVICE_TYPE_ORDER` in @amnezia/contracts, pinned by the same
 * literal on both sides. `unspecified` is deliberately absent: it is storable
 * but never offered.
 */
export const DEVICE_TYPE_ORDER = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
] as const;

/** The `--device-type=…` fragment for a usage string, built from the list. */
export const deviceTypeUsage = (): string =>
  `--device-type=${DEVICE_TYPE_ORDER.join("|")}`;

/**
 * Retired device types and what to use instead. Phrased as advice rather than a
 * mapping: the panel remapped stored rows to "unspecified" because it could not
 * know the platform, but a person running the CLI does know, so the message
 * asks them for it.
 */
export const RETIRED_DEVICE_TYPES: Record<string, string> = {
  iphone: "ios",
  desktop: "windows, macos or linux",
  laptop: "windows, macos or linux",
  phone: "android or ios",
  tablet: "android or ios",
};

/**
 * How a key limit is counted. A deliberate copy of `keyLimitModeSchema.options`
 * in @amnezia/contracts, for the same reason as DEVICE_TYPES above: this CLI
 * ships with no dependencies, so the two literals are pinned by a test on each
 * side rather than shared through an import.
 */
export const KEY_LIMIT_MODES = ["per_node", "global"] as const;
export type KeyLimitMode = (typeof KEY_LIMIT_MODES)[number];

/**
 * `--mode=` on `user-limit`. `inherit` is not a mode: it is the CLI's spelling
 * of "clear the per-user override", which the API expects as an explicit null,
 * so it cannot be folded into the enum above.
 */
export const parseKeyLimitMode = (value: string): KeyLimitMode | null => {
  if (value === "inherit") return null;
  if (value === "per_node" || value === "global") return value;
  throw new Error("--mode must be per_node, global or inherit");
};

/** A `policy-set --<field>=` value constrained to a fixed word list. */
export const parseEnumFlag = (
  field: string,
  value: string,
  allowed: readonly string[],
): string => {
  if (!allowed.includes(value)) {
    throw new Error(`--${field} must be one of ${allowed.join(", ")}`);
  }
  return value;
};

/**
 * How a user's limit is counted. Mirrors the resolution the API performs: the
 * per-user override wins, the global switch is the fallback, and anything
 * unrecognised degrades to per_node — the meaning every limit had before the
 * mode existed, so an older panel or a hand-written row can never silently turn
 * a per-server limit into a shared pool.
 */
export const effectiveKeyLimitMode = (
  globalMode: string | null | undefined,
  userMode: string | null | undefined,
): KeyLimitMode => {
  for (const candidate of [userMode, globalMode]) {
    if (candidate === "global" || candidate === "per_node") return candidate;
  }
  return "per_node";
};

/**
 * The limit a quota request would replace, resolved the way the API resolves
 * it. In global mode the per-node entries are dormant, so consulting them would
 * misstate what the admin is about to change right before they approve it.
 */
export const quotaCurrentLimit = (
  mode: KeyLimitMode,
  user: {
    keyLimitOverride?: number | null;
    nodeKeyLimits?: Record<string, number> | null;
  },
  nodeId: string | null,
  defaultKeyLimit: number | null | undefined,
): string => {
  const perNode =
    mode === "per_node" && nodeId ? user.nodeKeyLimits?.[nodeId] : undefined;
  return String(perNode ?? user.keyLimitOverride ?? defaultKeyLimit ?? "default");
};

/**
 * What approving the request will actually target. A per-server request in
 * global mode is approved as a raise of the shared total, so the table must not
 * keep calling it by the server's name — the admin would read a per-server
 * grant that is not what the click does.
 */
export const quotaTargetLabel = (
  mode: KeyLimitMode,
  nodeName: string | null,
): string => {
  if (nodeName === null) return "all servers";
  return mode === "global" ? `all servers (request named ${nodeName})` : nodeName;
};

/** Validate `--device-type`, naming the replacement for a retired value. */
export const parseDeviceType = (value: string): string => {
  if ((DEVICE_TYPES as readonly string[]).includes(value)) return value;
  const replacement = RETIRED_DEVICE_TYPES[value];
  if (replacement !== undefined) {
    throw new Error(`--device-type="${value}" was retired — use ${replacement}`);
  }
  throw new Error(
    `--device-type expects one of ${DEVICE_TYPES.join(", ")}; got "${value}"`,
  );
};

/**
 * Render a stored device type for a table cell. `unspecified` and a missing
 * value both read as a dash; anything else — including a value retired by a
 * migration this build predates — is printed verbatim rather than hidden.
 */
export const formatDeviceType = (value: string | undefined): string =>
  !value || value === "unspecified" ? "—" : value;

/**
 * `keys --node=<id>`: no filter keeps everything. Case-insensitive because the
 * id is pasted out of `nodes --hosts` or a URL, where its case is not stable.
 */
export const matchesNodeFilter = (
  nodeId: string,
  filter: string | undefined,
): boolean =>
  filter === undefined || nodeId.toLowerCase() === filter.toLowerCase();

/**
 * Parse the global policy's ordered/marked node lists (`recommendedNodeIds`,
 * `nodeOrder`):
 *   ""/"none" -> []        (clear the list)
 *   "a,b"     -> ["a","b"] (kept in the given order - for nodeOrder the order
 *                           IS the value, so this never sorts or dedupes)
 * Unlike `parseNodeSpec` there is no "all": recommending every node recommends
 * nothing, and an order is only meaningful as an explicit sequence.
 */
export const parsePolicyNodeList = (spec: string): string[] => {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "none") return [];
  if (trimmed === "all") {
    throw new Error(
      'Invalid value "all" - pass a comma-separated node id list, or "none" to clear',
    );
  }
  return csvList(trimmed);
};

// Lists whose empty value means "no node", not "every node".
const EMPTY_MEANS_NONE = new Set(["recommendedNodeIds", "nodeOrder"]);

/** Render one portal-policy field for the `policy` snapshot command. */
export const formatPolicyValue = (key: string, value: unknown): string => {
  if (Array.isArray(value)) {
    if (value.length > 0) return value.join(",");
    return EMPTY_MEANS_NONE.has(key) ? "(none)" : "(all)";
  }
  // `allowedNodeIds` is nullable, and null there means "every node".
  if (value === null && !EMPTY_MEANS_NONE.has(key)) return "(all)";
  return String(value);
};

/**
 * `nodes` in the order users actually see it: the stored `nodeOrder` first, in
 * its own sequence, then everything unpositioned by name. `rank` is the
 * position a user sees; `-` means the node has never been placed, which is a
 * state an admin needs to notice (an unpositioned node sorts last and cannot
 * be recommended).
 */
export const annotateNodeOrder = <T extends { id: string; name: string }>(
  rows: readonly T[],
  order: readonly string[],
  recommended: readonly string[],
): Array<T & { rank: string; rec: string }> => {
  const rank = new Map(order.map((id, index) => [id, index]));
  const badge = new Set(recommended);
  return [...rows]
    .sort((left, right) => {
      const l = rank.get(left.id);
      const r = rank.get(right.id);
      if (l !== undefined && r !== undefined) return l - r;
      if (l !== undefined) return -1;
      if (r !== undefined) return 1;
      return (
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      );
    })
    // The rank is re-derived AFTER sorting, counting only nodes that exist:
    // `nodeOrder` may still name a node deleted between these two reads, and
    // the raw array index would then shift every printed position by one -
    // showing a list that no user sees. (The control API never has this
    // problem: its comparator only ever compares ranks, never prints them.)
    .map((row, index) => ({
      ...row,
      rank: rank.has(row.id) ? String(index + 1) : "-",
      rec: badge.has(row.id) ? "yes" : "",
    }));
};

/**
 * Read-only check that the STORED row still satisfies the prefix invariant.
 * This is not a duplicate of the API's write validation (a structural sibling
 * of `checkRecommendedPrefix` in @amnezia/control-api, which this CLI cannot
 * import - see the drift note in `deviceProfiles.ts`): the API checks a
 * payload before accepting it and never re-checks afterwards, so a row edited
 * in SQL - or written before this feature existed - can violate the rule with
 * nothing to say so. `policy` is the only place an operator would find out.
 */
export const checkRecommendedPrefix = (
  recommended: readonly string[],
  order: readonly string[],
):
  | { ok: true }
  | { ok: false; nodeId: string; reason: "unpositioned" | "behind" } => {
  const prefix = new Set(order.slice(0, recommended.length));
  for (const nodeId of order) {
    // Report the offender nearest the top of the order, so fixing them in the
    // printed sequence converges instead of chasing a new name each time.
    if (recommended.includes(nodeId) && !prefix.has(nodeId)) {
      return { ok: false, nodeId, reason: "behind" };
    }
  }
  for (const nodeId of recommended) {
    if (!order.includes(nodeId)) {
      return { ok: false, nodeId, reason: "unpositioned" };
    }
  }
  return { ok: true };
};
