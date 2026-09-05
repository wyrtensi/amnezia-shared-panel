import type { PortalPolicy, RouteProfile } from "@amnezia/contracts";
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
  createdAt: Date;
};

export type PeerCurrentRow = {
  latestHandshakeAt: Date | null;
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
 * The owner-facing view of one key, as `/api/keys` returns it.
 *
 * Extracted from `listKeys` so the projection — and above all the gate on the
 * operator-only note — can be asserted without a database.
 */
export const toKeyView = ({
  actor,
  key,
  current,
  policy,
  activeByProfile,
}: {
  actor: Pick<Actor, "id" | "role">;
  key: KeyRow;
  current: PeerCurrentRow | null;
  policy: PortalPolicy;
  activeByProfile: Map<string, string>;
}): KeyView => ({
  id: key.id,
  ownerId: key.ownerId,
  nodeId: key.nodeId,
  publicKey: policy.showPublicKey ? key.publicKey : undefined,
  protocol: key.protocol,
  state: key.state,
  deviceType: key.deviceType,
  deviceLabel: key.deviceLabel,
  keyNumber: key.keyNumber,
  ...internalNameFor(actor, key),
  nameDisplay: {
    server: key.nameShowNode,
    label: key.nameShowLabel,
    number: key.nameShowNumber,
  },
  routeProfile: key.routeProfile,
  rulesOutdated:
    key.routeProfile !== "full_tunnel" &&
    activeByProfile.has(key.routeProfile) &&
    activeByProfile.get(key.routeProfile) !== key.routeRuleVersionId,
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
});
