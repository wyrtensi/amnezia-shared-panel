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
});
