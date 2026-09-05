import { describe, expect, it } from "vitest";
import { defaultPortalPolicy } from "@amnezia/contracts";
import { internalNameFor, toKeyView, type KeyRow } from "./keyView.js";
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

const view = (actor: Actor, overrides: Partial<KeyRow> = {}) =>
  toKeyView({
    actor,
    key: row(overrides),
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
      current: null,
      policy: defaultPortalPolicy,
      activeByProfile: new Map([["ru_blacklist", "new"]]),
    });
    expect(outdated.rulesOutdated).toBe(true);
    expect(view(owner).rulesOutdated).toBe(false);
  });
});
