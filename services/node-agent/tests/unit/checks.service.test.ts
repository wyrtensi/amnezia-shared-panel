import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookupAddress, LookupOptions } from "node:dns";
import { fetch as undiciFetch } from "undici";

import { runCheck, runChecks } from "@/services/checks/checks.service";
import {
  assertPublicAddress,
  createGuardedLookup,
  MAX_BODY_BYTES,
  ProbeRefusedError,
  SUPPORTED_PROBE_KINDS,
} from "@/services/checks/probes";

// The probe uses undici's own `fetch`, not the global one: a dispatcher only
// works with the client it came from, and the guarded resolver lives on that
// dispatcher. `Agent` stays real - the module builds one at import time.
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(),
}));

type StubbedResponse = Awaited<ReturnType<typeof undiciFetch>>;

const fetchMock = vi.mocked(undiciFetch);

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
    }) as unknown as StubbedResponse;
  return fetchMock.mockImplementation(async () => {
    if (before) await before();
    return makeStub();
  });
};

/**
 * A fetch stub that answers per URL, so a redirect chain can be described as
 * the map it is. Returns the list of URLs actually requested - what the probe
 * refused to fetch is as much the point as what it fetched.
 */
const stubRoutedFetch = (
  route: (url: string) => { status: number; location?: string; body?: string },
) => {
  const requested: string[] = [];
  fetchMock.mockImplementation(async (input) => {
    const url = input instanceof URL ? input.toString() : String(input);
    requested.push(url);
    const answer = route(url);
    const bodyText = answer.body ?? "";
    return {
      status: answer.status,
      url,
      headers: new Headers(answer.location ? { location: answer.location } : {}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          if (bodyText) controller.enqueue(new TextEncoder().encode(bodyText));
          controller.close();
        },
      }),
    } as unknown as StubbedResponse;
  });
  return requested;
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
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
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

describe("redirects", () => {
  it("refuses a redirect that lands on an internal address", async () => {
    // The guard used to run once, on the URL the admin typed. The redirect is
    // chosen by the far end, so a monitored site - or anything that has taken
    // it over - could point the node at its own metadata service.
    const requested = stubRoutedFetch((url) =>
      url === "https://example.com/"
        ? { status: 302, location: "http://169.254.169.254/latest/meta-data/" }
        : { status: 200, body: "internal" },
    );
    const result = await runCheck(httpCheck());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/refused/);
    expect(requested).toEqual(["https://example.com/"]);
  });

  it("follows a chain of public redirects and reports where it landed", async () => {
    const requested = stubRoutedFetch((url) => {
      if (url === "https://example.com/")
        return { status: 302, location: "/step2" };
      if (url === "https://example.com/step2")
        return { status: 301, location: "https://example.com/final" };
      return { status: 200, body: "arrived" };
    });
    const result = await runCheck(httpCheck());
    expect(result.status).toBe("ok");
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(requested).toHaveLength(3);
  });

  it("gives up rather than following a redirect loop", async () => {
    let hop = 0;
    const requested = stubRoutedFetch(() => ({
      status: 302,
      location: `https://example.com/hop${(hop += 1)}`,
    }));
    const result = await runCheck(httpCheck());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/too many redirects/);
    expect(requested.length).toBeLessThanOrEqual(11);
  });
});

describe("createGuardedLookup", () => {
  // The guard resolves the name and `fetch` resolves it again, independently.
  // Checking the first answer says nothing about the address the socket is
  // actually dialled on, so the check has to live at the connect itself.
  type Answer = string | LookupAddress[];
  type Callback = (
    error: NodeJS.ErrnoException | null,
    address: Answer,
    family?: number,
  ) => void;

  const resolveWith =
    (answer: Answer, family = 4) =>
    (_host: string, _options: LookupOptions, callback: Callback) =>
      callback(null, answer, family);

  const call = (
    lookup: ReturnType<typeof createGuardedLookup>,
    options: LookupOptions,
  ) =>
    new Promise<unknown>((resolve) => {
      lookup("service.example", options, (error) => resolve(error));
    });

  it("refuses an internal address returned as a single answer", async () => {
    const lookup = createGuardedLookup(resolveWith("127.0.0.1"));
    await expect(call(lookup, { all: false })).resolves.toBeInstanceOf(
      ProbeRefusedError,
    );
  });

  it("refuses an internal address hidden among public ones", async () => {
    const lookup = createGuardedLookup(
      resolveWith([
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:169.254.169.254", family: 6 },
      ]),
    );
    await expect(call(lookup, { all: true })).resolves.toBeInstanceOf(
      ProbeRefusedError,
    );
  });

  it("passes a public answer through untouched", async () => {
    const lookup = createGuardedLookup(
      resolveWith([{ address: "93.184.216.34", family: 4 }]),
    );
    await expect(call(lookup, { all: true })).resolves.toBeNull();
  });

  it("hands a resolver failure back unchanged", async () => {
    const failure = new Error("ENOTFOUND");
    const lookup = createGuardedLookup((_host, _options, callback) => {
      callback(failure, "");
    });
    await expect(call(lookup, { all: true })).resolves.toBe(failure);
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

  it("refuses an IPv4-mapped answer that wraps an internal address", async () => {
    // ipaddr.js matches ::ffff:0:0/96 as `ipv4Mapped` BEFORE it looks at the
    // embedded IPv4, so a deny-list of IPv4 range names never sees the address
    // it is meant to refuse. The wrapper has to come off first.
    for (const address of [
      "::ffff:169.254.169.254",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.5",
    ]) {
      await expect(
        assertPublicAddress("service.example", async () => [address]),
        address,
      ).rejects.toThrow(ProbeRefusedError);
    }
  });

  it("refuses a NAT64 answer that wraps an internal address", async () => {
    // 64:ff9b::7f00:1 is 127.0.0.1 behind the well-known NAT64 prefix.
    await expect(
      assertPublicAddress("service.example", async () => ["64:ff9b::7f00:1"]),
    ).rejects.toThrow(ProbeRefusedError);
  });

  it("accepts a NAT64 answer that wraps a public address", async () => {
    // A node on an IPv6-only network behind NAT64 gets these for ordinary
    // public sites. Refusing the whole range would break every check there,
    // so the prefix is unwrapped rather than denied.
    await expect(
      assertPublicAddress("example.com", async () => ["64:ff9b::5db8:d822"]),
    ).resolves.toBeUndefined();
  });

  it("refuses a range nobody put on a list", async () => {
    // 6to4 and Teredo also carry an embedded IPv4 and were absent from the
    // deny-list for the same reason ipv4Mapped was. Enumerating bad ranges is
    // what failed here; anything that is not plain unicast has to fail closed.
    for (const address of [
      "2002:7f00:1::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    ]) {
      await expect(
        assertPublicAddress("service.example", async () => [address]),
        address,
      ).rejects.toThrow(ProbeRefusedError);
    }
  });
});
