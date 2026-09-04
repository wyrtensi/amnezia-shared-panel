import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppFastifyInstance } from "@/types/shared";
import { TEST_API_KEY } from "../config/setupTestEnvironment";
import { closeTestApp, createClientsTestApp } from "../helpers";

const AUTH_HEADERS = { "x-api-key": TEST_API_KEY } as const;

const httpResponse = (status: number, bodyText: string, url: string) =>
  ({
    status,
    url,
    headers: new Headers({ "content-type": "text/html" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyText));
        controller.close();
      },
    }),
  }) as unknown as Response;

const check = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  probe: { kind: "http", url: "https://example.com/", method: "GET" },
  assertions: [{ type: "statusIn", statuses: [200] }],
  ...overrides,
});

describe("checks routes", () => {
  let app: AppFastifyInstance;

  beforeAll(async () => {
    app = await createClientsTestApp({
      getClients: vi.fn(async () => []),
      updateClient: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it("requires the API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/checks/run",
      payload: { checks: [check()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("runs a check and returns its verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      httpResponse(200, "<html>conversation-container</html>", "https://example.com/"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload: {
        checks: [
          check({
            assertions: [
              { type: "statusIn", statuses: [200] },
              { type: "bodyContains", value: "conversation-container" },
            ],
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "ok",
      httpStatus: 200,
      detail: null,
    });
  });

  it("accepts an assertion type the JSON schema has never heard of", async () => {
    // The route must not be the thing that decides which rules exist. If it
    // validated the assertion shape, every new rule would need an agent update
    // before the panel could even send it - and the registry's `error` would
    // never be reached, so a mixed fleet would look like a 400 instead of an
    // "this node cannot run that check".
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      httpResponse(200, "<html></html>", "https://example.com/"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload: {
        checks: [
          check({ assertions: [{ type: "somethingNewer", value: "x" }] }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      status: "error",
      detail: expect.stringContaining("unsupported assertion type: somethingNewer"),
    });
  });

  it("refuses a body with no checks or too many", async () => {
    for (const checks of [[], Array.from({ length: 21 }, () => check())]) {
      const response = await app.inject({
        method: "POST",
        url: "/checks/run",
        headers: AUTH_HEADERS,
        payload: { checks },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("stores nothing: two identical calls are independent", async () => {
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () =>
        httpResponse(200, "<html>a</html>", "https://example.com/"),
      )
      .mockImplementationOnce(async () =>
        httpResponse(503, "<html>a</html>", "https://example.com/"),
      );

    const payload = { checks: [check()] };
    const first = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload,
    });

    expect(first.json().results[0].status).toBe("ok");
    expect(second.json().results[0].status).toBe("failed");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
