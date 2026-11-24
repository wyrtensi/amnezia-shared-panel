import { describe, expect, it } from "vitest";
import type {
  AdminKey,
  AdminNode,
  AuditEvent,
} from "@/components/admin/admin-data";
import {
  collectKeyContextFromAudit,
  formatAuditMetaPills,
  resolveAuditKeyDetails,
} from "./audit-display";
import { messages } from "./i18n/messages";

const t = (key: string): string =>
  (messages.ru as Record<string, string>)[key] ?? key;

const node = (id: string, name: string, endpointName?: string): AdminNode =>
  ({
    id,
    name,
    publicEndpoints: endpointName
      ? [{ id: `${id}-ep1`, ordinal: 1, name: endpointName }]
      : [],
  }) as unknown as AdminNode;

const keyRow = (overrides: Partial<AdminKey> = {}): AdminKey =>
  ({
    id: "key-1",
    ownerId: "user-1",
    ownerEmail: "alice@example.test",
    nodeId: "node-1",
    endpointId: "node-1-ep1",
    endpointName: "Primary",
    protocol: "awg3",
    state: "revoked",
    deviceType: "ios",
    deviceLabel: "iPhone 15",
    keyNumber: 2,
    internalName: "Work phone",
    routeProfile: "ru_blacklist",
    routeRuleVersionId: null,
    lastUsedAt: null,
    failureReason: null,
    ...overrides,
  }) as AdminKey;

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "ev-1",
  actorUserId: "admin-1",
  actorType: "user",
  action: "admin.keys.revoke",
  targetType: "keys",
  targetId: "key-1",
  metadata: null,
  createdAt: "2026-11-24T01:00:00.000Z",
  ...overrides,
});

describe("resolveAuditKeyDetails", () => {
  const nodesById = new Map([
    ["node-1", node("node-1", "eu-west", "Primary")],
    ["node-2", node("node-2", "us-east")],
  ]);
  const personFor = (id: string | null) =>
    id === "user-1"
      ? { text: "alice@example.test", role: "user" }
      : id === "admin-1"
        ? { text: "admin@example.test", role: "admin" }
        : null;

  it("enriches legacy metadata-less revoke events from live/revoked keys", () => {
    const details = resolveAuditKeyDetails({
      event: event({ metadata: null }),
      keysById: new Map([["key-1", keyRow()]]),
      logKeyContext: new Map(),
      nodesById,
      personFor,
      t,
    });

    expect(details).toEqual({
      title: "iPhone 15 #2",
      internalName: "Work phone",
      serverLabel: "eu-west · Primary",
      owner: { text: "alice@example.test", role: "user" },
      deviceLabel: "iPhone",
      protocolLabel: "AWG 3.1",
      routeLabel: "В обход Рунета",
      nodeIds: ["node-1"],
    });
  });

  it("recovers purged key details from event metadata and earlier log snapshots", () => {
    const purgeEvent = event({
      id: "ev-purge",
      action: "admin.keys.purge",
      metadata: {
        ownerId: "user-1",
        nodeId: "node-2",
        deviceLabel: "MacBook",
        deviceType: "macos",
        protocol: "awg3",
        routeProfile: "full_tunnel",
        keyNumber: 4,
      },
    });
    const earlierRevoke = event({
      id: "ev-revoke",
      actorUserId: "user-1",
      action: "vpn_key.revoke_requested",
      targetType: "vpn_key",
      metadata: null,
    });
    const logKeyContext = collectKeyContextFromAudit([purgeEvent, earlierRevoke]);

    const details = resolveAuditKeyDetails({
      event: earlierRevoke,
      keysById: new Map(),
      logKeyContext,
      nodesById,
      personFor,
      t,
    });

    expect(details.title).toBe("MacBook #4");
    expect(details.serverLabel).toBe("us-east");
    // Owner matches actor, so no redundant owner chip is emitted.
    expect(details.owner).toBeNull();
    expect(details.deviceLabel).toBe("Mac");
    expect(details.protocolLabel).toBe("AWG 3.1");
    expect(details.routeLabel).toBe("Весь трафик");
    expect(details.nodeIds).toEqual(["node-2"]);
  });

  it("resolves nodeIds arrays on offboard events into human server pills", () => {
    const offboard = event({
      action: "admin.users.offboard",
      targetType: "users",
      targetId: "user-1",
      metadata: {
        keysQueuedForRevoke: 2,
        nodeIds: ["node-1", "node-2"],
      },
    });
    const details = resolveAuditKeyDetails({
      event: offboard,
      keysById: new Map(),
      logKeyContext: new Map(),
      nodesById,
      personFor,
      t,
    });
    expect(details.nodeIds).toEqual(["node-1", "node-2"]);

    const pills = formatAuditMetaPills({
      event: offboard,
      hasKeyDetails: false,
      resolveReference: (kind, id) =>
        kind === "node" ? (nodesById.get(id)?.name ?? null) : null,
      t,
    });
    expect(pills).toEqual([
      "Ключей к отзыву: 2",
      "Серверы: eu-west, us-east",
    ]);
  });

  it("omits key snapshot fields from generic metadata pills when key chips are shown", () => {
    const createEv = event({
      action: "vpn_key.create_requested",
      targetType: "vpn_key",
      metadata: {
        ownerId: "user-1",
        nodeId: "node-1",
        protocol: "awg3",
        routeProfile: "ru_blacklist",
        deviceType: "ios",
        deviceLabel: "iPhone",
        nameDisplay: { server: true, label: true, number: false },
        bridgeMode: "inherit",
      },
    });
    const pills = formatAuditMetaPills({
      event: createEv,
      hasKeyDetails: true,
      resolveReference: () => null,
      t,
    });
    expect(pills).toEqual(["Мост: inherit"]);
  });
});
