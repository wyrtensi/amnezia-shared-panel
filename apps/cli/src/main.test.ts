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
      {
        body: {
          status: "pending",
          queuedAt: "2026-09-05T10:00:00.000Z",
          completedAt: null,
          lastError: null,
        },
      },
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

  it("cf-sync refuses when an id was cleared to an empty string, matching the worker's own check", async () => {
    // The worker's getCloudflareConfig treats "" as unconfigured (a falsy
    // check); cfAccessConfigured used to accept it (`typeof === "string"`),
    // so a cleared id would let cf-sync queue a run the worker then fails.
    const calls = stubFetch([
      {
        body: [
          {
            cfAccessAccountId: "",
            cfAccessAppId: "app",
            cfAccessPolicyId: "pol",
            cfApiTokenSet: true,
          },
        ],
      },
    ]);
    await expect(run(["cf-sync"])).rejects.toThrow(/cf-config/);
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

describe("cf-domains", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("lists the current domains", async () => {
    stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld", "other.tld"] }] },
    ]);
    const out = await run(["cf-domains"]);
    expect(out).toMatch(/company\.tld/);
    expect(out).toMatch(/other\.tld/);
  });

  it("lists plainly when the policy row has no domains yet", async () => {
    stubFetch([{ body: [{}] }]);
    const out = await run(["cf-domains"]);
    expect(out).toMatch(/\(none\)/);
  });

  it("--add posts the union and not the whole row", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--add=other.tld"]);
    expect(calls[1]?.url).toMatch(/\/api\/admin\/portal-policy\/global\/update$/);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      cfAccessAllowedDomains: ["company.tld", "other.tld"],
    });
    expect(out).toMatch(/company\.tld, other\.tld/);
  });

  it("--add normalizes case and a leading @ before comparing, and skips posting when already present", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--add=@Company.TLD"]);
    expect(calls).toHaveLength(1); // read only — no update posted
    expect(out).toMatch(/already in the list/);
  });

  it("--remove of a domain in the list posts the shortened list", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld", "other.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--remove=other.tld"]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      cfAccessAllowedDomains: ["company.tld"],
    });
    expect(out).toMatch(/now company\.tld/);
  });

  it("--remove of an absent domain says so plainly, without posting an unchanged list", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld"] }] },
    ]);
    const out = await run(["cf-domains", "--remove=missing.tld"]);
    expect(calls).toHaveLength(1); // read only — no update posted
    expect(out).toMatch(/not in the list/);
  });

  it("--set replaces the list wholesale", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["old.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--set=a.tld,B.TLD"]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      cfAccessAllowedDomains: ["a.tld", "b.tld"],
    });
    expect(out).toMatch(/now a\.tld, b\.tld/);
  });

  it("refuses to combine --add and --remove in one call, without reading the policy at all", async () => {
    const calls = stubFetch([{ body: [{ cfAccessAllowedDomains: [] }] }]);
    await expect(
      run(["cf-domains", "--add=a.tld", "--remove=b.tld"]),
    ).rejects.toThrow(/one at a time/);
    expect(calls).toHaveLength(0);
  });

  it("an invalid domain surfaces the API's own message instead of a generic failure", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: [] }] },
      {
        status: 400,
        body: {
          error: "VALIDATION_ERROR",
          issues: [
            { message: "not a domain name", path: ["cfAccessAllowedDomains", 0] },
          ],
        },
      },
    ]);
    await expect(run(["cf-domains", "--add=not-a-domain"])).rejects.toThrow(
      /not a domain name/,
    );
    expect(calls).toHaveLength(2);
  });
});
