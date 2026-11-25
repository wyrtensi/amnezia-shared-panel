import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asValue } from "awilix";
import { fetch as undiciFetch } from "undici";

import { di } from "@/config/DIContainer";
import { EgressService } from "@/services/egress";
import { AppFastifyInstance } from "@/types/shared";
import { TEST_API_KEY } from "../config/setupTestEnvironment";
import { closeTestApp, createClientsTestApp } from "../helpers";

// The probe calls undici's own `fetch` so its guarded dispatcher applies; the
// global one is no longer on that path.
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(),
}));

const fetchMock = vi.mocked(undiciFetch);

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
  }) as unknown as Awaited<ReturnType<typeof undiciFetch>>;

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
    fetchMock.mockImplementation(async () =>
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
    fetchMock.mockImplementation(async () =>
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
    const fetchStub = fetchMock
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

  it("returns status=error when probe.egressIpv4 is requested without EgressService", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload: {
        checks: [
          check({
            probe: {
              kind: "http",
              url: "https://1.1.1.1/",
              method: "GET",
              egressIpv4: "203.0.113.20",
            },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      status: "error",
      detail: expect.stringContaining("amnezia-egressd"),
    });
  });

  it("routes egressIpv4 HTTP probes via EgressService and enforces SSRF hop guards", async () => {
    const runHttpCheck = vi.fn(async () => ({
      status: 200,
      finalUrl: "https://1.1.1.1/",
      body: "<html>conversation-container</html>",
      headers: { "content-type": "text/html" },
      latencyMs: 18,
    }));
    di.container.register({
      [EgressService.key]: asValue({ runHttpCheck }),
    });

    const okRes = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload: {
        egressIpv4: "203.0.113.20",
        checks: [
          check({
            probe: {
              kind: "http",
              url: "https://1.1.1.1/",
              method: "GET",
            },
            assertions: [
              { type: "statusIn", statuses: [200] },
              { type: "bodyContains", value: "conversation-container" },
            ],
          }),
        ],
      },
    });

    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().results[0]).toMatchObject({
      status: "ok",
      httpStatus: 200,
    });
    expect(runHttpCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        egressIpv4: "203.0.113.20",
        url: "https://1.1.1.1/",
        followRedirects: false,
      }),
    );

    const ssrfRes = await app.inject({
      method: "POST",
      url: "/checks/run",
      headers: AUTH_HEADERS,
      payload: {
        checks: [
          check({
            probe: {
              kind: "http",
              url: "http://127.0.0.1/",
              method: "GET",
              egressIpv4: "203.0.113.20",
            },
          }),
        ],
      },
    });

    expect(ssrfRes.statusCode).toBe(200);
    expect(ssrfRes.json().results[0]).toMatchObject({
      status: "error",
      detail: expect.stringContaining("refused:"),
    });
    expect(runHttpCheck).toHaveBeenCalledTimes(1);
  });
});
