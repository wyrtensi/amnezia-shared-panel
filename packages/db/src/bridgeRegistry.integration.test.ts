import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";
import { nodes, vpnBridgeRoutes, vpnBridges } from "./schema.js";

// Constraint behavior of the bridge registry against a real PostgreSQL. Runs
// only when TEST_DATABASE_URL points at a migrated database.
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("bridge registry constraints", () => {
  let handle: ReturnType<typeof createDatabase>;
  const nodeIds: string[] = [];
  const bridgeIds: string[] = [];

  const makeNode = async () => {
    const [row] = await handle.db
      .insert(nodes)
      .values({
        name: `bridge-test-${randomUUID()}`,
        apiBaseUrl: "http://127.0.0.1:1",
        credentialsCiphertext: "x",
        credentialsNonce: "x",
        credentialsAuthTag: "x",
        credentialsKeyVersion: 1,
        labelSecretCiphertext: "x",
        labelSecretNonce: "x",
        labelSecretAuthTag: "x",
        labelSecretKeyVersion: 1,
      })
      .returning();
    nodeIds.push(row!.id);
    return row!;
  };

  let ipCounter = 0;
  const uniqueIp = () => `45.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  const makeBridge = async (values: Partial<typeof vpnBridges.$inferInsert> = {}) => {
    const [row] = await handle.db
      .insert(vpnBridges)
      .values({ name: "b", publicIpv4: uniqueIp(), ...values })
      .returning();
    bridgeIds.push(row!.id);
    return row!;
  };

  const makeRoute = (
    nodeId: string,
    bridgeId: string,
    values: Partial<typeof vpnBridgeRoutes.$inferInsert> = {},
  ) => {
    const id = randomUUID();
    return handle.db
      .insert(vpnBridgeRoutes)
      .values({
        id,
        nodeId,
        bridgeId,
        publicUdpPort: 41000,
        frpProxyName: `awg-route-${id}`,
        ...values,
      })
      .returning()
      .then((rows) => rows[0]!);
  };

  beforeAll(() => {
    handle = createDatabase(databaseUrl!);
  });

  afterEach(async () => {
    if (bridgeIds.length > 0) {
      await handle.db
        .delete(vpnBridgeRoutes)
        .where(inArray(vpnBridgeRoutes.bridgeId, bridgeIds));
      await handle.db.delete(vpnBridges).where(inArray(vpnBridges.id, bridgeIds));
      bridgeIds.length = 0;
    }
    if (nodeIds.length > 0) {
      await handle.db.delete(nodes).where(inArray(nodes.id, nodeIds));
      nodeIds.length = 0;
    }
  });

  afterAll(async () => {
    await handle.client.end();
  });

  it("migrates existing and new nodes as Direct with revision 0 and no routes", async () => {
    const node = await makeNode();
    expect(node.vpnEndpointRevision).toBe(0);
    const routes = await handle.db
      .select()
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.nodeId, node.id));
    expect(routes).toEqual([]);
  });

  it("applies the default ports and pending enrollment status", async () => {
    const bridge = await makeBridge();
    expect(bridge).toMatchObject({
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
      managementStatus: "pending_enrollment",
      lastObservedAt: null,
      lastPollAttemptAt: null,
    });
  });

  it("keeps the public IPv4 unique", async () => {
    const bridge = await makeBridge();
    await expect(makeBridge({ publicIpv4: bridge.publicIpv4 })).rejects.toThrow();
  });

  it.each([
    { controlTcpPort: 0 },
    { controlTcpPort: 65_536 },
    { udpPortStart: 0 },
    { udpPortEnd: 65_536 },
    { udpPortStart: 5, udpPortEnd: 4 },
    { managementStatus: "bogus" as never },
  ])("refuses an invalid bridge %j", async (values) => {
    await expect(makeBridge(values)).rejects.toThrow();
  });

  it("holds a bridge port once across nodes", async () => {
    const bridge = await makeBridge();
    const [a, b] = [await makeNode(), await makeNode()];
    await makeRoute(a.id, bridge.id, { publicUdpPort: 41001 });
    await expect(makeRoute(b.id, bridge.id, { publicUdpPort: 41001 })).rejects.toThrow();
    await expect(makeRoute(b.id, bridge.id, { publicUdpPort: 41002 })).resolves.toBeTruthy();
  });

  it("holds one route per node and bridge pairing", async () => {
    const bridge = await makeBridge();
    const other = await makeBridge();
    const node = await makeNode();
    await makeRoute(node.id, bridge.id, { publicUdpPort: 41001 });
    await expect(makeRoute(node.id, bridge.id, { publicUdpPort: 41002 })).rejects.toThrow();
    await expect(makeRoute(node.id, other.id, { publicUdpPort: 41001 })).resolves.toBeTruthy();
  });

  it("allows one active route per node", async () => {
    const [b1, b2, b3] = [await makeBridge(), await makeBridge(), await makeBridge()];
    const node = await makeNode();
    await makeRoute(node.id, b1.id, { state: "active" });
    await expect(makeRoute(node.id, b2.id, { state: "active" })).rejects.toThrow();
    await expect(makeRoute(node.id, b2.id, { state: "retiring" })).resolves.toBeTruthy();
    await expect(makeRoute(node.id, b3.id, { state: "draft" })).resolves.toBeTruthy();
  });

  it.each([
    { state: "released" as never },
    { publicUdpPort: 0 },
    { publicUdpPort: 65_536 },
    { verificationMethod: "guess" as never },
    { verificationResult: "maybe" as never },
  ])("refuses an invalid route %j", async (values) => {
    const bridge = await makeBridge();
    const node = await makeNode();
    await expect(makeRoute(node.id, bridge.id, values)).rejects.toThrow();
  });

  it("refuses to delete a bridge or node that routes reference", async () => {
    const bridge = await makeBridge();
    const node = await makeNode();
    await makeRoute(node.id, bridge.id);
    await expect(
      handle.db.delete(vpnBridges).where(eq(vpnBridges.id, bridge.id)),
    ).rejects.toThrow();
    await expect(handle.db.delete(nodes).where(eq(nodes.id, node.id))).rejects.toThrow();
    await handle.db.delete(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.bridgeId, bridge.id));
    await expect(
      handle.db.delete(vpnBridges).where(eq(vpnBridges.id, bridge.id)),
    ).resolves.toBeDefined();
  });
});
