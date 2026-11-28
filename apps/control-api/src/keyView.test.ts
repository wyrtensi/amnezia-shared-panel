import { describe, expect, it } from "vitest";
import { defaultPortalPolicy, type KeyBridgeInfo } from "@amnezia/contracts";
import { bridgeInfoFor, internalNameFor, toKeyView, type KeyRow } from "./keyView.js";
import type { Actor } from "./service.js";

// Distinctive enough that searching a whole serialized response for it is a
// real assertion rather than a coincidence.
const NOTE = "kochkina, replaced 04.09";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";

const owner: Actor = {
  id: OWNER_ID,
  email: "owner@example.com",
  displayName: null,
  role: "user",
  status: "active",
};
const adminOwner: Actor = { ...owner, role: "admin" };
const otherAdmin: Actor = {
  ...adminOwner,
  id: "22222222-2222-2222-2222-222222222222",
  email: "admin@example.com",
};

const row = (overrides: Partial<KeyRow> = {}): KeyRow => ({
  id: "33333333-3333-3333-3333-333333333333",
  ownerId: OWNER_ID,
  nodeId: "44444444-4444-4444-4444-444444444444",
  publicKey: "pk",
  protocol: "awg2",
  state: "active",
  deviceType: "windows",
  deviceLabel: "Laptop",
  keyNumber: 1,
  internalName: NOTE,
  nameShowNode: true,
  nameShowLabel: true,
  nameShowNumber: true,
  routeProfile: "full_tunnel",
  routeRuleVersionId: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

const NODE = { name: "Internal server name 2", publicName: "Server name 2" };

const view = (actor: Actor, overrides: Partial<KeyRow> = {}) =>
  toKeyView({
    actor,
    key: row(overrides),
    node: NODE,
    current: null,
    policy: defaultPortalPolicy,
    activeByProfile: new Map(),
  });

/**
 * The promise that makes the operator-only note usable: it names a real
 * person, and a regular user never receives it — not rendered, not hidden in
 * the payload, not present at all.
 *
 * This is asserted on the SERIALIZED response and on the property list, not on
 * whether a component renders the value. A UI-only gate leaves the note in the
 * JSON that any user can read out of their own browser, which would defeat the
 * entire reason a person's name is considered safe in this field.
 */
describe("internal name on the owner-facing key payload", () => {
  it("omits the field entirely for a regular user, even on their own key", () => {
    const payload = view(owner);
    expect(Object.hasOwn(payload, "internalName")).toBe(false);
    expect(Object.keys(payload)).not.toContain("internalName");
    // What actually reaches the browser.
    expect(JSON.stringify(payload)).not.toContain("internalName");
    expect(JSON.stringify(payload)).not.toContain("kochkina");
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty(
      "internalName",
    );
  });

  it("gives an administrator the note on their own key", () => {
    const payload = view(adminOwner);
    expect(payload.internalName).toBe(NOTE);
    expect(JSON.stringify(payload)).toContain("kochkina");
  });

  it("still omits it for an administrator who does not own the key", () => {
    // Owner-facing routes filter on `ownerId`, so this pairing cannot occur
    // today. The gate repeats the ownership test anyway, so that a later route
    // that forgets to filter cannot turn `/api/keys` into a way to read other
    // people's notes without the admin confirmation `/api/admin/keys` demands.
    const payload = view(otherAdmin);
    expect(Object.hasOwn(payload, "internalName")).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("kochkina");
  });

  it("reports an unset note as null for an admin, not as an absent field", () => {
    // The distinction the editor needs: "no note yet" (offer Add) versus "you
    // are not allowed to see whether there is one".
    const payload = view(adminOwner, { internalName: null });
    expect(Object.hasOwn(payload, "internalName")).toBe(true);
    expect(payload.internalName).toBeNull();
  });

  it("decides on role and ownership together", () => {
    const key = { ownerId: OWNER_ID, internalName: NOTE };
    expect(internalNameFor(owner, key)).toEqual({});
    expect(internalNameFor(adminOwner, key)).toEqual({ internalName: NOTE });
    expect(internalNameFor(otherAdmin, key)).toEqual({});
  });

  it("exposes bridge routing metadata only to an admin viewing their own key", () => {
    const bridge: KeyBridgeInfo = {
      mode: "route",
      routeId: "55555555-5555-4555-8555-555555555555",
      effective: {
        routeId: "55555555-5555-4555-8555-555555555555",
        bridgeId: "66666666-6666-4666-8666-666666666666",
        bridgeName: "bridge-edge",
        publicIpv4: "198.51.100.10",
        publicUdpPort: 41000,
        source: "key",
      },
    };
    expect(bridgeInfoFor(owner, { ownerId: OWNER_ID }, bridge)).toEqual({});
    expect(bridgeInfoFor(otherAdmin, { ownerId: OWNER_ID }, bridge)).toEqual({});
    expect(bridgeInfoFor(adminOwner, { ownerId: OWNER_ID }, bridge)).toEqual({ bridge });

    const userPayload = toKeyView({
      actor: owner,
      key: row(),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      bridge,
    });
    expect(Object.hasOwn(userPayload, "bridge")).toBe(false);
    expect(JSON.stringify(userPayload)).not.toContain("198.51.100.10");

    const adminPayload = toKeyView({
      actor: adminOwner,
      key: row(),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      bridge,
    });
    expect(adminPayload.bridge).toEqual({ ...bridge, observed: null });

    // The path the device took, never the address it came from.
    const seen = (endpoint: string) =>
      toKeyView({
        actor: adminOwner,
        key: row(),
        node: NODE,
        current: { latestHandshakeAt: new Date(), receivedBytes: 0, sentBytes: 0, endpoint },
        policy: defaultPortalPolicy,
        activeByProfile: new Map(),
        bridge,
      });
    expect(seen("172.21.0.1:59393").bridge?.observed).toBe("bridge");
    const direct = seen("203.0.113.7:53079");
    expect(direct.bridge?.observed).toBe("direct");
    expect(JSON.stringify(direct)).not.toContain("203.0.113.7");
  });
});

describe("owner-facing key projection", () => {
  it("keeps the rest of the view identical for both roles", () => {
    // The gate must move exactly one field. Everything else a key card reads
    // is the same payload it has always been.
    const asUser = view(owner);
    const asAdmin: Record<string, unknown> = { ...view(adminOwner) };
    delete asAdmin.internalName;
    expect(asUser).toEqual(asAdmin);
  });

  it("honours the portal policy for the fields it already gated", () => {
    const shown = toKeyView({
      actor: owner,
      key: row(),
      node: NODE,
      current: {
        latestHandshakeAt: new Date("2026-09-02T00:00:00.000Z"),
        receivedBytes: 10n,
        sentBytes: 20n,
      },
      policy: { ...defaultPortalPolicy, showPublicKey: true },
      activeByProfile: new Map(),
    });
    expect(shown.publicKey).toBe("pk");
    expect(shown.traffic).toEqual({ receivedBytes: "10", sentBytes: "20" });
    expect(view(owner).publicKey).toBeUndefined();
  });

  it("marks a key outdated only against its own profile's active version", () => {
    const outdated = toKeyView({
      actor: owner,
      key: row({ routeProfile: "ru_blacklist", routeRuleVersionId: "old" }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "new"]]),
    });
    expect(outdated.rulesOutdated).toBe(true);
    expect(outdated.rulesUpdate).toEqual({ level: "soft" });
    expect(view(owner).rulesOutdated).toBe(false);
    expect(view(owner).rulesUpdate).toBeUndefined();
  });

  it("escalates outdated keys to important once per profile notice until delivered", () => {
    const notifiedAt = new Date("2026-11-24T12:00:00.000Z");
    const importantByProfile = new Map([
      [
        "ru_blacklist",
        { id: "v10", notifiedAt, note: "Added Clarity and fixed HoYoLAB" },
      ],
    ]);

    // Older key created before the important notice sees the important callout.
    const needsImportant = toKeyView({
      actor: owner,
      key: row({
        routeProfile: "ru_blacklist",
        routeRuleVersionId: "v5",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "v11"]]),
      importantByProfile,
    });
    expect(needsImportant.rulesOutdated).toBe(true);
    expect(needsImportant.rulesUpdate).toEqual({
      level: "important",
      notifiedAt: "2026-11-24T12:00:00.000Z",
      note: "Added Clarity and fixed HoYoLAB",
    });

    // Key that already received the important version falls back to soft when a later auto-version arrives.
    const alreadyGotImportant = toKeyView({
      actor: owner,
      key: row({
        routeProfile: "ru_blacklist",
        routeRuleVersionId: "v10",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        rulesDeliveredAt: new Date("2026-11-24T11:00:00.000Z"),
      }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "v11"]]),
      importantByProfile,
    });
    expect(alreadyGotImportant.rulesOutdated).toBe(true);
    expect(alreadyGotImportant.rulesUpdate).toEqual({ level: "soft" });

    // Key delivered after `notifiedAt` also sees only soft on subsequent auto-versions.
    const deliveredAfter = toKeyView({
      actor: owner,
      key: row({
        routeProfile: "ru_blacklist",
        routeRuleVersionId: "v11",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        rulesDeliveredAt: new Date("2026-11-24T13:00:00.000Z"),
      }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "v12"]]),
      importantByProfile,
    });
    expect(deliveredAfter.rulesOutdated).toBe(true);
    expect(deliveredAfter.rulesUpdate).toEqual({ level: "soft" });

    // Key already on the active version sees no notice even if active was marked important.
    const currentKey = toKeyView({
      actor: owner,
      key: row({
        routeProfile: "ru_blacklist",
        routeRuleVersionId: "v10",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "v10"]]),
      importantByProfile,
    });
    expect(currentKey.rulesOutdated).toBe(false);
    expect(currentKey.rulesUpdate).toBeUndefined();
  });
});

/**
 * The key card names the server its key lives on. It used to look the server
 * up in `/api/nodes`, which lists only the servers a user may create keys on,
 * so a key on a server closed for creation showed "—". The name now travels
 * with the key, under the same rule `/api/nodes` uses.
 */
describe("server name on the owner-facing key payload", () => {
  it("carries the server's public name", () => {
    expect(view(owner).nodeName).toBe("Server name 2");
  });

  it("never sends the internal admin name when a public name is set", () => {
    expect(JSON.stringify(view(owner))).not.toContain("Internal server name 2");
  });

  it("falls back to the node name when there is no public name", () => {
    const payload = toKeyView({
      actor: owner,
      key: row(),
      node: { name: "Server name 5", publicName: null },
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
    });
    expect(payload.nodeName).toBe("Server name 5");
  });
});

describe("toKeyView nodeReachability", () => {
  const blocked = { state: "blocked" as const, since: "2026-11-12T09:11:00.000Z" };
  const withReachability = (nodeReachability?: typeof blocked) =>
    toKeyView({
      actor: owner,
      key: row(),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      nodeReachability,
    });

  it("carries the key's server verdict when given", () => {
    expect(withReachability(blocked).nodeReachability).toEqual(blocked);
  });

  it("leaves the property off when node status is hidden", () => {
    expect("nodeReachability" in withReachability()).toBe(false);
  });
});

describe("egress info on the owner-facing key payload", () => {
  const sampleEgress = {
    effectiveExitIp: "1.1.1.1",
    exitLabel: "Clean Exit",
    dnsPrimary: "9.9.9.9",
    dnsSecondary: null,
    mode: "routed" as const,
  };

  it("omits egress metadata for regular users even on their own key", () => {
    const payload = toKeyView({
      actor: owner,
      key: row({ endpointId: "ep-1" }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      egress: sampleEgress,
    });
    expect(payload.endpointId).toBe("ep-1");
    expect(Object.hasOwn(payload, "egress")).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("1.1.1.1");
  });

  it("omits egress metadata for another admin", () => {
    const payload = toKeyView({
      actor: otherAdmin,
      key: row(),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      egress: sampleEgress,
    });
    expect(Object.hasOwn(payload, "egress")).toBe(false);
  });

  it("exposes egress metadata to an admin viewing their own key", () => {
    const payload = toKeyView({
      actor: adminOwner,
      key: row(),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      egress: sampleEgress,
    });
    expect(payload.egress).toEqual(sampleEgress);
  });
});

describe("manual server-change update notice on owner-facing key payload", () => {
  it("picks the newest notice across node, egress IP, and endpoint for active keys", () => {
    const payload = toKeyView({
      actor: owner,
      key: row({ createdAt: new Date("2026-11-01T00:00:00.000Z") }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      serverUpdateCandidates: [
        { scope: "node", notifiedAt: new Date("2026-11-10T00:00:00.000Z"), note: "Node reboot" },
        {
          scope: "exit",
          notifiedAt: new Date("2026-11-20T00:00:00.000Z"),
          note: "Updated DNS settings",
        },
        { scope: "endpoint", notifiedAt: new Date("2026-11-15T00:00:00.000Z"), note: null },
      ],
    });
    expect(payload.serverUpdate).toEqual({
      scope: "exit",
      notifiedAt: "2026-11-20T00:00:00.000Z",
      note: "Updated DNS settings",
    });
  });

  it("clears once owner delivers config after notifiedAt and ignores keys created after notifiedAt", () => {
    const notifiedAt = new Date("2026-11-20T00:00:00.000Z");
    const deliveredAfter = toKeyView({
      actor: owner,
      key: row({
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        configDeliveredAt: new Date("2026-11-20T00:05:00.000Z"),
      }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      serverUpdateCandidates: [{ scope: "node", notifiedAt, note: null }],
    });
    expect(deliveredAfter.serverUpdate).toBeUndefined();

    const createdAfter = toKeyView({
      actor: owner,
      key: row({ createdAt: new Date("2026-11-21T00:00:00.000Z") }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      serverUpdateCandidates: [{ scope: "node", notifiedAt, note: null }],
    });
    expect(createdAfter.serverUpdate).toBeUndefined();

    const revoked = toKeyView({
      actor: owner,
      key: row({ state: "revoked", createdAt: new Date("2026-11-01T00:00:00.000Z") }),
      node: NODE,
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map(),
      serverUpdateCandidates: [{ scope: "node", notifiedAt, note: null }],
    });
    expect(revoked.serverUpdate).toBeUndefined();
  });
});
