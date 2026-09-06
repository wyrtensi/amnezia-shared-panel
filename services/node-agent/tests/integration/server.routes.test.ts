import { afterEach, describe, expect, it, vi } from "vitest";

import { Protocol } from "@/types/shared";
import { AppFastifyInstance } from "@/types/shared";
import { ServerBackupPayload } from "@/types/server";
import { createAmneziaBackupFixture } from "../fixtures";
import { TEST_API_KEY } from "../config/setupTestEnvironment";
import { closeTestApp, createServerTestApp } from "../helpers";

const AUTH_HEADERS = { "x-api-key": TEST_API_KEY } as const;

let app: AppFastifyInstance | undefined;

afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

describe("server backup routes", () => {
  // The service builds amneziaWg3 correctly and the unit tests prove it. This
  // test exists one layer out, because Fastify serializes by the response
  // schema and silently drops any field the schema does not declare — which
  // is how an empty backup shipped with a 200.
  it("returns the AmneziaWG 3.1 payload to the client", async () => {
    const backup: ServerBackupPayload = {
      generatedAt: "2026-09-07T00:00:00.000Z",
      serverId: "test-server-id",
      protocols: [Protocol.AMNEZIAWG3],
      amneziaWg3: createAmneziaBackupFixture(),
    };
    app = await createServerTestApp({
      exportBackup: vi.fn(async () => backup),
    });

    const response = await app.inject({
      method: "GET",
      url: "/server/backup",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().amneziaWg3).toEqual(createAmneziaBackupFixture());
  });

  // The import half of the same gap. An unknown property is not validated, so
  // a half-built payload reached the service and was written to the node's own
  // config. The schema must refuse it before the service ever sees it.
  it("refuses an AmneziaWG 3.1 payload missing its config", async () => {
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      importBackup,
      getServerStatus: vi.fn(async () => ({}) as never),
    });

    const response = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: {
        generatedAt: "2026-09-07T00:00:00.000Z",
        serverId: "test-server-id",
        protocols: [Protocol.AMNEZIAWG3],
        amneziaWg3: { presharedKey: "psk", serverPublicKey: "pub", clients: [] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(importBackup).not.toHaveBeenCalled();
  });

  it("accepts a complete AmneziaWG 3.1 payload", async () => {
    const backup: ServerBackupPayload = {
      generatedAt: "2026-09-07T00:00:00.000Z",
      serverId: "test-server-id",
      protocols: [Protocol.AMNEZIAWG3],
      amneziaWg3: createAmneziaBackupFixture(),
    };
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      exportBackup: vi.fn(async () => backup),
      importBackup,
      // The handler replies with getServerStatus()'s result, and that reply is
      // serialized against getServerSchema's response schema, which requires
      // these fields. Unrelated to the payload under test, but needed so the
      // route reaches 200 instead of failing serialization.
      getServerStatus: vi.fn(
        async () =>
          ({
            id: "test-server-id",
            region: "test-region",
            weight: 100,
            maxPeers: 10,
            totalPeers: 0,
            protocols: [Protocol.AMNEZIAWG3],
            publicHost: "test-public-host",
          }) as never,
      ),
    });

    const exportResponse = await app.inject({
      method: "GET",
      url: "/server/backup",
      headers: AUTH_HEADERS,
    });
    expect(exportResponse.statusCode).toBe(200);

    // The export and import schemas are two separately hand-written blocks
    // with no shared constant. Feeding the export route's own serialized JSON
    // back in as the import body — rather than building it straight from
    // createAmneziaBackupFixture() — is what would catch either schema
    // declaring a field the other one doesn't. Do not "simplify" this back to
    // posting the fixture directly: that would silently reopen the exact gap
    // this branch fixes.
    const importResponse = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: exportResponse.json(),
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importBackup).toHaveBeenCalledWith(
      expect.objectContaining({ amneziaWg3: createAmneziaBackupFixture() }),
    );
  });

  it("refuses an AmneziaWG 3.1 payload with an empty config", async () => {
    const importBackup = vi.fn(async () => undefined);
    app = await createServerTestApp({
      importBackup,
      getServerStatus: vi.fn(async () => ({}) as never),
    });

    const response = await app.inject({
      method: "POST",
      url: "/server/backup",
      headers: AUTH_HEADERS,
      payload: {
        generatedAt: "2026-09-07T00:00:00.000Z",
        serverId: "test-server-id",
        protocols: [Protocol.AMNEZIAWG3],
        amneziaWg3: {
          wgConfig: "",
          presharedKey: "psk",
          serverPublicKey: "pub",
          clients: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(importBackup).not.toHaveBeenCalled();
  });
});
