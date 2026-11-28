import type {
  KeyBridgeInfo,
  KeyEgressInfo,
  KeyRulesUpdate,
  KeyServerUpdateNotice,
  KeyServerUpdateScope,
  PortalPolicy,
  RouteProfile,
  UserNodeReachability,
} from "@amnezia/contracts";
import { observedKeyPath } from "./bridgeEndpoint.js";
import type { Actor, KeyView } from "./service.js";

/**
 * The row shapes the owner-facing key projection reads. Declared structurally
 * rather than as the drizzle table types, so the projection stays a pure
 * function that a unit test can call without a database.
 */
export type KeyRow = {
  id: string;
  ownerId: string;
  nodeId: string;
  endpointId?: string | null;
  publicKey: string | null;
  protocol: KeyView["protocol"];
  state: KeyView["state"];
  deviceType: KeyView["deviceType"];
  deviceLabel: string | null;
  keyNumber: number | null;
  internalName: string | null;
  nameShowNode: boolean;
  nameShowLabel: boolean;
  nameShowNumber: boolean;
  routeProfile: RouteProfile;
  routeRuleVersionId: string | null;
  rulesDeliveredAt?: Date | null;
  configDeliveredAt?: Date | null;
  createdAt: Date;
};

/** Latest admin-triggered important notice for one route profile. */
export type ImportantRuleNotice = {
  id: string;
  notifiedAt: Date;
  note: string | null;
};

/** Manual admin server-change notice candidate at node, egress IP, or endpoint level. */
export type ServerUpdateNoticeCandidate = {
  scope: KeyServerUpdateScope;
  notifiedAt: Date;
  note: string | null;
};

/**
 * Pick the newest manual server-change notice applicable to an active key,
 * returning undefined once the owner has downloaded/viewed their own config
 * after `notifiedAt` (or if the key was created after `notifiedAt`).
 */
export const resolveKeyServerUpdate = (
  key: Pick<KeyRow, "state" | "createdAt" | "configDeliveredAt">,
  candidates: ReadonlyArray<ServerUpdateNoticeCandidate | null | undefined>,
): KeyServerUpdateNotice | undefined => {
  if (key.state !== "active") return undefined;
  let latest: ServerUpdateNoticeCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!latest || candidate.notifiedAt.getTime() > latest.notifiedAt.getTime()) {
      latest = candidate;
    }
  }
  if (!latest) return undefined;
  const deliveredAt = key.configDeliveredAt ?? key.createdAt;
  if (deliveredAt.getTime() >= latest.notifiedAt.getTime()) return undefined;
  return {
    scope: latest.scope,
    notifiedAt: latest.notifiedAt.toISOString(),
    ...(latest.note ? { note: latest.note } : {}),
  };
};

/** The two node columns the key's server name is derived from. */
export type KeyNodeRow = {
  name: string;
  publicName: string | null;
};

export type PeerCurrentRow = {
  latestHandshakeAt: Date | null;
  /** Where the node last saw the peer; read only to tell bridge from direct. */
  endpoint?: string | null;
  receivedBytes: bigint | number;
  sentBytes: bigint | number;
};

/**
 * Who is allowed to read a key's operator-only note, decided on the server.
 *
 * The note names a real person — that is the whole point of the field — so the
 * rule that makes it safe to write one has to hold in the PAYLOAD, not in the
 * UI. A component that renders the note conditionally still ships it in the
 * JSON that anyone can read out of their own browser's network tab, which is
 * exactly the leak the field is trusted not to have.
 *
 * Two conditions, and both are load-bearing:
 *
 *  - the caller is an administrator. A regular user never receives the note,
 *    on any key, including their own;
 *  - the caller owns the key. Owner-facing routes only ever return the
 *    caller's own rows (`listKeys` filters on `ownerId`), so this is already
 *    true where it is called from — it is repeated here so that the rule
 *    survives a future route that forgets to filter. An admin reading someone
 *    ELSE's note goes through `/api/admin/keys`, which is role-gated at the
 *    edge by `adminFor`.
 *
 * Returns a fragment to spread rather than a value, so a refusal leaves the
 * property OFF the object instead of setting it to `undefined`. Serialization
 * would drop an undefined one anyway, but the difference matters to anything
 * that reasons about the view before it is stringified — a test included.
 */
export const internalNameFor = (
  actor: Pick<Actor, "id" | "role">,
  key: Pick<KeyRow, "ownerId" | "internalName">,
): { internalName?: string | null } =>
  actor.role === "admin" && key.ownerId === actor.id
    ? { internalName: key.internalName }
    : {};

/**
 * Same server-side gate as `internalNameFor`: bridge host/route metadata is
 * operational information shown only to an administrator viewing their own key.
 */
export const bridgeInfoFor = (
  actor: Pick<Actor, "id" | "role">,
  key: Pick<KeyRow, "ownerId">,
  bridge: KeyBridgeInfo | undefined,
): { bridge?: KeyBridgeInfo } =>
  actor.role === "admin" && key.ownerId === actor.id && bridge
    ? { bridge }
    : {};

/**
 * Same server-side gate as `internalNameFor`: resolved exit IP and per-exit
 * DNS details stay invisible to regular users and appear only on an admin's
 * own key view (or via `/api/admin/keys`).
 */
export const egressInfoFor = (
  actor: Pick<Actor, "id" | "role">,
  key: Pick<KeyRow, "ownerId">,
  egress: KeyEgressInfo | undefined,
): { egress?: KeyEgressInfo } =>
  actor.role === "admin" && key.ownerId === actor.id && egress
    ? { egress }
    : {};

/**
 * The owner-facing view of one key, as `/api/keys` returns it.
 *
 * Extracted from `listKeys` so the projection — and above all the gate on the
 * operator-only note — can be asserted without a database.
 */
export const toKeyView = ({
  actor,
  key,
  node,
  current,
  policy,
  activeByProfile,
  importantByProfile,
  serverUpdateCandidates,
  nodeReachability,
  bridge,
  egress,
}: {
  actor: Pick<Actor, "id" | "role">;
  key: KeyRow;
  node: KeyNodeRow;
  current: PeerCurrentRow | null;
  policy: PortalPolicy;
  activeByProfile: Map<string, string>;
  importantByProfile?: Map<string, ImportantRuleNotice>;
  /** Manual server-change notice candidates (node, egress IP, endpoint); never leaks IPs/names. */
  serverUpdateCandidates?: ReadonlyArray<ServerUpdateNoticeCandidate | null | undefined>;
  /** The key's server verdict; undefined when the policy hides node status. */
  nodeReachability?: UserNodeReachability;
  /** Admin-only bridge routing summary; omitted for regular users. */
  bridge?: KeyBridgeInfo;
  /** Admin-only egress routing summary; omitted for regular users. */
  egress?: KeyEgressInfo;
}): KeyView => {
  const rulesOutdated =
    key.routeProfile !== "full_tunnel" &&
    activeByProfile.has(key.routeProfile) &&
    activeByProfile.get(key.routeProfile) !== key.routeRuleVersionId;
  const latestImportant = rulesOutdated
    ? importantByProfile?.get(key.routeProfile)
    : undefined;
  const deliveredAt = key.rulesDeliveredAt ?? key.createdAt;
  const isImportant =
    latestImportant !== undefined &&
    key.routeRuleVersionId !== latestImportant.id &&
    deliveredAt.getTime() < latestImportant.notifiedAt.getTime();
  const rulesUpdate: KeyRulesUpdate | undefined = !rulesOutdated
    ? undefined
    : isImportant
      ? {
          level: "important",
          notifiedAt: latestImportant.notifiedAt.toISOString(),
          ...(latestImportant.note ? { note: latestImportant.note } : {}),
        }
      : { level: "soft" };
  const serverUpdate = serverUpdateCandidates
    ? resolveKeyServerUpdate(key, serverUpdateCandidates)
    : undefined;

  return {
    id: key.id,
    ownerId: key.ownerId,
    nodeId: key.nodeId,
    ...(key.endpointId !== undefined ? { endpointId: key.endpointId } : {}),
    // Read from the key's own node, not from `/api/nodes`: that list holds only
    // the servers the user may create keys on, and a key outlives that
    // permission. Same rule as `listNodes`: the public name when there is one,
    // so the internal admin name never leaves the server.
    nodeName: node.publicName ?? node.name,
    ...(nodeReachability ? { nodeReachability } : {}),
    publicKey: policy.showPublicKey ? key.publicKey : undefined,
    protocol: key.protocol,
    state: key.state,
    deviceType: key.deviceType,
    deviceLabel: key.deviceLabel,
    keyNumber: key.keyNumber,
    ...internalNameFor(actor, key),
    ...bridgeInfoFor(actor, key, bridge ? { ...bridge, observed: observedKeyPath(current?.endpoint) } : undefined),
    ...egressInfoFor(actor, key, egress),
    nameDisplay: {
      server: key.nameShowNode,
      label: key.nameShowLabel,
      number: key.nameShowNumber,
    },
    routeProfile: key.routeProfile,
    rulesOutdated,
    ...(rulesUpdate ? { rulesUpdate } : {}),
    ...(serverUpdate ? { serverUpdate } : {}),
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: policy.showLastUsed
      ? (current?.latestHandshakeAt?.toISOString() ?? null)
      : undefined,
    traffic:
      policy.showTraffic && current
        ? {
            receivedBytes: current.receivedBytes.toString(),
            sentBytes: current.sentBytes.toString(),
          }
        : undefined,
  };
};
