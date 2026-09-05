/** Pure argument helpers, kept out of main.ts so they are unit-testable. */

/**
 * Structural copy of `WORKER_PERIOD_FIELDS` from @amnezia/contracts.
 *
 * The CLI declares no runtime dependencies on purpose (see the note in
 * `deviceProfiles.ts`), so it re-states the table rather than importing the
 * workspace package at runtime. `@amnezia/contracts` IS a devDependency, and
 * `args.test.ts` compares this copy against it field for field -- a test
 * dependency changes nothing about the shipped `dist/main.js`, and it is the
 * only thing that can catch a contract bound moving without this copy.
 *
 * `fallback` is the BUILT-IN default. A worker whose environment sets
 * TELEMETRY_POLL_SEC, NODE_METRICS_SAMPLE_SEC, NODE_METRICS_RETENTION_DAYS or
 * ACCESS_RECONCILE_INTERVAL_MS uses that instead, which is why `periods` prints
 * the caveat with the table rather than claiming to know the live number.
 */
export const WORKER_PERIOD_FIELDS = {
  telemetryPollSec: { min: 30, max: 86_400, fallback: 60, unit: "sec" },
  nodeMetricsSampleSec: { min: 30, max: 86_400, fallback: 300, unit: "sec" },
  nodeMetricsRetentionDays: { min: 1, max: 3_650, fallback: 7, unit: "day" },
  peerSampleSec: { min: 60, max: 86_400, fallback: 300, unit: "sec" },
  maintenanceIntervalSec: {
    min: 3_600,
    max: 604_800,
    fallback: 3_600,
    unit: "sec",
  },
  agentReleaseRefreshSec: {
    min: 300,
    max: 604_800,
    fallback: 1_800,
    unit: "sec",
  },
  ruleFetchIntervalSec: {
    min: 900,
    max: 604_800,
    fallback: 21_600,
    unit: "sec",
  },
  accessReconcileSec: { min: 300, max: 604_800, fallback: 3_600, unit: "sec" },
} as const satisfies Record<
  string,
  { min: number; max: number; fallback: number; unit: "sec" | "day" }
>;

export type WorkerPeriodField = keyof typeof WORKER_PERIOD_FIELDS;

/** Stable listing order, shared by `periods`, `policy-set` and the help text. */
export const WORKER_PERIOD_FIELD_NAMES = Object.keys(
  WORKER_PERIOD_FIELDS,
) as WorkerPeriodField[];

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
 *
 * A `pending` row can ALSO carry a `lastError`: the runner retries a throwing
 * sync with backoff while leaving the row pending (see runner.ts), so a
 * Cloudflare 401/5xx/timeout can repeat for a while before the job is ever
 * marked failed. Without surfacing it here, that whole window reads as
 * "pending since …" with no sign that anything is wrong.
 */
export const formatAccessSyncStatus = (status: AccessSyncStatusView): string => {
  switch (status.status) {
    case "idle":
      return "no reconcile requested yet";
    case "pending":
      return status.lastError
        ? `pending since ${status.queuedAt ?? "unknown"} — retrying after: ${status.lastError}`
        : `pending since ${status.queuedAt ?? "unknown"}`;
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
 * One spelling of an email domain: trimmed, lower-cased, and with a leading
 * "@" dropped so `@company.tld` and `company.tld` are the same value.
 *
 * A structural copy of `normalizeAccessDomain` in @amnezia/contracts, for the
 * reason the whole file re-states small facts (see WORKER_PERIOD_FIELDS above):
 * the CLI ships as a dependency-free `dist/main.js`. `args.test.ts` runs both
 * against the same inputs, so the copy cannot drift.
 *
 * Deliberately shallow — it normalises, it does not validate. `cf-domains`
 * leaves the question "is this actually a domain name" to `accessDomainSchema`
 * on the API side, and `users --domain=` never asks it at all: a value that
 * matches no address is answered with an empty list, not an error.
 */
export const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/^@+/, "");

/**
 * The domain half of an email address: everything after the LAST "@", so an
 * address with a quoted "@" in its local part still yields the right domain.
 * "" when there is no "@" at all. Matches how the worker
 * (`apps/worker/src/accessReconcile.ts`) and the Users page split an address.
 */
export const emailDomain = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : normalizeDomain(email.slice(at + 1));
};

/**
 * `users --domain=<domain>`: no filter keeps everyone. The panel's own domain
 * filter offers only the domains actually present among the loaded users, so
 * it can never land on a value nobody has; a shell has no such list, which is
 * why a domain matching nobody is a legitimate answer here rather than an
 * error — it is how "does anyone still have an address on this domain" gets
 * asked before a `cf-domains --remove`.
 */
export const matchesDomainFilter = (
  email: string,
  filter: string | undefined,
): boolean =>
  filter === undefined || emailDomain(email) === normalizeDomain(filter);

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

/** True for one of the eight worker periods stored on portal_policy. */
export const isWorkerPeriodField = (key: string): key is WorkerPeriodField =>
  key in WORKER_PERIOD_FIELDS;

/**
 * A period as a human reads it: the stored number in its own unit, with a
 * rounder restatement when seconds stop being legible ("21600 s (6 h)").
 *
 * The raw number stays first because it is what `policy-set` takes back.
 */
export const formatPeriod = (
  field: WorkerPeriodField,
  value: number,
): string => {
  if (WORKER_PERIOD_FIELDS[field].unit === "day") {
    return `${value} ${value === 1 ? "day" : "days"}`;
  }
  if (value < 60) return `${value} s`;
  if (value < 3_600) return `${value} s (${round(value / 60)} min)`;
  if (value < 86_400) return `${value} s (${round(value / 3_600)} h)`;
  return `${value} s (${round(value / 86_400)} d)`;
};

/** One decimal at most, and never a trailing ".0". */
const round = (value: number): string =>
  String(Math.round(value * 10) / 10);

/** Render one portal-policy field for the `policy` snapshot command. */
export const formatPolicyValue = (key: string, value: unknown): string => {
  // Checked before the null branch below: a worker period's null means "use the
  // worker's default", never "every node".
  if (isWorkerPeriodField(key)) {
    return value === null || value === undefined
      ? "(default)"
      : formatPeriod(key, Number(value));
  }
  if (Array.isArray(value)) {
    if (value.length > 0) return value.join(",");
    return EMPTY_MEANS_NONE.has(key) ? "(none)" : "(all)";
  }
  // `allowedNodeIds` is nullable, and null there means "every node".
  if (value === null && !EMPTY_MEANS_NONE.has(key)) return "(all)";
  return String(value);
};

/**
 * Parse a `policy-set --<period>=<value>` flag.
 *
 * `default` (and `none` / `null`, which every other clearable flag accepts)
 * gives the period back to the worker. Anything else has to be a whole number
 * inside the field's bounds -- refused here rather than posted, so the operator
 * is told which number is out of range instead of reading a validation error
 * about a field name.
 */
export const parseWorkerPeriodFlag = (
  field: WorkerPeriodField,
  raw: string,
): number | null => {
  const value = raw.trim();
  if (value === "default" || value === "none" || value === "null") return null;
  const { min, max, unit } = WORKER_PERIOD_FIELDS[field];
  // `Number("")` is 0, so an empty flag - `--telemetryPollSec=` from an unset
  // shell variable - would otherwise be reported as "0 is out of range" rather
  // than as the missing value it is.
  const parsed = value === "" ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `--${field}: expected a whole number of ${unit === "day" ? "days" : "seconds"}, or "default" to clear it`,
    );
  }
  if (parsed < min || parsed > max) {
    throw new Error(
      `--${field}: ${parsed} is outside ${min}..${max} ${unit === "day" ? "days" : "seconds"}`,
    );
  }
  return parsed;
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

/**
 * Structural copy of `sourceName` / `ruleSources` from @amnezia/contracts, for
 * the same reason as WORKER_PERIOD_FIELDS above: the CLI declares no runtime
 * dependencies, so it cannot import the workspace package the admin page uses.
 * `args.test.ts` runs a fixture list of URLs through both implementations and
 * requires the same answer — an operator reading `rules` in a shell must see a
 * provider named exactly as the panel names it.
 *
 * These are lists of URL SHAPES, not of known feeds. `RULE_FEEDS` is
 * per-deployment configuration, so a table of "this URL means RoscomVPN" would
 * go stale the moment an operator repoints a profile — which is how the page
 * came to be titled after a provider supplying only one of its two lists.
 */
const FORGE_PATH_LAYOUTS: Record<string, number> = {
  "github.com": 0,
  "raw.githubusercontent.com": 0,
  "gitlab.com": 0,
  "codeberg.org": 0,
  "bitbucket.org": 0,
  // jsDelivr addresses a repo as /gh/<owner>/<repo>@<ref>/<path>.
  "cdn.jsdelivr.net": 1,
  "fastly.jsdelivr.net": 1,
  "raw.githack.com": 0,
  "statically.io": 1,
};

/** Host labels naming how a file is served rather than who serves it. */
const DELIVERY_LABELS = new Set([
  "www",
  "cdn",
  "raw",
  "static",
  "assets",
  "files",
  "file",
  "dl",
  "download",
  "downloads",
  "api",
  "data",
  "feed",
  "feeds",
  "list",
  "lists",
  "mirror",
  "mirrors",
  "release",
  "releases",
  "s3",
  "storage",
]);

/** A short, human-readable name for one rule-source URL. */
export const sourceName = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  const skip = FORGE_PATH_LAYOUTS[host];
  if (skip !== undefined) {
    const repo = segments[skip + 1];
    if (repo) return repo.split("@")[0] ?? repo;
    const owner = segments[skip];
    if (owner) return owner.split("@")[0] ?? owner;
    return host;
  }

  const labels = host.split(".");
  const named = labels
    .slice(0, Math.max(1, labels.length - 1))
    .filter((label) => !DELIVERY_LABELS.has(label));
  return named[0] ?? labels[0] ?? host;
};

/**
 * Every source behind one stored `route_rule_versions.source_url`. The worker
 * space-joins the URLs of a version merged from several feeds, so one cell can
 * hold several.
 */
export const ruleSources = (
  sourceUrl: string | null | undefined,
): Array<{ url: string; name: string }> => {
  const seen = new Set<string>();
  const refs: Array<{ url: string; name: string }> = [];
  for (const url of (sourceUrl ?? "").split(/\s+/).filter(Boolean)) {
    if (seen.has(url)) continue;
    seen.add(url);
    refs.push({ url, name: sourceName(url) });
  }
  return refs;
};
