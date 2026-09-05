import { z } from "zod";

export const protocolKindSchema = z.enum(["awg2", "awg3"]);
export const keyStateSchema = z.enum([
  "provisioning",
  "active",
  "disabled",
  "revoking",
  "revoked",
  "failed",
]);
/**
 * States a revoke may be asked for from, for owners and admins alike.
 *
 * `revoking` and `failed` are in the list because they are where a delete that
 * did not go through comes to rest: a node that was unreachable leaves the key
 * in `revoking`, and rows written before that behaviour was fixed are stuck in
 * `failed`. Refusing the second attempt is what left keys in a user's list that
 * they had already deleted and could not delete again.
 *
 * `revoked` is not here: there is nothing left to do. The full state model is
 * `docs/KEY-STATES.md`.
 */
export const REVOCABLE_KEY_STATES = [
  "provisioning",
  "active",
  "disabled",
  "revoking",
  "failed",
] as const satisfies readonly KeyState[];

/** Whether a revoke may be asked for a key in this state. */
export const isRevocableKeyState = (state: string): boolean =>
  (REVOCABLE_KEY_STATES as readonly string[]).includes(state);

/**
 * States a key may be **deleted from the panel** in — the row itself removed,
 * not just marked.
 *
 * Only `revoked`, and the reason is the peer rather than the row. Every other
 * state can still have something on a node: `provisioning` may have got half
 * way, `active` and `disabled` certainly do, `revoking` is waiting for the node
 * to confirm, and `failed` may have created a peer before the job gave up.
 * Deleting the row is what makes such a peer unreachable for ever: reconcile
 * finds an orphan by the label the row carries, so with the row gone the peer
 * stays on the node with nothing left that knows what it was.
 *
 * `revoked` is the one state where the node has already confirmed the peer is
 * gone. Then the row is only history, and history is what the audit log is for.
 */
export const PURGEABLE_KEY_STATES = ["revoked"] as const satisfies readonly KeyState[];

/** Whether a key in this state may be deleted from the panel outright. */
export const isPurgeableKeyState = (state: string): boolean =>
  (PURGEABLE_KEY_STATES as readonly string[]).includes(state);

export const routeProfileSchema = z.enum([
  "full_tunnel",
  "ru_whitelist",
  "ru_blacklist",
]);
/**
 * What kind of device a key is for. The value names a **platform**, not a form
 * factor: it is the signal platform-specific behaviour would hang off. Nothing
 * in the web app branches on it any more — since #67 every route profile is
 * offered on every platform — and the one rule phrased against it,
 * `deviceSupportsRouteProfiles` below, is now advisory and read only by the
 * CLI. "ios" covers iPhone and iPad — the same platform for every purpose this
 * panel has.
 *
 * "unspecified" is the stored default and is never offered as a choice; see
 * DEVICE_TYPE_ORDER.
 *
 * Mirrored by `deviceTypeEnum` in `packages/db/src/schema.ts` (pinned by a
 * parity test) and by `DEVICE_TYPES` in `apps/cli/src/args.ts` (a deliberate
 * copy — the CLI has no dependencies; pinned by a test on each side).
 */
export const deviceTypeSchema = z.enum([
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
  "unspecified",
]);

/**
 * The device types the create-key UI and the CLI offer, in the order they are
 * shown: the mobile and Apple platforms on top, the desktop ones and the escape
 * hatch at the bottom. This order is the operator's, not an implementation
 * detail, so it lives here rather than in a component — a UI-local copy of this
 * list is what once let the wizard offer a "tablet" the API rejected.
 */
export const DEVICE_TYPE_ORDER = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
] as const satisfies readonly DeviceType[];

/**
 * Device types the panel used before the platform rework, and what a row
 * holding one becomes.
 *
 * `desktop`, `laptop` and `phone` named a form factor and never told the panel
 * which platform the device ran, so they become "unspecified" rather than
 * "other": "other" would claim the platform is outside the list, which the
 * panel cannot know. `iphone` maps exactly onto the wider `ios`.
 *
 * `tablet` was only ever offered by the create-key wizard — deviceTypeSchema
 * never contained it, so no stored row can hold it — but a stale browser tab
 * can still send it, so it is named here and refused by name.
 */
export const LEGACY_DEVICE_TYPE_REPLACEMENT = {
  iphone: "ios",
  desktop: "unspecified",
  laptop: "unspecified",
  phone: "unspecified",
  tablet: "unspecified",
} as const satisfies Record<string, DeviceType>;

export type LegacyDeviceType = keyof typeof LEGACY_DEVICE_TYPE_REPLACEMENT;

/**
 * The retired values a stored row could actually hold — the pre-rework
 * Postgres enum. The data migration handles exactly these; "tablet" is absent
 * because the column could never contain it.
 */
export const RETIRED_STORED_DEVICE_TYPES = [
  "desktop",
  "laptop",
  "iphone",
  "phone",
] as const satisfies readonly LegacyDeviceType[];

/**
 * What a retired device type becomes, or null when the value was never one.
 * Current values return null too, so a caller cannot map twice.
 */
export const replaceLegacyDeviceType = (value: string): DeviceType | null =>
  Object.hasOwn(LEGACY_DEVICE_TYPE_REPLACEMENT, value)
    ? LEGACY_DEVICE_TYPE_REPLACEMENT[value as LegacyDeviceType]
    : null;
export const roleSchema = z.enum(["user", "admin"]);
export const userStatusSchema = z.enum(["active", "disabled"]);

// Protocols the panel understands, newest/preferred first. Adding a future
// protocol = extend `protocolKindSchema` and this registry; the rest of the
// stack (policy, nodes, wizard) is driven off these and needs no other change.
export const PROTOCOL_KINDS = ["awg3", "awg2"] as const;
export const DEFAULT_ALLOWED_PROTOCOLS: ProtocolKind[] = ["awg3"];
export const PROTOCOL_META: Record<
  ProtocolKind,
  { label: string; short: string; recommended: boolean; legacy: boolean }
> = {
  awg3: {
    label: "AmneziaWG 3.1",
    short: "AWG 3.1",
    recommended: true,
    legacy: false,
  },
  awg2: {
    label: "AmneziaWG 2.0",
    short: "AWG 2.0",
    recommended: false,
    legacy: true,
  },
};

export const protocolListSchema = z.array(protocolKindSchema);

// --- Per-key client display name -------------------------------------------
// Which parts make up the connection name the AmneziaVPN client shows for a
// key (the vpn:// payload's `description`). Chosen per key at creation time.
export const keyNameDisplaySchema = z.object({
  // Node public name, e.g. "Frankfurt".
  server: z.boolean().default(true),
  // The key's own device label, e.g. "Main laptop".
  label: z.boolean().default(true),
  // Per-owner sequential key number, rendered as "#3".
  number: z.boolean().default(false),
});

export type KeyNameDisplay = z.infer<typeof keyNameDisplaySchema>;

export const defaultKeyNameDisplay: KeyNameDisplay =
  keyNameDisplaySchema.parse({});

// A fresh copy per parse, so a request object can never mutate the shared default.
const newKeyNameDisplay = (): KeyNameDisplay => ({ ...defaultKeyNameDisplay });

/**
 * Build the client-visible connection name from the enabled parts, joined by a
 * single space in a fixed order: server, label, "#N". Empty parts are skipped.
 * When nothing is enabled (or every enabled part is empty) it falls back to the
 * server name, then the label, then "#N", and finally the literal "VPN" so the
 * client never shows a blank connection.
 */
export const composeKeyDisplayName = (input: {
  serverName: string;
  label?: string | null;
  keyNumber?: number | null;
  display: KeyNameDisplay;
}): string => {
  const serverName = input.serverName.trim();
  const label = (input.label ?? "").trim();
  const number =
    typeof input.keyNumber === "number" && Number.isFinite(input.keyNumber)
      ? `#${input.keyNumber}`
      : "";
  const parts: string[] = [];
  if (input.display.server && serverName) parts.push(serverName);
  if (input.display.label && label) parts.push(label);
  if (input.display.number && number) parts.push(number);
  if (parts.length > 0) return parts.join(" ");
  return serverName || label || number || "VPN";
};

export const createKeyRequestSchema = z.object({
  nodeId: z.uuid(),
  protocol: protocolKindSchema.default("awg3"),
  deviceType: deviceTypeSchema.default("unspecified"),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
  routeProfile: routeProfileSchema.default("full_tunnel"),
  nameDisplay: keyNameDisplaySchema.default(newKeyNameDisplay),
});

/**
 * Deleting a node also deletes every key ever issued on it, so the destructive
 * half is opt-in: without `deleteKeys` a node that still has keys is refused.
 */
export const deleteNodeOptionsSchema = z.object({
  deleteKeys: z.boolean().default(false),
});
export type DeleteNodeOptions = z.infer<typeof deleteNodeOptionsSchema>;

export const quotaRequestSchema = z.object({
  requestedLimit: z.int().min(1).max(1_000),
  // Which server the extra keys are for. Null or omitted = every server, which
  // raises the flat per-user override; a node id targets that one server and
  // raises its entry in `users.nodeKeyLimits`.
  nodeId: z.uuid().nullish(),
  // Optional — a reason is helpful but not required. Stored as "" when omitted.
  reason: z.string().trim().max(1_000).optional(),
  // Strict, unlike every other payload here: this is the ONE request a user can
  // raise for themselves, and the key limit mode is an administrator's decision
  // about how everyone's numbers are read. Stripping an unknown key silently
  // would still be safe, but it would answer 200 to a client that believes it
  // changed the mode. Refusing says what happened. The panel's own dialog sends
  // exactly these three fields, so nothing legitimate is broken by it.
}).strict();

const nodeApiBaseUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Node API URL must use http or https");

export const createNodeRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional user-facing server name; empty/omitted falls back to `name`.
  publicName: z.string().trim().max(120).optional(),
  apiBaseUrl: nodeApiBaseUrlSchema,
  apiKey: z.string().min(32).max(4_096),
  enabled: z.boolean().default(true),
  protocol: protocolKindSchema.default("awg3"),
  // Which of the node's supported protocols are offered to users. Omitted /
  // null means "all supported". Empty is rejected — a node must offer at least
  // one protocol.
  enabledProtocols: protocolListSchema.min(1).nullish(),
  maxPeers: z.int().min(1).max(500).default(500),
  capabilities: z.record(z.string().min(1).max(80), z.boolean()).default({}),
});

export const updateNodeRequestSchema = createNodeRequestSchema
  .omit({ apiKey: true })
  .partial()
  .extend({
    apiKey: z.string().min(32).max(4_096).optional(),
    // Only ever null: the resolved address is an observation the worker makes,
    // never something an operator types, so this clears it rather than setting
    // it. The panel resolves a node's host once and keeps the answer, which is
    // right because a server's address does not change under it -- but if one
    // ever does while keeping the same DNS name, nothing would notice. Clearing
    // the stored value makes the next telemetry tick look it up again, so the
    // recovery is a command rather than an UPDATE against production.
    publicIp: z.null().optional(),
    // Which service checks this node runs. A check is defined once for the
    // fleet, but whether a given node runs it is a property of the NODE - a
    // server behind a provider that refuses one of the targets would otherwise
    // sit permanently red for a fact nobody can act on.
    //
    // Two switches rather than one, because they answer different questions:
    // `checksEnabled` is "does this node take part at all", and
    // `disabledCheckIds` is "all but these". Folding them together would make
    // "run nothing here" indistinguishable from "no check happens to apply".
    checksEnabled: z.boolean().optional(),
    disabledCheckIds: z.array(z.uuid()).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

/**
 * Whether a node runs a given check.
 *
 * Both sides have to agree - the worker decides what to dispatch, the panel
 * decides what to show a user - so the rule lives here rather than being
 * written twice.
 */
export const nodeRunsCheck = (
  node: { checksEnabled?: boolean | null; disabledCheckIds?: string[] | null },
  checkId: string,
): boolean =>
  node.checksEnabled !== false && !(node.disabledCheckIds ?? []).includes(checkId);

// --- Node public address ---------------------------------------------------
// Where clients reach a node. `publicHost` is the node-agent's own
// SERVER_PUBLIC_HOST as it reports it (an IP literal or a DNS name, never a
// URL). `publicIp` is what the panel's worker resolved that host to: the host
// itself when it is already an IPv4 literal, otherwise the first A record.
// Both are null until an agent that reports the field has been polled;
// `publicIp` alone is null when the lookup failed or the host has no IPv4
// address. Consumed by the IP-vs-domain audit (backlog T6).

// Two different questions, deliberately two different schemas:
//  - "is this string an IP rather than a DNS name?" — both families count, and
//    T6's audit needs to classify an IPv6 host as an IP, not as a name.
//  - "what may be stored as this node's resolved address?" — IPv4 only, because
//    the client endpoint line cannot carry an IPv6 address (no bracketing in
//    amneziaWg{,2,3}.service.ts), so an IPv6 value would be unusable.
const ipLiteralSchema = z.union([z.ipv4(), z.ipv6()]);

export const nodePublicAddressSchema = z.object({
  publicHost: z.string().trim().min(1).max(253).nullable(),
  publicIp: z.ipv4().nullable(),
  // When publicIp was learned. A node's public address is a property of the
  // server and does not change, so the worker resolves it once and this is a
  // diagnostic — "where the panel got that number, and when" — not a freshness
  // indicator. Null exactly when publicIp is null.
  publicIpResolvedAt: z.iso.datetime().nullable(),
});
export type NodePublicAddress = z.infer<typeof nodePublicAddressSchema>;

/** True when `host` is a bare IPv4/IPv6 literal (no port, no brackets). */
export const isIpLiteral = (host: string): boolean =>
  ipLiteralSchema.safeParse(host).success;

/** True only for a bare IPv4 literal — what may be stored as `publicIp`. */
export const isIpv4Literal = (host: string): boolean =>
  z.ipv4().safeParse(host).success;

export const createUserRequestSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(160).optional(),
  role: roleSchema.default("user"),
});

/**
 * The three audiences the in-panel connection guide is written for. They are
 * not vendors but the groups whose install steps actually differ: a computer
 * (Windows / macOS / Linux) downloads and runs an installer, Android has a
 * store plus an APK, and iPhone / iPad have a differently-named store listing
 * and the route-profile limitation.
 *
 * Lives here rather than in apps/web because the portal policy carries a value
 * per audience — see installGuideVideosSchema.
 */
export const GUIDE_AUDIENCES = ["desktop", "android", "ios"] as const;
export const guideAudienceSchema = z.enum(GUIDE_AUDIENCES);
export type GuideAudience = z.infer<typeof guideAudienceSchema>;

/**
 * An optional walkthrough video per audience, shown at the top of that
 * audience's instruction. Null everywhere by default: the guide works without
 * one, so a panel that has recorded no videos shows a placeholder rather than a
 * broken player.
 *
 * Protocol-constrained for the same reason as the client download links — the
 * value is rendered as a URL, and `z.url()` alone accepts `javascript:`.
 */
export const installGuideVideosSchema = z.object({
  desktop: z.url({ protocol: /^https?$/ }).nullish(),
  android: z.url({ protocol: /^https?$/ }).nullish(),
  ios: z.url({ protocol: /^https?$/ }).nullish(),
});
export type InstallGuideVideos = z.infer<typeof installGuideVideosSchema>;

/**
 * How a configured walkthrough video should be shown.
 *
 * Google Drive is the expected host for these: recording a short clip and
 * dropping it in Drive is the whole workflow, and Drive will not serve a file
 * to a plain `<video>` tag — its direct-download URLs stopped being dependable,
 * and only the `/preview` page embeds reliably. So a Drive link becomes an
 * iframe and everything else stays a real video element.
 *
 * Returns null when the value is not a usable http(s) URL, so a mistyped
 * setting shows the "no video yet" placeholder instead of a broken frame.
 */
export type InstallVideoEmbed = { kind: "drive" | "file"; src: string };

/** Drive file ids are opaque but always in this alphabet. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export const installVideoEmbed = (
  value: string | null | undefined,
): InstallVideoEmbed | null => {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^www\./, "");
  if (host === "drive.google.com") {
    // Both shapes Drive hands out: /file/d/<id>/view and /open?id=<id>.
    const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
    const id = fromPath ?? url.searchParams.get("id") ?? "";
    if (!DRIVE_FILE_ID.test(id)) return null;
    // Rebuilt from the validated id rather than rewritten from the input, so
    // nothing from the original query or fragment survives into the frame.
    return { kind: "drive", src: `https://drive.google.com/file/d/${id}/preview` };
  }
  return { kind: "file", src: url.href };
};

// --- Key limit mode ----------------------------------------------------------
// "per_node": a user may hold up to `limit` keys on EACH server (the original
// behaviour, and the default). "global": `limit` is one total shared by every
// server. The global value lives on portal_policy; a per-user override is an
// ordinary policyOverride field, so `resolvePortalPolicy` applies it. Per-node
// limits (`users.nodeKeyLimits`) are kept but not enforced while the effective
// mode is "global".
export const keyLimitModeSchema = z.enum(["per_node", "global"]);
export type KeyLimitMode = z.infer<typeof keyLimitModeSchema>;

export const portalPolicySchema = z.object({
  allowKeyCreation: z.boolean().default(true),
  allowNodeSelection: z.boolean().default(true),
  // Protocols users are offered when creating a key (org-wide default; a
  // per-user override in policyOverride replaces this list). AWG 3.1 only by
  // default — awg2 stays available to switch back on per node/user/globally.
  allowedProtocols: protocolListSchema.min(1).default(["awg3"]),
  // Nodes users may create keys on; null = all. Per-user override in
  // policyOverride.allowedNodeIds.
  allowedNodeIds: z.array(z.uuid()).nullish(),
  // Whether the key limit is counted per server or as one shared pool.
  keyLimitMode: keyLimitModeSchema.default("per_node"),
  allowRouteProfileSelection: z.boolean().default(true),
  // Let users manage their OWN custom routes (extra addresses layered on a
  // split-tunnel profile). Admins can always edit them per user.
  allowCustomRoutes: z.boolean().default(true),
  allowConfigRedownload: z.boolean().default(true),
  allowQrDownload: z.boolean().default(true),
  allowConfDownload: z.boolean().default(true),
  allowSelfRevoke: z.boolean().default(true),
  showPublicKey: z.boolean().default(false),
  showLastUsed: z.boolean().default(true),
  showTraffic: z.boolean().default(true),
  // Whether ordinary users see the per-node service-check chips (a service name
  // and one of three states, never a URL and never a failure detail). Default
  // ON: knowing that a service is unavailable from a node is what stops a user
  // filing a ticket about a node that is working exactly as it should.
  showNodeStatus: z.boolean().default(true),
  // Whether ordinary users see the address of each node they may use
  // (GET /api/nodes -> publicAddress). Default OFF: a node's address is
  // operational information, so turning it on is a deliberate decision rather
  // than something an upgrade does to an existing deployment. Note this is the
  // opposite default from showNodeStatus, which ships on.
  showNodeAddress: z.boolean().default(false),
  // Walkthrough videos for the connection guide, one per audience. Empty by
  // default; an admin fills them in when the recordings exist.
  installGuideVideos: installGuideVideosSchema.default({}),
});

export const portalPolicyOverrideSchema = portalPolicySchema.partial();
export const defaultPortalPolicy = portalPolicySchema.parse({});

// --- Worker polling periods --------------------------------------------------
//
// Every background loop the panel runs against the fleet, plus the two sampling
// floors that decide how fast the history tables grow. They live on
// `portal_policy` as NULLABLE columns and are GLOBAL-ONLY: they are not part of
// `portalPolicySchema`, so they can never be overridden per user and never
// travel in `me.policy`. How often the panel talks to a node is a property of
// the deployment, not of whoever is looking at it.
//
// `null` means "use the worker's own default", which is what keeps an upgraded
// panel on exactly the periods it had: the columns start null everywhere, the
// worker falls back to its environment (`TELEMETRY_POLL_SEC` and friends) or to
// the built-in constant, and nothing about an existing host changes until an
// admin sets a value. `fallback` below is that built-in constant -- it is what
// the panel SHOWS as the default and what the write-path cross-check compares
// against, but a worker whose environment names a different number wins over
// it, because the environment is still the default the worker actually uses.
//
// Bounds are floors on how hard the panel is allowed to hit something, not
// taste. Each `min` is justified in the comment beside it; the maxima are one
// day (86400) for anything a user-visible freshness signal depends on -- the
// same ceiling `node_service_checks.interval_sec` already uses -- and one week
// (604800) for the housekeeping loops, past which "periodic" stops being true.
export const WORKER_PERIOD_FIELDS = {
  /**
   * The server-status poll: one health + server + load + client-list fan-out to
   * EVERY node, plus the due service checks.
   *
   * The fan-out is the visible cost -- four requests per node per period -- but
   * it is not the binding one. WireGuard rekeys roughly every two minutes, so
   * an active key's handshake timestamp has moved by the time nearly any poll
   * looks at it, and a moved peer is always written to `peer_samples`. The poll
   * period IS therefore the growth rate of that table, and every maintenance
   * run loads its whole raw retention window into the heap of a 160 MB
   * container in one go (see `maintenanceIntervalSec`). Halving the poll period
   * doubles the rows that allocation has to hold, which is why 30 s is the
   * floor.
   */
  telemetryPollSec: { min: 30, max: 86_400, fallback: 60, unit: "sec" },
  /**
   * How often a poll is allowed to keep a `node_metrics_samples` row. Same
   * floor as the poll it rides on: only a poll can write a sample, so a shorter
   * sample period is not a faster history, it is the same history with a
   * setting that lies about it. Enforced against the poll period as well.
   */
  nodeMetricsSampleSec: { min: 30, max: 86_400, fallback: 300, unit: "sec" },
  /**
   * How long `node_metrics_samples` rows are kept. One day is the floor: zero
   * would prune every row on the run after it was written, leaving the history
   * charts permanently empty rather than short.
   */
  nodeMetricsRetentionDays: { min: 1, max: 3_650, fallback: 7, unit: "day" },
  /**
   * Floor on how often an UNCHANGED peer writes a `peer_samples` row (a peer
   * whose state moved is always sampled). One row per KEY per period, so this
   * table grows with keys x fleet rather than with nodes -- the reason its
   * floor is higher than the poll's. Like the metrics sample period it is
   * written only by a poll, so it is enforced against the poll period too; see
   * POLL_BOUND_SAMPLE_FIELDS.
   */
  peerSampleSec: { min: 60, max: 86_400, fallback: 300, unit: "sec" },
  /**
   * Traffic roll-ups plus the pruning of four tables.
   *
   * The floor is an hour -- the period this loop had for its whole life before
   * it became a setting -- and the reason is MEMORY, not CPU. Every run starts
   * by loading every `peer_samples` row in the raw retention window
   * (TELEMETRY_RAW_RETENTION_DAYS, 7 by default) into the Node heap at once
   * (`loadSamplesSince`, no LIMIT) and then walks the array twice to roll it
   * up. The worker container runs under a 160 MB `mem_limit`, which a busy
   * fleet's week of samples is already within reach of; repeating that
   * allocation twelve times an hour is how a panel OOM-kills its own worker.
   * Lower this only once the roll-up aggregates in SQL instead of in an array.
   */
  maintenanceIntervalSec: { min: 3_600, max: 604_800, fallback: 3_600, unit: "sec" },
  /**
   * Re-resolves the node-agent release the panel offers. Each run is three
   * requests to ghcr.io -- an anonymous pull token, the tag list, and a HEAD on
   * the manifest of the tag it picked -- so at 5 minutes the panel makes 36
   * registry calls an hour, comfortably inside what an anonymous puller is
   * allowed even when it shares an address. (The 60/hour figure belongs to
   * api.github.com, which this loop never touches: only the CLIENT release
   * lookup in the control API talks to it.)
   */
  agentReleaseRefreshSec: { min: 300, max: 604_800, fallback: 1_800, unit: "sec" },
  /**
   * Route-rule feed fetch. Each run downloads the external feeds in full and
   * writes a new version row per feed that changed; the feeds themselves
   * publish daily at best, so 15 minutes is already far faster than the data.
   */
  ruleFetchIntervalSec: { min: 900, max: 604_800, fallback: 21_600, unit: "sec" },
  /**
   * The Cloudflare Access reconcile timer. Each run is a Cloudflare API round
   * trip, and a panel-side user change already arms an immediate run, so a
   * faster timer buys nothing but API calls against a rate-limited endpoint.
   */
  accessReconcileSec: { min: 300, max: 604_800, fallback: 3_600, unit: "sec" },
} as const satisfies Record<
  string,
  { min: number; max: number; fallback: number; unit: "sec" | "day" }
>;

export type WorkerPeriodField = keyof typeof WORKER_PERIOD_FIELDS;

/** Stable listing order, used by the CLI, the admin form and the docs alike. */
export const WORKER_PERIOD_FIELD_NAMES = Object.keys(
  WORKER_PERIOD_FIELDS,
) as WorkerPeriodField[];

const workerPeriodValue = (field: WorkerPeriodField) =>
  z
    .int()
    .min(WORKER_PERIOD_FIELDS[field].min)
    .max(WORKER_PERIOD_FIELDS[field].max)
    // Explicitly nullable: `null` is how an admin gives a period back to the
    // worker's default, and it has to be distinguishable from "not named".
    .nullable();

export const workerPeriodOverridesSchema = z
  .object({
    telemetryPollSec: workerPeriodValue("telemetryPollSec"),
    nodeMetricsSampleSec: workerPeriodValue("nodeMetricsSampleSec"),
    nodeMetricsRetentionDays: workerPeriodValue("nodeMetricsRetentionDays"),
    peerSampleSec: workerPeriodValue("peerSampleSec"),
    maintenanceIntervalSec: workerPeriodValue("maintenanceIntervalSec"),
    agentReleaseRefreshSec: workerPeriodValue("agentReleaseRefreshSec"),
    ruleFetchIntervalSec: workerPeriodValue("ruleFetchIntervalSec"),
    accessReconcileSec: workerPeriodValue("accessReconcileSec"),
  })
  .partial();
export type WorkerPeriodOverrides = z.infer<typeof workerPeriodOverridesSchema>;

/**
 * Bring a stored period inside its bounds.
 *
 * The control API refuses an out-of-range write, so this is not the primary
 * guard -- it is the one that holds when the value did not come through the
 * API at all (a hand-edited row, a restored dump from a panel with different
 * bounds). The worker calls it on every read, so an impossible number can never
 * become an impossible request rate; `null` stays `null` and means "default".
 */
export const clampWorkerPeriod = (
  field: WorkerPeriodField,
  value: number | null | undefined,
): number | null => {
  if (value === null || value === undefined) return null;
  const { min, max } = WORKER_PERIOD_FIELDS[field];
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

/**
 * The sample periods that ONLY a telemetry poll can write.
 *
 * Both `node_metrics_samples` and `peer_samples` rows are written from inside
 * `recordNodeSnapshot`, and nothing but a poll calls that. A sample period
 * below the poll period is therefore not a finer history, it is the same
 * history with a setting that lies about it -- and the panel would go on
 * displaying a number that is not the one running.
 */
export const POLL_BOUND_SAMPLE_FIELDS = [
  "nodeMetricsSampleSec",
  "peerSampleSec",
] as const;

export type PollBoundSampleField = (typeof POLL_BOUND_SAMPLE_FIELDS)[number];

/** How each poll-bound sample period is named to an admin. */
export const POLL_BOUND_SAMPLE_LABELS: Record<PollBoundSampleField, string> = {
  nodeMetricsSampleSec: "host-metrics sample period",
  peerSampleSec: "peer sample period",
};

export const isPollBoundSampleField = (
  field: WorkerPeriodField,
): field is PollBoundSampleField =>
  (POLL_BOUND_SAMPLE_FIELDS as readonly WorkerPeriodField[]).includes(field);

/**
 * The one cross-field rule: a sample period below the telemetry poll period is
 * meaningless, because only a poll can write a sample.
 *
 * Returns the offending pair, or null when the pair is fine. Both the control
 * API (on the write path, so an admin is told rather than left with a setting
 * that does nothing) and the worker (on the read path, where it clamps) use it,
 * which is what stops the two disagreeing about the same invariant.
 */
export const sampleBelowPoll = (
  field: PollBoundSampleField,
  telemetryPollSec: number,
  sampleSec: number,
): {
  field: PollBoundSampleField;
  telemetryPollSec: number;
  sampleSec: number;
} | null =>
  sampleSec < telemetryPollSec
    ? { field, telemetryPollSec, sampleSec }
    : null;

// --- Node host metrics (reported by the node-agent, persisted by the worker) --
//
// Every field a node might not know is nullable, so an agent that predates this
// feature still produces a valid snapshot instead of failing the whole poll.
// Byte counters travel as decimal strings, like traffic counters: they cross
// Number.MAX_SAFE_INTEGER on a large disk, and a JSON number would silently
// round.
export const nodeHostMetricsSchema = z.object({
  observedAt: z.iso.datetime(),
  agentLatencyMs: z.int().nonnegative().nullable(),
  uptimeSec: z.number().nonnegative().nullable(),
  cpuCores: z.int().positive().nullable(),
  load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  memTotalBytes: z.string().nullable(),
  memAvailableBytes: z.string().nullable(),
  swapTotalBytes: z.string().nullable(),
  swapUsedBytes: z.string().nullable(),
  diskTotalBytes: z.string().nullable(),
  diskAvailableBytes: z.string().nullable(),
  diskUsedPercent: z.number().min(0).max(100).nullable(),
  // The cgroup task budget, which is what actually breaks first on a small
  // host: a container that cannot fork looks healthy and low on memory.
  agentPidsCurrent: z.int().nonnegative().nullable(),
  agentPidsMax: z.int().nonnegative().nullable(),
  awg3: z.object({ up: z.boolean(), peers: z.int().nonnegative() }).nullable(),
  awg2: z.object({ up: z.boolean(), peers: z.int().nonnegative() }).nullable(),
  publicHost: z.string().max(253).nullable(),
  listenPorts: z.array(z.int().min(1).max(65535)).nullable(),
  // Derived by the panel from peer handshakes, never probed: a node cannot test
  // its own reachability from outside, and nothing else may.
  endpoint: z.object({
    status: z.enum(["reachable", "stale", "unknown"]),
    lastHandshakeAt: z.iso.datetime().nullable(),
  }),
});
export type NodeHostMetrics = z.infer<typeof nodeHostMetricsSchema>;

// --- Service checks -----------------------------------------------------------
//
// A check runs on the node, with the node's own network. An admin-supplied URL
// is therefore an SSRF primitive unless it is constrained: loopback and internal
// names would let one point a check at the node's own services.
const checkUrlSchema = z.url().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".internal")
  );
}, "Check URL must be a public http(s) address");

// --- How a check is described ------------------------------------------------
//
// A check is a PROBE (what to do) plus a list of ASSERTIONS (what must be true
// of the result). Both are open sets: a new probe kind or a new assertion type
// is one entry in a registry, not a new column in two tables and a new field in
// four layers.
//
// The first shape of this was four fixed fields - expectedStatuses,
// bodyMustContain, bodyMustNotContain, finalUrlMustNotContain. That set was
// derived from two captured pages and would have held exactly until the next
// service needed a rule nobody had thought of. The evidence that shaped it
// already points past it: the two Gemini captures differ by a substring COUNT
// (20 against 0) and by 600 KB of body, and neither of those is expressible as
// "contains" or "does not contain".

/**
 * Assertion types, each evaluated against one probe result.
 *
 * Every one of these is linear in the size of the body. That is a deliberate
 * limit rather than an oversight: a regular expression built from an
 * admin-supplied string can backtrack catastrophically over a 64 KiB body, and
 * checks run inside the node-agent on a host with one vCPU that is also
 * carrying the tunnels - a runaway match there blocks the event loop and takes
 * the node's API down with it. `bodyOccurrencesAtLeast` covers what regexes
 * were wanted for here, counting a marker, at a cost bounded by the body length.
 *
 * To add a type: add the variant below, add its evaluator to the node-agent's
 * registry, and add it to the list that registry advertises. A node that does
 * not know a type reports `error` for that check, never `ok`.
 */
export const CHECK_ASSERTION_TYPES = [
  "statusIn",
  "bodyContains",
  "bodyOmits",
  "bodyContainsAll",
  "bodyContainsAny",
  "bodyOccurrencesAtLeast",
  "bodyBytesAtLeast",
  "finalUrlContains",
  "finalUrlOmits",
  "headerContains",
] as const;
export type CheckAssertionType = (typeof CHECK_ASSERTION_TYPES)[number];

const checkMarker = z.string().trim().min(1).max(200);
const checkMarkerList = z.array(checkMarker).min(1).max(10);

export const checkAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("statusIn"),
    statuses: z.array(z.int().min(100).max(599)).min(1).max(10),
  }),
  z.object({ type: z.literal("bodyContains"), value: checkMarker }),
  z.object({ type: z.literal("bodyOmits"), value: checkMarker }),
  z.object({ type: z.literal("bodyContainsAll"), values: checkMarkerList }),
  z.object({ type: z.literal("bodyContainsAny"), values: checkMarkerList }),
  // The count primitive. A marker that appears twice on a refusal page and
  // twenty times on a working one is a signal `contains` cannot express.
  z.object({
    type: z.literal("bodyOccurrencesAtLeast"),
    value: checkMarker,
    count: z.int().min(1).max(10_000),
  }),
  // Bodies that differ by hundreds of KB are ordinary between a served app and
  // a served refusal page. Counted over what was actually read, so it can never
  // exceed the node's read cap.
  z.object({
    type: z.literal("bodyBytesAtLeast"),
    count: z.int().min(1).max(65_536),
  }),
  z.object({ type: z.literal("finalUrlContains"), value: checkMarker }),
  z.object({ type: z.literal("finalUrlOmits"), value: checkMarker }),
  z.object({
    type: z.literal("headerContains"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9!#$%&*+.^_|~-]+$/, "Not a header name"),
    value: checkMarker,
  }),
]);
export type CheckAssertion = z.infer<typeof checkAssertionSchema>;

/** Probe kinds. `http` is the only one implemented; the union is the seam. */
export const CHECK_PROBE_KINDS = ["http"] as const;
export type CheckProbeKind = (typeof CHECK_PROBE_KINDS)[number];

export const checkProbeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    url: checkUrlSchema,
    // HEAD is worth having for a check that only asserts on status or headers:
    // it is the difference between every node reading 64 KiB twice a day and
    // reading none. A body assertion against a HEAD probe is refused below.
    method: z.enum(["GET", "HEAD"]).default("GET"),
    timeoutMs: z.int().min(1_000).max(15_000).default(10_000),
  }),
]);
export type CheckProbe = z.infer<typeof checkProbeSchema>;

const BODY_ASSERTION_TYPES = new Set<CheckAssertionType>([
  "bodyContains",
  "bodyOmits",
  "bodyContainsAll",
  "bodyContainsAny",
  "bodyOccurrencesAtLeast",
  "bodyBytesAtLeast",
]);

/**
 * One line describing an assertion, for an admin card, a CLI table and an audit
 * entry. It lives here rather than in the UI so the three cannot drift, and so
 * that adding an assertion type is one place to edit rather than four.
 */
export const describeAssertion = (assertion: CheckAssertion): string => {
  const quoted = (value: string): string => JSON.stringify(value);
  switch (assertion.type) {
    case "statusIn":
      return `status is one of ${assertion.statuses.join(", ")}`;
    case "bodyContains":
      return `body contains ${quoted(assertion.value)}`;
    case "bodyOmits":
      return `body does not contain ${quoted(assertion.value)}`;
    case "bodyContainsAll":
      return `body contains all of ${assertion.values.map(quoted).join(", ")}`;
    case "bodyContainsAny":
      return `body contains any of ${assertion.values.map(quoted).join(", ")}`;
    case "bodyOccurrencesAtLeast":
      return `body contains ${quoted(assertion.value)} at least ${assertion.count} times`;
    case "bodyBytesAtLeast":
      return `body is at least ${assertion.count} bytes`;
    case "finalUrlContains":
      return `final URL contains ${quoted(assertion.value)}`;
    case "finalUrlOmits":
      return `final URL does not contain ${quoted(assertion.value)}`;
    case "headerContains":
      return `header ${assertion.name} contains ${quoted(assertion.value)}`;
  }
};

// The fields WITHOUT their defaults. `.partial()` makes a key optional but does
// NOT strip its `.default()`, so a partial built from a defaulted schema
// materialises those keys on every parse - which is exactly how an "update one
// field" request in this repo once rewrote every other field it never named.
// The update schema is built from this shape; only the create schema defaults.
const serviceCheckFields = {
  name: z.string().trim().min(1).max(80),
  probe: checkProbeSchema,
  // At least one. A check with no assertion is a check that is always green,
  // which is worse than no check at all because it looks like one.
  assertions: z.array(checkAssertionSchema).min(1).max(10),
  // 12 hours, and this is the service checks' period only - host metrics have
  // their own, separate periods.
  intervalSec: z.int().min(60).max(86_400),
  enabled: z.boolean(),
};

// A HEAD probe never reads a body, so a body assertion against one could only
// ever fail - silently, and in the direction that reads as "the service is
// blocked from this node". Refused at the contract rather than left to the node.
const refuseBodyAssertionsOnHead = (
  value: { probe?: CheckProbe; assertions?: CheckAssertion[] },
  ctx: z.RefinementCtx,
): void => {
  if (value.probe?.kind !== "http" || value.probe.method !== "HEAD") return;
  const offender = value.assertions?.find((assertion) =>
    BODY_ASSERTION_TYPES.has(assertion.type),
  );
  if (!offender) return;
  ctx.addIssue({
    code: "custom",
    path: ["assertions"],
    message: `A HEAD probe reads no body, so ${offender.type} could only ever fail`,
  });
};

export const serviceCheckSchema = z
  .object(serviceCheckFields)
  .extend({
    intervalSec: serviceCheckFields.intervalSec.default(43_200),
    enabled: serviceCheckFields.enabled.default(true),
  })
  .superRefine(refuseBodyAssertionsOnHead);
export const createServiceCheckRequestSchema = serviceCheckSchema;
export const updateServiceCheckRequestSchema = z
  .object(serviceCheckFields)
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  )
  .superRefine(refuseBodyAssertionsOnHead);
export type ServiceCheck = z.infer<typeof serviceCheckSchema>;
export type CreateServiceCheckRequest = z.infer<
  typeof createServiceCheckRequestSchema
>;
export type UpdateServiceCheckRequest = z.infer<
  typeof updateServiceCheckRequestSchema
>;

/**
 * What one node-agent can actually run, as it reports it.
 *
 * This is the half that makes an open set safe. A node that predates an
 * assertion type must not silently treat it as satisfied, and the panel has to
 * be able to tell "this node cannot run that check" from "the service is down".
 * The agent advertises what it knows; anything else comes back as `error`,
 * which collapses to `unknown` for a user rather than to `unavailable`.
 *
 * The arrays are plain strings, not the enums above, on purpose: a NEWER node
 * may advertise a type this panel has never heard of, and parsing that as an
 * enum would turn a forward-compatible fleet into a validation error.
 */
export const checkCapabilitiesSchema = z.object({
  probeKinds: z.array(z.string().max(40)).max(20),
  assertionTypes: z.array(z.string().max(40)).max(50),
});
export type CheckCapabilities = z.infer<typeof checkCapabilitiesSchema>;

/**
 * Which of a check's assertion types a given node does not advertise. Empty
 * when the node reports no capabilities at all: an agent too old to say what it
 * supports is not evidence that it supports nothing, and the node's own `error`
 * result is the authority either way.
 */
export const unsupportedAssertionTypes = (
  check: Pick<ServiceCheck, "assertions">,
  capabilities: CheckCapabilities | null,
): string[] => {
  if (!capabilities) return [];
  const known = new Set(capabilities.assertionTypes);
  return [
    ...new Set(
      check.assertions
        .map((assertion) => assertion.type)
        .filter((type) => !known.has(type)),
    ),
  ];
};

/** Admin/diagnostic status. Collapsed to three states for users, see below. */
export const serviceCheckStatusSchema = z.enum(["ok", "failed", "error"]);
export type ServiceCheckStatus = z.infer<typeof serviceCheckStatusSchema>;

export const serviceCheckResultSchema = z.object({
  checkId: z.uuid(),
  name: z.string(),
  status: serviceCheckStatusSchema,
  httpStatus: z.int().nullable(),
  latencyMs: z.int().nonnegative().nullable(),
  detail: z.string().max(300).nullable(),
  // Admin-only: where the request actually landed, which is the whole signal
  // for a service that answers a redirect instead of an error.
  finalUrl: z.string().max(500).nullable(),
  checkedAt: z.iso.datetime(),
  failingSince: z.iso.datetime().nullable(),
});
export type ServiceCheckResult = z.infer<typeof serviceCheckResultSchema>;

// --- The three states a user is shown FOR A SERVICE CHECK ---------------------
//
// Scope: this enum describes one service check on one node. It is NOT a node
// state and NOT an endpoint state. The name says so on purpose - a general name
// invites a second consumer, and the two things are not the same thing. Node
// health keeps `enabled` + `lastError` + `lastHealthAt`; endpoint reachability
// keeps its own reachable/stale/unknown enum above; host metrics keep numbers
// and nulls.
export const serviceCheckUserStateSchema = z.enum([
  "works",
  "unavailable",
  "unknown",
]);
export type ServiceCheckUserState = z.infer<typeof serviceCheckUserStateSchema>;

/**
 * Collapse a check's internal status into what a user is shown. `error` means
 * the node could not perform the check, so nothing is known about the service
 * itself - that is "unknown", not "unavailable". A result older than
 * `staleAfterSec` is "unknown" too: a stale green light is worse than no light.
 *
 * `staleAfterSec` is a parameter rather than a constant because it is three
 * times the check's OWN interval, so a check an admin set to five minutes goes
 * stale after fifteen, not after thirty-six hours.
 *
 * There is deliberately no sibling `toUserNodeState`. A node is not a check.
 */
export const toUserCheckState = (input: {
  status: ServiceCheckStatus | null;
  checkedAt: Date | null;
  now: Date;
  staleAfterSec: number;
}): ServiceCheckUserState => {
  if (input.status === null || input.checkedAt === null) return "unknown";
  const ageSec = (input.now.getTime() - input.checkedAt.getTime()) / 1_000;
  if (ageSec > input.staleAfterSec) return "unknown";
  if (input.status === "ok") return "works";
  if (input.status === "failed") return "unavailable";
  return "unknown";
};

/** What a user may see for one check: a name and one of three states. No URL, no detail. */
export const userServiceStatusSchema = z.object({
  name: z.string(),
  state: serviceCheckUserStateSchema,
});
export type UserServiceStatus = z.infer<typeof userServiceStatusSchema>;


// --- Manual server order and recommended servers ----------------------------
// Both are GLOBAL-ONLY on purpose: neither is part of `portalPolicySchema`, so
// they cannot be overridden per user and do not travel in `me.policy`.
//
// `nodeOrder` is the admin's hand-made order and the ONLY thing that decides
// position: the array index IS the position, so the list is stored and returned
// verbatim (never sorted, never deduplicated into a different order).
// `recommendedNodeIds` is a highlight and nothing else - it never moves a node.
// The control API additionally requires it to be a PREFIX of `nodeOrder` (only
// the top of the list may be recommended), which is a cross-field rule and so
// lives in the update handler, not in these schemas. Ids of deleted nodes are
// scrubbed on delete and, if any survive, simply match nothing. Users never
// receive either list - `GET /api/nodes` arrives already ordered, with a
// `recommended` flag per node.
export const MAX_RECOMMENDED_NODES = 100;
export const recommendedNodeIdsSchema = z
  .array(z.uuid())
  .max(MAX_RECOMMENDED_NODES);
export type RecommendedNodeIds = z.infer<typeof recommendedNodeIdsSchema>;

// Higher cap than the recommended list: the order may legitimately name every
// node in the fleet, while "recommended" is a shortlist by definition.
export const MAX_ORDERED_NODES = 500;
export const nodeOrderSchema = z.array(z.uuid()).max(MAX_ORDERED_NODES);
export type NodeOrder = z.infer<typeof nodeOrderSchema>;

// --- Per-user, per-node key limits -----------------------------------------
// The key limit has always been PER NODE (a user may hold up to `limit` keys on
// each node). This map lets an admin give a single user a different limit on a
// single node. Keys are node ids; a node with no entry falls back to the user's
// flat override and then to the global default.
export const nodeKeyLimitsSchema = z.record(z.uuid(), z.int().min(0).max(1_000));
export type NodeKeyLimits = z.infer<typeof nodeKeyLimitsSchema>;

/**
 * Payload of the admin `users/set-limit` action. It owns everything a single
 * user's quota is made of: the flat override, which nodes they may use, and
 * the per-node limits.
 *
 * - `keyLimitOverride` is required; `null` clears the override so the global
 *   default applies.
 * - `allowedNodeIds` is optional. Omitted leaves node availability untouched;
 *   `null` clears the per-user override so the global list applies again; `[]`
 *   means "no node at all" (deliberately distinct from `null`).
 * - `nodeKeyLimits` is optional. Omitted leaves the per-node limits untouched;
 *   `null` (or an empty map) clears them.
 * - `keyLimitMode` is optional. Omitted leaves the per-user mode untouched;
 *   `null` clears the override so the global mode applies again.
 */
export const setUserLimitRequestSchema = z.object({
  keyLimitOverride: z.int().min(0).max(1_000).nullable(),
  allowedNodeIds: z.array(z.uuid()).nullish(),
  nodeKeyLimits: nodeKeyLimitsSchema.nullish(),
  keyLimitMode: keyLimitModeSchema.nullish(),
});
export type SetUserLimitRequest = z.infer<typeof setUserLimitRequestSchema>;

/**
 * The operator's own note on a key: who it was issued to, what it replaced,
 * why it exists. Admin-only in both directions -- it is never returned to the
 * key's owner and never reaches a generated config.
 *
 * Empty clears it; the trim means a name of nothing but spaces clears it too
 * rather than storing whitespace. 80 characters is the column's width.
 */
export const setKeyInternalNameRequestSchema = z.object({
  internalName: z.string().trim().max(80),
});
export type SetKeyInternalNameRequest = z.infer<
  typeof setKeyInternalNameRequestSchema
>;

export type ProtocolKind = z.infer<typeof protocolKindSchema>;
export type KeyState = z.infer<typeof keyStateSchema>;
export type RouteProfile = z.infer<typeof routeProfileSchema>;
export type DeviceType = z.infer<typeof deviceTypeSchema>;
export type Role = z.infer<typeof roleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type CreateKeyRequest = z.infer<typeof createKeyRequestSchema>;
export type QuotaRequest = z.infer<typeof quotaRequestSchema>;
export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;
export type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type PortalPolicy = z.infer<typeof portalPolicySchema>;
export type PortalPolicyOverride = z.infer<typeof portalPolicyOverrideSchema>;

export type RulePayload = { cidrs: string[]; domains: string[] };

// --- Route rules take addresses, not site names ----------------------------
// A route profile steers WireGuard, and WireGuard steers on `AllowedIPs` —
// prefixes. A domain in a route rule has no path to the client at all: the
// panel never resolves it, so it becomes no prefix, and the two fields the
// export used to carry it in (`split_tunnel_sites`, `sites`) are not read by
// the AmneziaVPN client. Site-based split tunnelling exists in the client, but
// only for names typed on its own settings page, and that page is disabled
// whenever `AllowedIPs` is narrower than the whole address space — which every
// route profile makes it. So the rules below refuse domains on write instead
// of storing entries that quietly do nothing.
//
// The stored SHAPE still carries `domains`, so rows written before this rule
// keep parsing and stay visible; only the write path refuses them.
export const ROUTE_DOMAINS_UNSUPPORTED =
  "Route rules take addresses only — a site name in a route rule never reaches the client. For rules by site name use a full-traffic key and add the sites in the AmneziaVPN app itself: Settings → Connection → Site-based split tunnelling.";

/** Refuses a `{ cidrs, domains }` list that carries any domain. */
const rejectDomains = (
  list: { domains: string[] },
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void => {
  if (list.domains.length === 0) return;
  ctx.addIssue({
    code: "custom",
    path: [...path, "domains"],
    message: ROUTE_DOMAINS_UNSUPPORTED,
  });
};

// --- Per-user custom routes ------------------------------------------------
// Advanced users layer their OWN addresses on top of a split-tunnel profile's
// base feed at export time (union + dedup). Only the split-tunnel profiles
// accept extras — full_tunnel already routes everything through VPN.
// Base feed contents are never surfaced; users only ever see their own entries.
export const CUSTOM_ROUTE_PROFILES = ["ru_whitelist", "ru_blacklist"] as const;
export type CustomRouteProfile = (typeof CUSTOM_ROUTE_PROFILES)[number];

export const MAX_CUSTOM_CIDRS = 200;
// Only reached by rows written before route rules became addresses-only; the
// write path refuses domains outright.
export const MAX_CUSTOM_DOMAINS = 200;

// Punycode-aware bare hostname (mirrors the worker feed validator): no scheme,
// no wildcards, no leading dot. `.рф` etc. must be pre-encoded as `xn--`.
const customDomainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

// Accept an IPv4/IPv6 CIDR, or a bare IP normalized to a host route.
const customCidrSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([
    z.cidrv4(),
    z.cidrv6(),
    z.ipv4().transform((ip) => `${ip}/32`),
    z.ipv6().transform((ip) => `${ip}/128`),
  ]),
);

const customDomainSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.string().regex(customDomainPattern, "Invalid domain"),
);

export const customRouteListSchema = z.object({
  cidrs: z.array(customCidrSchema).max(MAX_CUSTOM_CIDRS).default([]),
  domains: z.array(customDomainSchema).max(MAX_CUSTOM_DOMAINS).default([]),
});

export const customRoutesSchema = z.object({
  ru_whitelist: customRouteListSchema.default({ cidrs: [], domains: [] }),
  ru_blacklist: customRouteListSchema.default({ cidrs: [], domains: [] }),
});

// The write path, as opposed to `customRoutesSchema` above, which also parses
// what is already in the database and must keep accepting the domains it finds
// there. See ROUTE_DOMAINS_UNSUPPORTED for why one refuses and the other cannot.
export const updateCustomRoutesRequestSchema = customRoutesSchema.superRefine(
  (routes, ctx) => {
    for (const profile of CUSTOM_ROUTE_PROFILES) {
      rejectDomains(routes[profile], ctx, [profile]);
    }
  },
);

export type CustomRouteList = z.infer<typeof customRouteListSchema>;
export type CustomRoutes = z.infer<typeof customRoutesSchema>;

// --- Global route overrides (admin-wide) -----------------------------------
// Admins layer their own address additions and exclusions on top of a
// split-tunnel profile's base feed for EVERY user. Exclusions are first;
// a user's own custom routes are applied last and therefore re-add anything the
// admin excluded (a deliberate per-user opt-back-in).
export const MAX_GLOBAL_CIDRS = 2_000;
// As above: a ceiling on what an older row may already hold, not on new writes.
export const MAX_GLOBAL_DOMAINS = 2_000;

export const globalRouteListSchema = z.object({
  cidrs: z.array(customCidrSchema).max(MAX_GLOBAL_CIDRS).default([]),
  domains: z.array(customDomainSchema).max(MAX_GLOBAL_DOMAINS).default([]),
});

// Factories, not shared literals: every parse gets its own arrays so a stored
// payload can never alias another one.
const newGlobalRouteList = (): GlobalRouteList => ({ cidrs: [], domains: [] });

export const globalRouteProfileSchema = z.object({
  add: globalRouteListSchema.default(newGlobalRouteList),
  exclude: globalRouteListSchema.default(newGlobalRouteList),
});

const newGlobalRouteProfile = (): GlobalRouteProfile => ({
  add: newGlobalRouteList(),
  exclude: newGlobalRouteList(),
});

export const globalRoutesSchema = z.object({
  ru_whitelist: globalRouteProfileSchema.default(newGlobalRouteProfile),
  ru_blacklist: globalRouteProfileSchema.default(newGlobalRouteProfile),
});

// Same split as the per-user schemas: stored payloads keep parsing, new writes
// are refused if they carry a site name.
export const updateGlobalRoutesRequestSchema = globalRoutesSchema.superRefine(
  (routes, ctx) => {
    for (const profile of CUSTOM_ROUTE_PROFILES) {
      for (const section of ["add", "exclude"] as const) {
        rejectDomains(routes[profile][section], ctx, [profile, section]);
      }
    }
  },
);

export type GlobalRouteList = z.infer<typeof globalRouteListSchema>;
export type GlobalRouteProfile = z.infer<typeof globalRouteProfileSchema>;
export type GlobalRoutes = z.infer<typeof globalRoutesSchema>;

export const emptyGlobalRoutes: GlobalRoutes = globalRoutesSchema.parse({});

// --- Manual route-feed refresh ---------------------------------------------
// The worker fetches the configured feeds on a timer; an operator can also ask
// for a check right now. Control-api only enqueues the job (the feeds and the
// fetch logic live in the worker), so both sides agree on this job type and on
// the single outbox deduplication key that keeps one run in flight at a time.
export const RULES_REFRESH_JOB_TYPE = "rules.refresh";
export const RULES_REFRESH_DEDUPLICATION_KEY = "rules.refresh";

export const rulesRefreshStatusSchema = z.object({
  // "idle" = never requested. The rest mirror the outbox row: a completed run
  // means "checked" — an unchanged feed is a successful no-op, not a failure.
  status: z.enum(["idle", "pending", "processing", "completed", "failed"]),
  /** When the run was last requested (ISO-8601), null while idle. */
  queuedAt: z.iso.datetime().nullable(),
  /** When the last run finished (ISO-8601), null if it never has. */
  completedAt: z.iso.datetime().nullable(),
  /** Message of the last failed or retried attempt, null otherwise. */
  lastError: z.string().nullable(),
});

export type RulesRefreshStatus = z.infer<typeof rulesRefreshStatusSchema>;

export const idleRulesRefreshStatus: RulesRefreshStatus = {
  status: "idle",
  queuedAt: null,
  completedAt: null,
  lastError: null,
};

// --- Two-way Cloudflare Access sync -----------------------------------------
// The worker reconciles the panel's active users with the Access policy. Both
// the hourly timer and every panel-side user change arm ONE outbox row; the
// outbox runner is the only executor, which is what keeps two runs from
// crossing their writes. Control-api and worker share the type and the key.
export const ACCESS_SYNC_JOB_TYPE = "access.sync";
export const ACCESS_SYNC_DEDUPLICATION_KEY = "access.sync";

export const accessSyncStatusSchema = rulesRefreshStatusSchema;
export type AccessSyncStatus = z.infer<typeof accessSyncStatusSchema>;
export const idleAccessSyncStatus: AccessSyncStatus = idleRulesRefreshStatus;

// --- AmneziaVPN client releases --------------------------------------------
// The panel tells users where to get the client. A panel user may sit on a
// network with no route to GitHub, so control-api resolves the current release
// server-side and the web app only renders the answer. These shapes are that
// answer; the resolution itself lives in apps/control-api/src/clientReleases.ts.

/**
 * Oldest official AmneziaVPN client that can use an AmneziaWG 3.1 key
 * (AGENTS.md "Protocol"). This is a protocol floor, not "the newest release" —
 * the two are different questions, so it is deliberately not part of the
 * resolved release payload. Single source for the create-key wizard hint and
 * the install guide alike.
 */
export const MIN_AWG3_CLIENT_VERSION = "5.0.1.5";

/**
 * Platforms the install guide offers, in the order the buttons render.
 *
 * Grouped by the instructions they share, not by vendor: Windows, macOS and
 * Linux are one desktop group (same app, same steps, a downloaded installer),
 * Android is its own (a store plus an APK), and iOS is its own (a store listing
 * under a different name, and no working route profiles). The guide renders
 * those three groups; this array is the flat list behind them.
 */
export const CLIENT_PLATFORMS = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
] as const;

export const clientPlatformSchema = z.enum(CLIENT_PLATFORMS);
export type ClientPlatform = z.infer<typeof clientPlatformSchema>;

/**
 * One place a user can be sent to get the client.
 *
 * - `store`      — Google Play / the App Store. No file name or size.
 * - `installer`  — a single release asset; `fileName` and `sizeBytes` are set
 *                  so the UI can show what is about to be downloaded.
 * - `releasePage` — the release listing, used when the expected asset was not
 *                  found and by the offline fallback. The user picks the file.
 */
export const clientAssetSchema = z.object({
  // Protocol-constrained on purpose: bare z.url() accepts `javascript:` (it is
  // a valid URL), and every one of these values is rendered as an href in the
  // install guide. The resolver only ever produces https, so this costs
  // nothing and closes the one shape that would matter if it ever did.
  url: z.url({ protocol: /^https?$/ }),
  kind: z.enum(["store", "installer", "releasePage"]),
  fileName: z.string().min(1).max(200).nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
});
export type ClientAsset = z.infer<typeof clientAssetSchema>;

export const clientPlatformDownloadSchema = z.object({
  platform: clientPlatformSchema,
  /** Where the platform's main button goes. */
  primary: clientAssetSchema,
  /**
   * The platform's second way in, when one button cannot serve everyone.
   * Android's is an escape hatch — the APK, for users Google Play does not
   * reach. iOS's is a different app: AmneziaVPN, which is hidden from the
   * Russian App Store, behind the DefaultVPN listing that is not.
   */
  alternate: clientAssetSchema.nullable(),
});
export type ClientPlatformDownload = z.infer<typeof clientPlatformDownloadSchema>;

export const clientReleaseSchema = z.object({
  /** Resolved release tag, e.g. "5.0.1.5". Null in the offline fallback. */
  version: z.string().min(1).max(40).nullable(),
  /** The release page. In the fallback, GitHub's permanent latest redirect. */
  releaseUrl: z.url({ protocol: /^https?$/ }),
  /** When the release was published (ISO-8601), null when unknown. */
  publishedAt: z.iso.datetime().nullable(),
  /** True when GitHub could not be reached and the pinned links are served. */
  fallback: z.boolean(),
  /** When this snapshot was produced (ISO-8601). */
  resolvedAt: z.iso.datetime(),
  /** Exactly one entry per platform, so the UI can map it straight to buttons. */
  downloads: z
    .array(clientPlatformDownloadSchema)
    .length(CLIENT_PLATFORMS.length),
});
export type ClientRelease = z.infer<typeof clientReleaseSchema>;

// --- Route profiles per device type ----------------------------------------

/**
 * Device types on which the official client is known NOT to apply a route
 * profile. Operator-verified on an iPhone, 2026-09-02 and 2026-09-03: a key
 * with `ru_whitelist` or `ru_blacklist` connects, but every destination goes
 * direct and the app gives no warning. Confirmed for BOTH import paths — the
 * pasted vpn:// key and an imported .conf.
 *
 * This is a STOP-GAP that makes the limitation visible, not a statement that
 * iOS will never support route profiles. The cause is not established (see the
 * T2-a backlog item); when it is fixed, empty this list and the CLI stops
 * warning, with no other change.
 *
 * The client observed was Default VPN -- the listing the Russian App Store
 * offers, because AmneziaVPN itself is hidden from it by Roskomnadzor
 * requirement. AmneziaVPN on iOS is a different app and was never observed
 * failing. "ios" stays on this list because Default VPN is what most iOS users
 * end up with, and the default has to be the common case.
 *
 * Only "ios" is listed, and it covers iPhone AND iPad — they are one value, so
 * iPad is covered by construction rather than by a guess. The other platforms
 * are deliberately absent: disabling a working feature on hardware where the
 * limitation was never observed would be the same class of mistake in the
 * other direction.
 */
export const ROUTE_PROFILE_UNSUPPORTED_DEVICES = ["ios"] as const;

/**
 * Whether a key created for this device type can usefully carry a route
 * profile. It drove the create-key wizard's greyed-out profile cards and the
 * key card's warning until #67 removed both — the panel cannot see which
 * client a device runs, so it offers every profile and lets the client sort
 * it out. What is left is advisory and lives in the CLI: `user-create-key`'s
 * warning and the `keys --needs-profile-warning` audit, which read the copy
 * of this predicate in `apps/cli/src/deviceProfiles.ts`.
 *
 * Takes a plain `string`, not `DeviceType`: `KeyView.deviceType` arrives from
 * the API as a string, and a browser tab left open across a deploy can still
 * send a retired value. An unrecognised value is treated as supported —
 * nothing is disabled without an observation.
 *
 * This is advice about where a key is being CREATED, not about where it will
 * be used: nothing in the export path branches on the device type, and nothing
 * should. See the plan's D9.
 */
export function deviceSupportsRouteProfiles(deviceType: string): boolean {
  return !(ROUTE_PROFILE_UNSUPPORTED_DEVICES as readonly string[]).includes(
    deviceType,
  );
}

// --- Node-agent self-update -------------------------------------------------
// The panel telling a node "run this image" is a remote-code-execution channel
// by construction, so the reference is constrained twice: it must be a DIGEST
// (a tag is mutable, and preflight refuses mutable references anyway), and it
// must live under the repository the node is configured to trust. Validated on
// the agent before anything is spooled, and again by the host-side updater,
// which reads the spool from disk and has a different threat model.
const AGENT_IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * True when `reference` is `<repo>@sha256:<64 hex>` for exactly `repo`.
 * Rejects a tag, a bare image id, another repository, a short digest, and
 * anything carrying a scheme or whitespace.
 */
export const isPublishableAgentImage = (
  reference: string,
  repository: string,
): boolean => {
  if (reference !== reference.trim() || /\s/.test(reference)) return false;
  if (reference.includes("://")) return false;
  const at = reference.indexOf("@");
  if (at < 0) return false;
  // No lastIndexOf: a second "@" means the reference is not what it claims.
  if (reference.indexOf("@", at + 1) >= 0) return false;
  const repo = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  return repo === repository && AGENT_IMAGE_DIGEST.test(digest);
};

/**
 * The body of `POST /api/admin/nodes/:id/agent-update`. `image` is optional and
 * omitting it means "the release the panel currently offers": the admin
 * confirms what the dialog showed, and passing it back explicitly is what makes
 * the confirmation binding when a newer release lands in between.
 */
export const nodeAgentUpdateActionSchema = z.object({
  image: z.string().min(1).max(512).optional(),
});
export type NodeAgentUpdateAction = z.infer<typeof nodeAgentUpdateActionSchema>;

/** What the panel sends a node when it asks it to update its agent. */
export const nodeAgentUpdateRequestSchema = z.object({
  // Always the resolved digest the admin confirmed, never a tag: the node must
  // install the image that was shown, not whatever a tag points at by then.
  image: z.string().min(1).max(512),
});
export type NodeAgentUpdateRequest = z.infer<
  typeof nodeAgentUpdateRequestSchema
>;

/**
 * The body of `POST /api/admin/nodes/:id/set-capacity`. The panel sends the
 * number the admin typed; nothing downstream re-derives it.
 */
export const nodeCapacityActionSchema = z.object({
  // 500 is the validated ceiling. infra/node/scripts/set-capacity.sh accepts up
  // to 1000 behind --force, and this path never passes it: an unvalidated
  // capacity stays an operator's decision at a shell.
  maxPeers: z.int().min(1).max(500),
});
export type NodeCapacityAction = z.infer<typeof nodeCapacityActionSchema>;

/** What the panel sends a node when it asks it to change its own capacity. */
export const nodeCapacityRequestSchema = z.object({
  maxPeers: z.int().min(1).max(500),
});
export type NodeCapacityRequest = z.infer<typeof nodeCapacityRequestSchema>;

export const NODE_CAPACITY_STATES = [
  "idle",
  "requested",
  "running",
  "succeeded",
  "failed",
] as const;
export const nodeCapacityStateSchema = z.enum(NODE_CAPACITY_STATES);
export type NodeCapacityState = z.infer<typeof nodeCapacityStateSchema>;

export const nodeCapacityStatusSchema = z.object({
  // Whether this node has been wired for in-panel capacity changes at all.
  available: z.boolean(),
  // SERVER_MAX_PEERS the container is actually running with. This is the number
  // that binds; nodes.max_peers is only the panel's own limit.
  currentMaxPeers: z.number().int().nonnegative(),
  state: nodeCapacityStateSchema,
  requestedMaxPeers: z.number().int().nullable(),
  // The applier's output, served back so an admin can see why a change failed
  // without opening an SSH session.
  log: z.string(),
  updatedAt: z.iso.datetime().nullable(),
  message: z.string().nullable(),
});
export type NodeCapacityStatus = z.infer<typeof nodeCapacityStatusSchema>;

export const NODE_AGENT_UPDATE_STATES = [
  "idle",
  "requested",
  "running",
  "succeeded",
  "failed",
] as const;
export const nodeAgentUpdateStateSchema = z.enum(NODE_AGENT_UPDATE_STATES);
export type NodeAgentUpdateState = z.infer<typeof nodeAgentUpdateStateSchema>;

export const nodeAgentUpdateStatusSchema = z.object({
  state: nodeAgentUpdateStateSchema,
  // The digest the node is installing or last installed, null when it has
  // never been asked.
  image: z.string().nullable(),
  // The updater's output, served back so the panel can show why an update
  // failed without anyone opening an SSH session.
  log: z.string(),
  updatedAt: z.iso.datetime().nullable(),
});
export type NodeAgentUpdateStatus = z.infer<typeof nodeAgentUpdateStatusSchema>;

// --- Access domain normalisation --------------------------------------------
// One spelling of a Cloudflare Access `email_domain` rule, shared by the
// worker (which reads what Cloudflare returns) and the API (which validates
// what the panel writes) so the two sides cannot drift into different ideas
// of what a domain looks like.

/**
 * One spelling of an Access domain, used by the API that validates what the
 * panel writes and by the worker that compares what Cloudflare returns. The
 * dashboard shows "Emails ending in @company.tld" and operators paste it that
 * way, so a leading "@" is stripped rather than refused.
 */
export const normalizeAccessDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/^@+/, "");

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * What the API accepts when an admin adds an Access domain rule. Stricter
 * than `normalizeAccessDomain` alone: the worker stays lenient about what
 * Cloudflare hands back (a human may have typed it in the dashboard), but the
 * API is strict about what the panel itself writes.
 */
export const accessDomainSchema = z
  .string()
  .transform(normalizeAccessDomain)
  // An address is a user, not a domain — say so rather than silently truncating.
  .refine((d) => !d.includes("@"), "that is an address, add the user instead")
  // At least two labels: a rule admitting an entire TLD is almost always a typo.
  .refine((d) => HOSTNAME.test(d), "not a domain name");

export const accessDomainListSchema = z
  .array(accessDomainSchema)
  .max(50)
  .transform((list) => [...new Set(list)]);

// Reading a rule version's stored source_url back into provider names.
export * from "./ruleSources.js";
