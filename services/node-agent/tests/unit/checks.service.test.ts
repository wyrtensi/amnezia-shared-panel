import { afterEach, describe, expect, it, vi } from "vitest";

import { runCheck, runChecks } from "@/services/checks/checks.service";
import {
  assertPublicAddress,
  MAX_BODY_BYTES,
  ProbeRefusedError,
  SUPPORTED_PROBE_KINDS,
} from "@/services/checks/probes";

const httpCheck = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  probe: { kind: "http", url: "https://example.com/", method: "GET" },
  assertions: [{ type: "statusIn", statuses: [200] }],
  ...overrides,
});

// A fresh Response per call: a body stream can be read exactly once, so a
// single shared stub answers the first check and then hangs the rest.
const stubFetch = (
  response: Partial<Response> & { bodyText?: string },
  before?: () => Promise<void>,
) => {
  const bodyText = response.bodyText ?? "";
  const makeStub = () =>
    ({
      status: response.status ?? 200,
      url: response.url ?? "https://example.com/",
      headers: new Headers(response.headers ?? {}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          if (bodyText) controller.enqueue(new TextEncoder().encode(bodyText));
          controller.close();
        },
      }),
    }) as unknown as Response;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (before) await before();
    return makeStub();
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCheck", () => {
  it("reports ok when the probe runs and every assertion holds", async () => {
    stubFetch({ status: 200, bodyText: "<html>conversation-container</html>" });
    const result = await runCheck(
      httpCheck({
        assertions: [
          { type: "statusIn", statuses: [200] },
          { type: "bodyContains", value: "conversation-container" },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      httpStatus: 200,
      detail: null,
      finalUrl: "https://example.com/",
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports failed, with the first failing assertion as the detail", async () => {
    stubFetch({ status: 200, bodyText: "<html>account-rejected</html>" });
    const result = await runCheck(
      httpCheck({
        assertions: [
          { type: "statusIn", statuses: [200] },
          { type: "bodyOmits", value: "account-rejected" },
        ],
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toMatch(/body contains "account-rejected"/);
  });

  it("reports ERROR, never failed, for an assertion type it cannot run", async () => {
    // The single most important distinction in this file. `failed` collapses
    // to "unavailable" for a user; `error` collapses to "unknown". An agent
    // that is simply older than the rule knows nothing about the service, and
    // saying "blocked" there is worse than saying nothing.
    stubFetch({ status: 200, bodyText: "<html></html>" });
    const result = await runCheck(
      httpCheck({ assertions: [{ type: "bodyMatchesRegex", pattern: "x" }] }),
    );
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/unsupported assertion type: bodyMatchesRegex/);
    expect(result.detail).toMatch(/cannot run this check/);
  });

  it("reports error for a probe kind it does not implement", async () => {
    const result = await runCheck(
      httpCheck({ probe: { kind: "dns", host: "example.com" } }),
    );
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/unsupported probe kind: dns/);
  });

  it("reports error when the fetch itself fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );
    const result = await runCheck(httpCheck());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/TypeError: fetch failed/);
    expect(result.httpStatus).toBeNull();
  });

  it("reads no body for a HEAD probe", async () => {
    const fetchStub = stubFetch({ status: 200, bodyText: "ignored" });
    const result = await runCheck(
      httpCheck({
        probe: { kind: "http", url: "https://example.com/", method: "HEAD" },
        assertions: [{ type: "statusIn", statuses: [200] }],
      }),
    );
    expect(result.status).toBe("ok");
    expect(fetchStub.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });
  });

  it("stops reading at the body cap", async () => {
    // A page a node fetches twice a day can be megabytes; the cap is what keeps
    // that off a 1 vCPU host's heap.
    const huge = "x".repeat(MAX_BODY_BYTES + 10_000);
    stubFetch({ status: 200, bodyText: huge });
    const result = await runCheck(
      httpCheck({
        assertions: [{ type: "bodyBytesAtLeast", count: MAX_BODY_BYTES }],
      }),
    );
    expect(result.status).toBe("ok");

    stubFetch({ status: 200, bodyText: huge });
    const beyond = await runCheck(
      httpCheck({
        assertions: [{ type: "bodyBytesAtLeast", count: MAX_BODY_BYTES + 1 }],
      }),
    );
    expect(beyond.status).toBe("failed");
  });
});

describe("runChecks", () => {
  it("keeps input order and bounds how many run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    stubFetch({ status: 200, bodyText: "ok" }, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield the macrotask so every lane that is allowed to start does start
      // before any of them finishes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
    });

    const checks = Array.from({ length: 7 }, (_unused, index) =>
      httpCheck({ id: `check-${index}` }),
    );
    const results = await runChecks(checks, 3);

    expect(results.map((result) => result.id)).toEqual(
      checks.map((check) => check.id),
    );
    // The invariant is the BOUND, not the exact peak. Requiring exactly 3
    // tests the scheduler: on a loaded runner one lane can finish before the
    // third starts, and the assertion failed on CI for a reason that had
    // nothing to do with this code. The pair below still catches both
    // regressions that matter - removing the bound gives 7, and collapsing it
    // to serial gives 1.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("assertPublicAddress", () => {
  it("advertises only the probe kinds it implements", () => {
    expect(SUPPORTED_PROBE_KINDS).toEqual(["http"]);
  });

  it("refuses a host that resolves inside the node's own network", async () => {
    // A check URL is an admin string this process fetches from the node's
    // network namespace - the docker socket, the AWG containers and the host's
    // metadata service all sit behind addresses the panel cannot reach. The
    // contract refuses these by NAME; only this refuses them by address.
    for (const address of [
      "127.0.0.1",
      "10.90.0.1",
      "192.168.1.5",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ]) {
      await expect(
        assertPublicAddress("service.example", async () => [address]),
        address,
      ).rejects.toThrow(ProbeRefusedError);
    }
  });

  it("refuses a public name that resolves to a private address", async () => {
    // DNS rebinding: the name is public, the answer is not. EVERY answer has to
    // pass, not just the first one.
    await expect(
      assertPublicAddress("evil.example.com", async () => [
        "93.184.216.34",
        "127.0.0.1",
      ]),
    ).rejects.toThrow(/loopback/);
  });

  it("refuses a documentation or otherwise reserved range", async () => {
    // 203.0.113.0/24 is TEST-NET-3. It is the placeholder this repo uses in
    // examples, it is not routable, and a check pointed at it would otherwise
    // spend its whole timeout finding that out.
    await expect(
      assertPublicAddress("example.test", async () => ["203.0.113.10"]),
    ).rejects.toThrow(/reserved/);
  });

  it("refuses a name that does not resolve at all", async () => {
    await expect(
      assertPublicAddress("nowhere.example", async () => []),
    ).rejects.toThrow(/does not resolve/);
  });

  it("accepts a public address", async () => {
    await expect(
      assertPublicAddress("example.com", async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
  });

  it("checks an IP literal without asking the resolver", async () => {
    const resolve = vi.fn(async () => ["203.0.113.10"]);
    await expect(assertPublicAddress("127.0.0.1", resolve)).rejects.toThrow(
      /loopback/,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
