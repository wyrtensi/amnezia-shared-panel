import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./main.js";

/**
 * Stub `fetch` for one `dispatch()` call, returning each response in order
 * (the last one repeats if more calls happen than responses given) and the
 * list of calls made, so a test can assert on the URL/method/body a command
 * sent as well as on what it printed.
 */
function stubFetch(
  responses: Array<{ status?: number; body: unknown }>,
): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL, init?: RequestInit) => {
      const index = calls.length;
      calls.push({ url: String(url), init });
      const response = responses[Math.min(index, responses.length - 1)];
      const status = response?.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        text: () => Promise.resolve(JSON.stringify(response?.body ?? null)),
      } as unknown as Response);
    }),
  );
  return calls;
}

/** Run one command through the real dispatcher and return everything it logged. */
async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    });
  try {
    await dispatch(argv);
  } finally {
    logSpy.mockRestore();
  }
  return lines.join("\n");
}

describe("cf-sync", () => {
  beforeEach(() => {
    // dispatch() -> api() -> authHeaders() needs some credential source; the
    // dev header is the simplest one that requires no signing.
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("cf-sync queues a reconcile when Cloudflare is configured", async () => {
    // portal-policy read reports a configured panel, then the action POST.
    // portal-policy is a one-row list everywhere else this CLI reads it.
    const calls = stubFetch([
      {
        body: [
          {
            cfAccessAccountId: "acc",
            cfAccessAppId: "app",
            cfAccessPolicyId: "pol",
            cfApiTokenSet: true,
          },
        ],
      },
      { body: { queued: true, alreadyRunning: false } },
    ]);
    const out = await run(["cf-sync"]);
    expect(calls[1]?.url).toMatch(/\/api\/admin\/access-sync\/global\/run$/);
    expect(out).toMatch(/queued/i);
  });

  it("cf-sync refuses, without posting, when Cloudflare is not configured", async () => {
    const calls = stubFetch([
      {
        body: [
          {
            cfAccessAccountId: null,
            cfAccessAppId: null,
            cfAccessPolicyId: null,
            cfApiTokenSet: false,
          },
        ],
      },
    ]);
    await expect(run(["cf-sync"])).rejects.toThrow(/cf-config/);
    expect(calls).toHaveLength(1); // the run action was never posted
  });

  it("cf-sync refuses when the ids are set but no API token has been stored", async () => {
    // Any one of the four fields missing is enough to refuse, not just a
    // wholesale-unconfigured panel.
    const calls = stubFetch([
      {
        body: [
          {
            cfAccessAccountId: "acc",
            cfAccessAppId: "app",
            cfAccessPolicyId: "pol",
            cfApiTokenSet: false,
          },
        ],
      },
    ]);
    await expect(run(["cf-sync"])).rejects.toThrow(/cf-token/);
    expect(calls).toHaveLength(1);
  });

  it("cf-sync reports a coalesce when a run is already mid-flight", async () => {
    // The real run response is the outbox row's own status; "processing"
    // means the worker's poller already has it locked.
    const calls = stubFetch([
      {
        body: [
          {
            cfAccessAccountId: "acc",
            cfAccessAppId: "app",
            cfAccessPolicyId: "pol",
            cfApiTokenSet: true,
          },
        ],
      },
      {
        body: {
          status: "processing",
          queuedAt: "2026-09-05T10:00:00.000Z",
          completedAt: null,
          lastError: null,
        },
      },
    ]);
    const out = await run(["cf-sync"]);
    expect(calls).toHaveLength(2);
    expect(out).toMatch(/already on its way/i);
  });

  it("cf-sync --status prints the last run in one line", async () => {
    stubFetch([
      {
        body: {
          status: "failed",
          queuedAt: "2026-09-05T10:00:00.000Z",
          completedAt: null,
          lastError: "aborted: 12 account(s) would be disabled",
        },
      },
    ]);
    const out = await run(["cf-sync", "--status"]);
    expect(out).toMatch(/failed/);
    expect(out).toMatch(/12 account\(s\)/);
  });

  it("cf-sync --status --json prints the raw status object", async () => {
    const body = {
      status: "idle",
      queuedAt: null,
      completedAt: null,
      lastError: null,
    };
    stubFetch([{ body }]);
    const out = await run(["cf-sync", "--status", "--json"]);
    expect(JSON.parse(out)).toEqual(body);
  });
});
