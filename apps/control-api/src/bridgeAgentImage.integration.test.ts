import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, bridgeAgentReleases, createDatabase, nodeAgentReleases, users, vpnBridges } from "@amnezia/db";

import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const runTag = randomBytes(3).toString("hex");
const APPROVED = `ghcr.io/example-${runTag}/repo/bridge-agent`;
const OTHER = `ghcr.io/example-${runTag}/repo/node-agent`;
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe("bridge setup command image (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const bridgeIds: string[] = [];
  const userIds: string[] = [];
  let admin: Actor;
  let ipCounter = 0;

  const repositoryFor = (bridgeAgentImageRepository?: string) => {
    if (!database) throw new Error("No database");
    return new PostgresControlRepository({ db: database.db, keyring, bridgeAgentImageRepository });
  };

  const addBridge = async (repository: PostgresControlRepository) => {
    ipCounter += 1;
    const bridge = await repository.createBridge(admin, {
      name: `Image ${runTag} ${ipCounter}`,
      publicIpv4: `46.${parseInt(runTag, 16) & 0xff}.${ipCounter}.9`,
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    bridgeIds.push(bridge.id);
    return bridge;
  };

  const release = async (repository: string, digestValue: string) => {
    await database?.db
      .insert(bridgeAgentReleases)
      .values({ repository, version: "0.2.0", digest: digestValue, resolvedAt: new Date() })
      .onConflictDoUpdate({ target: bridgeAgentReleases.repository, set: { digest: digestValue } });
  };

  beforeAll(async () => {
    if (!database) return;
    const [user] = await database.db
      .insert(users)
      .values({ email: `bridge-image-${runTag}@example.com`, role: "admin" })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    userIds.push(user.id);
    admin = { id: user.id, email: user.email, displayName: null, role: "admin", status: "active" };
  });

  afterEach(async () => {
    if (!database) return;
    if (bridgeIds.length > 0) await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, bridgeIds));
    bridgeIds.length = 0;
    await database.db.delete(bridgeAgentReleases).where(inArray(bridgeAgentReleases.repository, [APPROVED, OTHER]));
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, userIds));
    await database.db.delete(users).where(inArray(users.id, userIds));
    await database.client.end();
  });

  runDatabaseTest("the generated command carries the resolved digest of the approved repository", async () => {
    await release(APPROVED, digest("a"));
    const repository = repositoryFor(APPROVED);
    const bridge = await addBridge(repository);
    const image = `${APPROVED}@${digest("a")}`;
    expect(bridge.setupCommands?.agentImage).toBe(image);
    expect(bridge.setupCommands?.install).toMatch(new RegExp(`--udp-end 41031 --agent-image ${image}$`));
    expect(bridge.setupCommands?.dryRun).toBe(`${bridge.setupCommands?.install} --dry-run`);
    const listed = (await repository.listBridges(admin)).find((item) => item.id === bridge.id);
    expect(listed?.setupCommands).toEqual(bridge.setupCommands);
  });

  runDatabaseTest("a newer resolved digest replaces the old one on the next read", async () => {
    await release(APPROVED, digest("a"));
    const repository = repositoryFor(APPROVED);
    await addBridge(repository);
    await release(APPROVED, digest("b"));
    const [bridge] = await repository.listBridges(admin);
    expect(bridge?.setupCommands?.agentImage).toBe(`${APPROVED}@${digest("b")}`);
  });

  runDatabaseTest("says none is available when unconfigured, unresolved, or resolved for another repository", async () => {
    await release(OTHER, digest("c"));
    // Repository not configured: no image, even though rows exist.
    const unconfigured = await addBridge(repositoryFor(undefined));
    expect(unconfigured.setupCommands?.agentImage).toBeNull();
    expect(unconfigured.setupCommands?.install).not.toContain("--agent-image");
    // Configured but nothing resolved for it (the node-agent-style row of another repository is ignored).
    const unresolved = await repositoryFor(APPROVED).listBridges(admin);
    expect(unresolved.every((item) => item.setupCommands?.agentImage === null)).toBe(true);
    // A node-agent release never leaks into a bridge command.
    const nodeRows = await database?.db.select().from(nodeAgentReleases);
    expect(nodeRows?.some((row) => row.repository === OTHER)).toBe(false);
  });

  runDatabaseTest("refuses a stored reference that is not a digest", async () => {
    await release(APPROVED, "latest");
    const bridge = await addBridge(repositoryFor(APPROVED));
    expect(bridge.setupCommands?.agentImage).toBeNull();
  });
});
