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

  it("refuses a bare --set= without reading the policy, so an unset shell variable cannot wipe the list", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["a.tld"] }] },
    ]);
    await expect(run(["cf-domains", "--set="])).rejects.toThrow(
      /--set=none/,
    );
    expect(calls).toHaveLength(0);
  });

  it("--set=none clears the list explicitly, printing what is removed before posting", async () => {
    const calls = stubFetch([
      { body: [{ cfAccessAllowedDomains: ["a.tld", "b.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--set=none"]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      cfAccessAllowedDomains: [],
    });
    expect(out).toMatch(/clearing a\.tld, b\.tld/);
    expect(out).toMatch(/now \(none\)/);
  });

  it("--set=none on an already-empty list says so, without posting", async () => {
    const calls = stubFetch([{ body: [{ cfAccessAllowedDomains: [] }] }]);
    const out = await run(["cf-domains", "--set=none"]);
    expect(calls).toHaveLength(1); // read only — no update posted
    expect(out).toMatch(/already empty/);
  });

  it("refuses to combine --add and --remove in one call, without reading the policy at all", async () => {
    const calls = stubFetch([{ body: [{ cfAccessAllowedDomains: [] }] }]);
    await expect(
      run(["cf-domains", "--add=a.tld", "--remove=b.tld"]),
    ).rejects.toThrow(/one at a time/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to combine --set and --add in one call, without reading the policy at all", async () => {
    const calls = stubFetch([{ body: [{ cfAccessAllowedDomains: [] }] }]);
    await expect(
      run(["cf-domains", "--set=a.tld,b.tld", "--add=c.tld"]),
    ).rejects.toThrow(/one at a time/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to combine --set and --remove in one call, without reading the policy at all", async () => {
    const calls = stubFetch([{ body: [{ cfAccessAllowedDomains: [] }] }]);
    await expect(
      run(["cf-domains", "--set=a.tld,b.tld", "--remove=c.tld"]),
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

describe("periods", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("shows what is set, what an unset period falls back to, and the caveats", async () => {
    stubFetch([
      { body: [{ telemetryPollSec: 120, ruleFetchIntervalSec: null }] },
    ]);
    const output = await run(["periods"]);
    expect(output).toContain("telemetryPollSec");
    expect(output).toContain("120 s (2 min)");
    // An unset period reads as a dash with the default beside it, never as 0.
    expect(output).toMatch(/ruleFetchIntervalSec\s+—\s+21600 s \(6 h\)/);
    expect(output).toContain("900..604800");
    // The two things an operator has to know before changing one: the default
    // may come from the worker's environment, and the change is not instant.
    expect(output).toContain("TELEMETRY_POLL_SEC");
    expect(output).toContain("up to one OLD period away");
  });

  it("--json carries the bounds as well as the stored value", async () => {
    stubFetch([{ body: [{ telemetryPollSec: 300 }] }]);
    const output = await run(["periods", "--json"]);
    expect(JSON.parse(output)).toMatchObject({
      telemetryPollSec: { set: 300, default: 60, min: 30, max: 86_400 },
      peerSampleSec: { set: null, default: 300, min: 60, unit: "sec" },
      nodeMetricsRetentionDays: { set: null, default: 7, unit: "day" },
    });
  });

  it("policy-set posts a period, and posts null to clear one", async () => {
    let calls = stubFetch([{ body: {} }]);
    await run(["policy-set", "--telemetryPollSec=120"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/admin/portal-policy/global/update");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      telemetryPollSec: 120,
    });

    vi.unstubAllGlobals();
    calls = stubFetch([{ body: {} }]);
    await run(["policy-set", "--ruleFetchIntervalSec=default"]);
    // Null, not an omitted field: the API tells them apart, and only null
    // hands the period back to the worker.
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      ruleFetchIntervalSec: null,
    });
  });

  it("refuses an out-of-range period before it reaches the API", async () => {
    const calls = stubFetch([{ body: {} }]);
    await expect(
      run(["policy-set", "--telemetryPollSec=1"]),
    ).rejects.toThrow(/outside 30\.\.86400/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The stale-key surfaces. `now` is not injectable here, so the fixtures are
 * expressed as offsets from the moment the test runs rather than fixed dates;
 * the rule itself is pinned exactly in staleKeys.test.ts.
 */
describe("stale keys", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  // Real UUIDs so resolveUserId short-circuits without a users lookup, the
  // way an operator pasting an id out of `stale-keys` gets.
  const U_LIVE = "11111111-1111-4111-8111-111111111111";
  const U_MIXED = "22222222-2222-4222-8222-222222222222";
  const U_DEAD = "33333333-3333-4333-8333-333333333333";
  const users = [
    { id: U_LIVE, email: "live@example.com", status: "active" },
    { id: U_MIXED, email: "mixed@example.com", status: "active" },
    { id: U_DEAD, email: "dead@example.com", status: "active" },
  ];
  const key = (over: Record<string, unknown>) => ({
    nodeId: "n1",
    protocol: "awg3",
    routeProfile: "full_tunnel",
    state: "active",
    ...over,
  });
  const keys = [
    // Fully active user.
    key({
      id: "k1",
      ownerId: U_LIVE,
      deviceLabel: "Work phone",
      lastUsedAt: ago(1),
      createdAt: ago(200),
    }),
    // Mixed: one live key, one abandoned, one issued this week.
    key({
      id: "k2",
      ownerId: U_MIXED,
      deviceLabel: "Home phone",
      lastUsedAt: ago(2),
      createdAt: ago(200),
    }),
    key({
      id: "k3",
      ownerId: U_MIXED,
      deviceLabel: "Old laptop",
      lastUsedAt: ago(70),
      createdAt: ago(200),
    }),
    key({
      id: "k4",
      ownerId: U_MIXED,
      deviceLabel: "New tablet",
      lastUsedAt: null,
      createdAt: ago(3),
    }),
    // Entirely stale: one long-idle, one nobody ever connected with.
    key({
      id: "k5",
      ownerId: U_DEAD,
      deviceLabel: "Retired desktop",
      lastUsedAt: ago(120),
      createdAt: ago(300),
    }),
    key({
      id: "k6",
      ownerId: U_DEAD,
      state: "disabled",
      deviceLabel: "Unused spare",
      lastUsedAt: null,
      createdAt: ago(200),
    }),
    // Already gone: holds no peer, so it is outside the question entirely.
    key({
      id: "k7",
      ownerId: U_DEAD,
      state: "revoked",
      deviceLabel: "Deleted phone",
      lastUsedAt: ago(400),
      createdAt: ago(500),
    }),
  ];

  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("keys --stale lists only the stale keys and says which kind each is", async () => {
    stubFetch([{ body: keys }, { body: users }]);
    const out = await run(["keys", "--stale"]);
    expect(out).toMatch(/Old laptop/);
    expect(out).toMatch(/Retired desktop/);
    expect(out).toMatch(/Unused spare/);
    // The live keys and the one issued this week are not on the list.
    expect(out).not.toMatch(/Work phone/);
    expect(out).not.toMatch(/Home phone/);
    expect(out).not.toMatch(/New tablet/);
    // Nor is the revoked one — it holds no peer.
    expect(out).not.toMatch(/Deleted phone/);
    expect(out).toMatch(/why/);
    expect(out).toMatch(/idle/);
    expect(out).toMatch(/never/);
  });

  it("keys --stale-days widens the window", async () => {
    stubFetch([{ body: keys }, { body: users }]);
    const out = await run(["keys", "--stale", "--stale-days=100"]);
    // The 70-day-idle laptop is inside a 100-day window now.
    expect(out).not.toMatch(/Old laptop/);
    expect(out).toMatch(/Retired desktop/);
  });

  it("stale-keys lists who is holding them, worst first, and skips clean users", async () => {
    stubFetch([{ body: keys }, { body: users }]);
    const out = await run(["stale-keys", "--json"]);
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed.map((row) => row.email)).toEqual([
      "dead@example.com",
      "mixed@example.com",
    ]);
    expect(parsed[0]).toMatchObject({ stale: 2, idle: 1, never: 1, held: 2 });
    // The mixed user: the live key does not hide the abandoned one, and the
    // brand-new key counts as fresh rather than stale.
    expect(parsed[1]).toMatchObject({
      stale: 1,
      idle: 1,
      never: 0,
      live: 1,
      fresh: 1,
      held: 3,
    });
  });

  it("stale-keys --all keeps the users with nothing stale", async () => {
    stubFetch([{ body: keys }, { body: users }]);
    const out = await run(["stale-keys", "--all", "--json"]);
    expect(JSON.parse(out)).toHaveLength(3);
  });

  it("stale-keys-revoke without --confirm posts nothing and names every key", async () => {
    const calls = stubFetch([{ body: keys }]);
    const out = await run(["stale-keys-revoke", U_DEAD]);
    expect(calls).toHaveLength(1); // the keys read, and nothing else
    expect(out).toMatch(/k5/);
    expect(out).toMatch(/k6/);
    expect(out).toMatch(/Would revoke 2/);
    expect(out).toMatch(/NOT key-purge/);
  });

  it("stale-keys-revoke --confirm revokes each stale key on its own call", async () => {
    const calls = stubFetch([{ body: keys }, { body: { ok: true } }]);
    const out = await run(["stale-keys-revoke", U_DEAD, "--confirm"]);
    // Longest stale first, and one call per key.
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      expect.stringMatching(/\/api\/admin\/keys\/k6\/revoke$/),
      expect.stringMatching(/\/api\/admin\/keys\/k5\/revoke$/),
    ]);
    // Never the purge route, whatever state the key is in.
    expect(calls.some((call) => call.url.includes("/purge"))).toBe(false);
    expect(out).toMatch(/revoked 2 of 2/);
  });

  it("stale-keys-revoke leaves a user with nothing stale alone", async () => {
    const calls = stubFetch([{ body: keys }]);
    const out = await run(["stale-keys-revoke", U_LIVE, "--confirm"]);
    expect(calls).toHaveLength(1);
    expect(out).toMatch(/no keys stale/);
  });

  it("stale-keys-revoke reports a key the API refused instead of swallowing it", async () => {
    // The second key's state moved under the operator; the API answers 409.
    stubFetch([
      { body: keys },
      { body: { ok: true } },
      { status: 409, body: { error: "INVALID_KEY_TRANSITION" } },
    ]);
    await expect(
      run(["stale-keys-revoke", U_DEAD, "--confirm"]),
    ).rejects.toThrow(/could not be revoked/);
  });

  it("a --days typo is refused rather than silently restoring the default", async () => {
    const calls = stubFetch([{ body: keys }]);
    await expect(
      run(["stale-keys-revoke", U_DEAD, "--days=thirty", "--confirm"]),
    ).rejects.toThrow(/--days must be an integer/);
    expect(calls).toHaveLength(0);
  });
});
