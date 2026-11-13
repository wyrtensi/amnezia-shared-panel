import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdBridgeEnroll } from "./bridges.js";
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

  it("--remove names what a removal costs before the request goes out", async () => {
    // The Users dialog states both halves before its confirm button; the shell
    // said only the reassuring one, which is the half an operator already
    // assumes. Order matters as much as the words: this has to be readable
    // before the change, not as an epilogue to "now …".
    stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld", "other.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--remove=other.tld"]);
    expect(out).toMatch(/removing other\.tld/);
    expect(out).toMatch(/Nobody with an active panel account loses access/);
    expect(out).toMatch(/anyone with an address on other\.tld and no/);
    expect(out).toMatch(/no account is created for/);
    expect(out.indexOf("Who does lose their way in")).toBeLessThan(
      out.indexOf("cf-domains: now"),
    );
  });

  it("a --set that stops naming a domain states the same cost", async () => {
    // Same consequence, a different flag: the warning is computed from the
    // difference rather than attached to --remove alone.
    stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld", "other.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--set=company.tld"]);
    expect(out).toMatch(/removing other\.tld/);
    expect(out).toMatch(/Who does lose their way in/);
  });

  it("--add says nothing about removals, having caused none", async () => {
    stubFetch([
      { body: [{ cfAccessAllowedDomains: ["company.tld"] }] },
      { body: {} },
    ]);
    const out = await run(["cf-domains", "--add=other.tld"]);
    expect(out).not.toMatch(/lose their way in/);
    expect(out).not.toMatch(/removing/);
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
    // Wiping the whole list costs what removing one domain costs, times the
    // list — it must not be the one path that stays quiet about it.
    expect(out).toMatch(/Who does lose their way in/);
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

describe("users --domain=", () => {
  // cmdUsers reads the user list and the portal policy, in that order.
  const users = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      email: "ann@company.tld",
      displayName: "Ann",
      role: "user",
      status: "active",
      keyLimitOverride: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      email: "Bob@COMPANY.tld",
      displayName: "Bob",
      role: "admin",
      status: "active",
      keyLimitOverride: null,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      email: "carl@other.tld",
      displayName: "Carl",
      role: "user",
      status: "disabled",
      keyLimitOverride: null,
    },
  ];
  const policy = [{ keyLimitMode: "per_node", defaultKeyLimit: 3 }];

  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("lists everyone when no domain is given", async () => {
    stubFetch([{ body: users }, { body: policy }]);
    const out = await run(["users"]);
    expect(out).toMatch(/ann@company\.tld/);
    expect(out).toMatch(/carl@other\.tld/);
  });

  it("keeps only the addresses on the named domain, whatever their case", async () => {
    stubFetch([{ body: users }, { body: policy }]);
    const out = await run(["users", "--domain=company.tld"]);
    expect(out).toMatch(/ann@company\.tld/);
    expect(out).toMatch(/Bob@COMPANY\.tld/);
    expect(out).not.toMatch(/carl@other\.tld/);
  });

  it("accepts the @company.tld form the Cloudflare dashboard shows", async () => {
    stubFetch([{ body: users }, { body: policy }]);
    const out = await run(["users", "--domain=@Company.TLD"]);
    expect(out).toMatch(/ann@company\.tld/);
    expect(out).toMatch(/Bob@COMPANY\.tld/);
    expect(out).not.toMatch(/carl@other\.tld/);
  });

  it("says (none) for a domain nobody is on, rather than failing", async () => {
    // The shell has no list of the domains that exist, unlike the panel's
    // picker — "nobody" is the answer to the question, not an error.
    stubFetch([{ body: users }, { body: policy }]);
    const out = await run(["users", "--domain=nobody.tld"]);
    expect(out).toMatch(/\(none\)/);
    expect(out).not.toMatch(/@/);
  });

  it("filters --json too, so the census is scriptable without jq", async () => {
    stubFetch([{ body: users }, { body: policy }]);
    const out = await run(["users", "--domain=other.tld", "--json"]);
    expect(JSON.parse(out)).toEqual([users[2]]);
  });
});

describe("route rules take addresses, not site names", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  // Refusing before the request matters more than the wording: a silent no-op
  // would leave a script reporting success over a change that never happened.
  for (const [command, flag] of [
    ["user-routes", "bl-domains"],
    ["global-routes-set", "add-domains"],
    ["global-routes-set", "exclude-domains"],
  ] as const) {
    it(`${command} refuses --${flag} and sends nothing`, async () => {
      const calls = stubFetch([{ body: {} }]);
      await expect(
        run([
          command,
          ...(command === "user-routes"
            ? ["ann@company.tld"]
            : ["--profile=ru_blacklist"]),
          `--${flag}=example.com`,
        ]),
      ).rejects.toThrow(new RegExp(`--${flag}: no longer accepted`));
      expect(calls).toHaveLength(0);
    });
  }

  it("names the way that does work instead of just saying no", async () => {
    stubFetch([{ body: {} }]);
    await expect(
      run(["user-routes", "ann@company.tld", "--bl-domains=example.com"]),
    ).rejects.toThrow(/full_tunnel key[\s\S]*AmneziaVPN app/);
  });

  it("user-routes still writes the address list, with no domains", async () => {
    const calls = stubFetch([{ body: { id: "u1" } }]);
    await run([
      "user-routes",
      "11111111-1111-1111-1111-111111111111",
      "--bl-cidrs=1.2.3.4,10.0.0.0/8",
    ]);
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      ru_blacklist: { cidrs: string[]; domains: string[] };
    };
    expect(body.ru_blacklist.cidrs).toEqual(["1.2.3.4", "10.0.0.0/8"]);
    expect(body.ru_blacklist.domains).toEqual([]);
  });

  // A stored payload's site names are shown, not hidden: an operator should be
  // able to see what a row still holds before a write clears it.
  it("global-routes marks leftover site names INACTIVE", async () => {
    stubFetch([
      {
        body: [
          {
            ru_blacklist: {
              add: { cidrs: ["1.2.3.0/24"], domains: ["example.com"] },
              exclude: { cidrs: [], domains: [] },
            },
          },
        ],
      },
    ]);
    const out = await run(["global-routes"]);
    expect(out).toMatch(/add domains \(1, INACTIVE/);
    expect(out).toMatch(/example\.com/);
    // Every other list is silent about domains rather than printing an empty one.
    expect(out.match(/domains/g)).toHaveLength(1);
  });

  it("global-routes-set clears the site names a stored payload still holds", async () => {
    const calls = stubFetch([
      {
        body: [
          {
            ru_blacklist: {
              add: { cidrs: [], domains: ["other.example"] },
              exclude: { cidrs: [], domains: ["ads.example.net"] },
            },
          },
        ],
      },
      { body: {} },
    ]);
    await run([
      "global-routes-set",
      "--profile=ru_blacklist",
      "--add-cidrs=203.0.113.0/24",
    ]);
    const sent = JSON.parse(calls[1]?.init?.body as string) as Record<
      string,
      {
        add: { cidrs: string[]; domains: string[] };
        exclude: { domains: string[] };
      }
    >;
    expect(sent.ru_blacklist?.add.cidrs).toEqual(["203.0.113.0/24"]);
    expect(sent.ru_blacklist?.add.domains).toEqual([]);
    expect(sent.ru_blacklist?.exclude.domains).toEqual([]);
  });
});

describe("offboarded-purge", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  const eligible = {
    confirmed: false,
    retentionDays: 30,
    eligible: [
      {
        id: "u1",
        email: "gone@example.com",
        disabledAt: "2026-07-01T00:00:00.000Z",
        revokedKeyCount: 2,
      },
    ],
    deleted: [],
  };

  it("without --confirm sends confirm:false and deletes nothing", async () => {
    const calls = stubFetch([{ body: eligible }]);
    const out = await run(["offboarded-purge"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/api\/admin\/users\/offboarded\/purge$/);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      confirm: false,
    });
    expect(out).toMatch(/gone@example\.com/);
    expect(out).toMatch(/Re-run with --confirm/);
  });

  it("--confirm sends confirm:true and reports what was deleted", async () => {
    const calls = stubFetch([
      {
        body: {
          ...eligible,
          confirmed: true,
          deleted: ["gone@example.com"],
        },
      },
    ]);
    const out = await run(["offboarded-purge", "--confirm"]);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      confirm: true,
    });
    expect(out).toMatch(/deleted 1 account/);
    expect(out).not.toMatch(/Re-run with --confirm/);
  });

  it("--json prints the raw result instead of a table", async () => {
    stubFetch([{ body: eligible }]);
    const out = await run(["offboarded-purge", "--json"]);
    expect(JSON.parse(out)).toEqual(eligible);
  });
});

describe("user-delete", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  // Real UUID so resolveUserId short-circuits without a users lookup.
  const U = "44444444-4444-4444-8444-444444444444";

  it("without --confirm posts nothing and prints what it would do", async () => {
    const calls = stubFetch([]);
    const out = await run(["user-delete", U]);
    expect(calls).toHaveLength(0);
    expect(out).toMatch(/permanently deletes the user row/);
    expect(out).toMatch(/Re-run with --confirm/);
  });

  it("--confirm posts to the per-user delete action", async () => {
    const calls = stubFetch([
      { body: { id: U, deleted: true, email: "gone@example.com" } },
    ]);
    const out = await run(["user-delete", U, "--confirm"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(
      new RegExp(`/api/admin/users/${U}/delete$`),
    );
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({});
    expect(out).toMatch(/deleted from the panel/);
  });

  it("surfaces the server's refusal instead of swallowing it", async () => {
    // Rung one has not happened yet -- the account is still active.
    stubFetch([
      {
        status: 409,
        body: {
          error: "USER_NOT_DISABLED",
          message:
            "This account is still active. Offboard it first, then delete it.",
        },
      },
    ]);
    await expect(run(["user-delete", U, "--confirm"])).rejects.toThrow(
      /still active/,
    );
  });

  it("surfaces the live-key refusal distinctly from the not-disabled one", async () => {
    stubFetch([
      {
        status: 409,
        body: {
          error: "USER_HAS_LIVE_KEYS",
          message:
            "This account still holds a live key. Revoke or purge it before deleting the account.",
        },
      },
    ]);
    await expect(run(["user-delete", U, "--confirm"])).rejects.toThrow(
      /live key/,
    );
  });
});

describe("key-rename", () => {
  const K = "0b48cc4c-404b-47a6-af28-4cf15f305e30";

  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  it("requires both the id and --label", async () => {
    await expect(run(["key-rename"])).rejects.toThrow(/Usage: key-rename/);
    await expect(run(["key-rename", K])).rejects.toThrow(/Usage: key-rename/);
  });

  it("posts the trimmed label to the OWNER route, not an admin one", async () => {
    // No `/api/admin/...` anywhere here: renaming has no admin path at all,
    // so this must hit the same self-scoped route the panel's own "Rename"
    // button does, reachable only for a key this identity owns.
    const calls = stubFetch([
      { body: { id: K, state: "provisioning", reissued: true } },
    ]);
    const out = await run(["key-rename", K, "--label=New Laptop"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(new RegExp(`/api/keys/${K}/rename$`));
    expect(calls[0]?.url).not.toMatch(/\/admin\//);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      deviceLabel: "New Laptop",
    });
    expect(out).toMatch(/renamed and re-issuing/);
    expect(out).toMatch(/provisioning/);
  });

  it("says plainly when no re-issue was needed", async () => {
    stubFetch([{ body: { id: K, state: "active", reissued: false } }]);
    const out = await run(["key-rename", K, "--label=New Laptop"]);
    expect(out).toMatch(/renamed \(state: active\)/);
    expect(out).not.toMatch(/re-issuing/);
    expect(out).toMatch(/no re-issue was needed/);
  });

  it("surfaces a rename of someone else's key as the server's own refusal", async () => {
    stubFetch([
      {
        status: 404,
        body: { error: "KEY_NOT_FOUND", message: "Key not found" },
      },
    ]);
    await expect(
      run(["key-rename", K, "--label=Hijacked"]),
    ).rejects.toThrow(/Key not found/);
  });
});

describe("reachability probe commands", () => {
  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
  });

  const level = (ok: boolean | null) => ({ ok, detail: null, latencyMs: null });
  const probe = {
    label: "Testland",
    apiBaseUrl: "http://host.docker.internal:4120",
    enabled: true,
    controlUrl: "https://example.com/",
    egressUrl: "https://api.ipify.org",
    intervalSec: 3600,
    failThreshold: 2,
    staleAfterSec: 10800,
    lastResultAt: "2026-01-01T10:00:00.000Z",
    lastError: null,
    lastErrorAt: null,
    stale: false,
    runInFlight: false,
    runRequestedAt: null,
    timeZone: "UTC",
    widgetUpdatedAt: null,
    widgetLastError: null,
  };
  const view = {
    probe,
    nodes: [
      {
        nodeId: "11111111-1111-4111-8111-111111111111",
        nodeName: "node-a",
        nodeEnabled: true,
        reachabilityEnabled: true,
        status: "failed",
        checkedAt: "2026-01-01T10:00:00.000Z",
        failingSince: "2026-01-01T09:00:00.000Z",
        consecutiveFailures: 2,
        incidentOpen: true,
        detail: "no handshake",
        protocols: [
          {
            protocol: "awg3",
            status: "failed",
            levels: { ping: level(false), tcp: level(true), handshake: level(false), http: level(null) },
            egressIp: null,
            detail: "no handshake",
            checkedAt: "2026-01-01T10:00:00.000Z",
            keyState: "active",
          },
        ],
      },
      {
        nodeId: "22222222-2222-4222-8222-222222222222",
        nodeName: "node-b",
        nodeEnabled: true,
        reachabilityEnabled: true,
        status: "error",
        checkedAt: "2026-01-01T10:00:00.000Z",
        failingSince: null,
        consecutiveFailures: 0,
        incidentOpen: false,
        detail: "control target failed",
        protocols: [],
      },
    ],
  };

  it("probe prints the settings and never a key", async () => {
    stubFetch([{ body: view }]);
    const out = await run(["probe"]);
    expect(out).toContain("label:          Testland");
    expect(out).not.toMatch(/api ?key/i);
  });

  it("probe-set registers a probe with the key from a flag", async () => {
    const calls = stubFetch([{ body: { probe: null, nodes: [] } }, { body: probe }]);
    await run([
      "probe-set",
      "--label=Testland",
      "--api-url=http://host.docker.internal:4120",
      `--api-key=${"k".repeat(32)}`,
      "--control-url=https://example.com/",
    ]);
    expect(calls[1]?.url).toContain("/api/admin/reachability/probe");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      label: "Testland",
      apiBaseUrl: "http://host.docker.internal:4120",
      controlUrl: "https://example.com/",
      apiKey: "k".repeat(32),
    });
  });

  it("probe-set on an existing probe changes only the named field", async () => {
    const calls = stubFetch([{ body: view }, { body: probe }]);
    await run(["probe-set", "--interval-sec=1800"]);
    const body = JSON.parse(calls[1]?.init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ label: "Testland", intervalSec: 1800, failThreshold: 2 });
    expect(body).not.toHaveProperty("apiKey");
  });

  it("probe-set sets the widget time zone and keeps it otherwise", async () => {
    const calls = stubFetch([{ body: view }, { body: probe }]);
    await run(["probe-set", "--time-zone=Europe/Belgrade"]);
    expect(JSON.parse(calls[1]?.init?.body as string)).toMatchObject({ timeZone: "Europe/Belgrade" });
    const again = stubFetch([{ body: view }, { body: probe }]);
    await run(["probe-set", "--interval-sec=1800"]);
    expect(JSON.parse(again[1]?.init?.body as string)).toMatchObject({ timeZone: "UTC" });
  });

  it("probe shows the time zone and the widget state", async () => {
    stubFetch([{ body: { ...view, probe: { ...probe, widgetLastError: "Telegram sendWidget failed" } } }]);
    const out = await run(["probe"]);
    expect(out).toContain("time zone:      UTC");
    expect(out).toContain("tg widget:      error: Telegram sendWidget failed");
  });

  it("probe-set refuses a new probe without a key", async () => {
    stubFetch([{ body: { probe: null, nodes: [] } }]);
    await expect(
      run(["probe-set", "--label=Testland", "--api-url=http://x:1", "--control-url=https://example.com/"]),
    ).rejects.toThrow("Usage: probe-set");
  });

  it("probe-run posts the marker", async () => {
    const calls = stubFetch([{ body: {} }]);
    const out = await run(["probe-run"]);
    expect(calls[0]?.url).toContain("/api/admin/reachability/run");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(out).toContain("run requested");
  });

  it("probe-results keeps unknown apart from unavailable", async () => {
    stubFetch([{ body: view }]);
    const out = await run(["probe-results"]);
    expect(out).toContain("UNAVAILABLE");
    expect(out).toMatch(/node-b\s+\|?\s*unknown/);
    expect(out).toContain("2026-01-01T09:00:00.000Z");
  });

  it("node-probe --off patches the node", async () => {
    const calls = stubFetch([
      { body: [{ id: "11111111-1111-4111-8111-111111111111", name: "node-a" }] },
      { body: {} },
    ]);
    await run(["node-probe", "node-a", "--off"]);
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch?.url).toContain("/api/admin/nodes/11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(patch?.init?.body as string)).toEqual({ reachabilityEnabled: false });
  });

  it("help lists every probe command", async () => {
    stubFetch([{ body: {} }]);
    const out = await run(["help"]);
    for (const command of ["probe ", "probe-set", "probe-delete", "probe-run", "probe-results", "node-probe"]) {
      expect(out).toContain(command);
    }
  });
});

const sentBody = (call: { init?: RequestInit }): unknown =>
  JSON.parse(call.init?.body as string);

describe("bridge commands", () => {
  const NODE = "22222222-2222-4222-8222-222222222222";
  const BRIDGE = "33333333-3333-4333-8333-333333333333";
  const ROUTE = "44444444-4444-4444-8444-444444444444";
  const bridge = {
    id: BRIDGE,
    name: "Frankfurt",
    publicIpv4: "198.51.100.7",
    controlTcpPort: 7000,
    udpPortStart: 41000,
    udpPortEnd: 41031,
    capacity: 32,
    heldPorts: 1,
    managementStatus: "ok",
    lastObservedAt: "2026-11-13T10:00:00.000Z",
    routes: [{ id: ROUTE, nodeId: NODE, nodeName: "N1", publicUdpPort: 41000, state: "draft" }],
  };

  beforeEach(() => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
  });
  afterEach(() => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it("bridges lists held/total ports and route counts", async () => {
    stubFetch([{ body: [bridge] }]);
    const out = await run(["bridges"]);
    expect(out).toContain("Frankfurt");
    expect(out).toContain("1/32");
  });

  it("bridges --json prints the typed list with agent state and per-route evidence", async () => {
    const full = {
      ...bridge,
      management: {
        apiUrl: "http://host.docker.internal:17600",
        enrolled: true,
        enrolledAt: "2026-11-13T09:00:00.000Z",
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        agentCapabilities: ["status.v1"],
        frpsVersion: "0.72.0",
        frpsReachable: true,
        lastErrorCode: null,
        lastPollAttemptAt: "2026-11-13T10:00:00.000Z",
      },
      routes: [
        {
          ...bridge.routes[0],
          registration: { status: "online", marker: "m".repeat(32), observedAt: "2026-11-13T10:00:00.000Z" },
          verification: { kind: "awg_path", status: "ok", checkedAt: "2026-11-13T09:59:00.000Z" },
        },
      ],
    };
    stubFetch([{ body: [full] }]);
    const [out] = JSON.parse(await run(["bridges", "--json"])) as Array<Record<string, unknown>>;
    expect(out).toMatchObject({
      managementStatus: "ok",
      management: {
        enrolled: true,
        agentVersion: "0.1.0",
        agentCapabilities: ["status.v1"],
        frpsVersion: "0.72.0",
        frpsReachable: true,
      },
      routes: [
        {
          registration: { status: "online" },
          verification: { kind: "awg_path", status: "ok", checkedAt: "2026-11-13T09:59:00.000Z" },
        },
      ],
    });
    // The management URL is an internal address and stays out of the output.
    expect(JSON.stringify(out)).not.toContain("host.docker.internal");
  });

  it("bridges (table) shows agent version and frps state", async () => {
    stubFetch([
      {
        body: [
          {
            ...bridge,
            management: { enrolled: true, agentVersion: "0.1.0", frpsVersion: "0.72.0", frpsReachable: true },
          },
        ],
      },
    ]);
    const out = await run(["bridges"]);
    expect(out).toMatch(/agent\s+frps/);
    expect(out).toContain("0.1.0");
    expect(out).toContain("0.72.0");
  });

  it("bridge-add without --confirm submits nothing", async () => {
    const calls = stubFetch([{ body: bridge }]);
    const out = await run(["bridge-add", "--name=Frankfurt", "--ipv4=198.51.100.7"]);
    expect(calls).toHaveLength(0);
    expect(out).toContain("Nothing was changed");
  });

  it("bridge-add prints the approved agent image, or says none is available", async () => {
    const image = `ghcr.io/o/r/bridge-agent@sha256:${"a".repeat(64)}`;
    const withImage = {
      install: `sudo sh install-bridge.sh --agent-image ${image}`,
      dryRun: `sudo sh install-bridge.sh --agent-image ${image} --dry-run`,
      agentImage: image,
    };
    stubFetch([{ status: 201, body: { ...bridge, setupCommands: withImage } }]);
    const has = await run(["bridge-add", "--name=B", "--ipv4=198.51.100.7", "--confirm"]);
    expect(has).toContain(`install: ${withImage.install}`);
    expect(has).toContain(`carry the approved bridge-agent image (${image})`);
    expect(has).not.toContain("exit 60");

    stubFetch([{ status: 201, body: { ...bridge, setupCommands: { install: "i", dryRun: "d", agentImage: null } } }]);
    const none = await run(["bridge-add", "--name=B", "--ipv4=198.51.100.7", "--confirm"]);
    expect(none).toContain("No approved bridge-agent image is available");
    expect(none).toContain("BRIDGE_AGENT_IMAGE_REPOSITORY");
    expect(none).toContain("exit 60");
  });

  it("bridge-add --confirm posts the body and prints setupCommands only if returned", async () => {
    const calls = stubFetch([{ status: 201, body: { ...bridge, setupCommands: { install: "run-this" } } }]);
    const out = await run([
      "bridge-add", "--name=Frankfurt", "--ipv4=198.51.100.7", "--udp-start=42000", "--confirm",
    ]);
    expect(calls[0]!.url).toContain("/api/admin/vpn-bridges");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(sentBody(calls[0]!)).toEqual({
      name: "Frankfurt", publicIpv4: "198.51.100.7", udpPortStart: 42000,
    });
    expect(out).toContain("run-this");
    stubFetch([{ status: 201, body: bridge }]);
    expect(await run(["bridge-add", "--name=F", "--ipv4=198.51.100.7", "--confirm"])).not.toContain("setup commands");
  });

  describe("bridge-enroll", () => {
    const KEY = "k".repeat(40);
    const URL_ARG = "--api-url=http://host.docker.internal:17600";
    const enrolled = {
      ...bridge,
      management: {
        apiUrl: "http://host.docker.internal:17600",
        enrolled: true,
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        agentCapabilities: ["status.v1"],
        frpsVersion: "0.72.0",
        frpsReachable: true,
      },
      setupCommands: { install: "do-not-print-me" },
    };
    let keyDir: string;
    beforeEach(async () => {
      keyDir = await mkdtemp(join(tmpdir(), "bridge-enroll-"));
    });
    afterEach(async () => {
      await rm(keyDir, { recursive: true, force: true });
    });
    const keyFile = async (mode: number): Promise<string> => {
      const path = join(keyDir, "agent.token");
      await writeFile(path, `${KEY}\n`, { mode });
      await chmod(path, mode);
      return path;
    };

    it("without --confirm sends nothing and does not read the key", async () => {
      const calls = stubFetch([{ body: enrolled }]);
      const out = await run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key-file=${join(keyDir, "missing")}`]);
      expect(out).toContain("Nothing was changed");
      expect(calls).toHaveLength(0);
    });

    it("reads the key from a 0600 file, PATCHes it, and prints identity and capabilities only", async () => {
      const calls = stubFetch([{ body: enrolled }]);
      const path = await keyFile(0o600);
      const out = await run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key-file=${path}`, "--confirm"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain(`/api/admin/vpn-bridges/${BRIDGE}`);
      expect(calls[0]!.init?.method).toBe("PATCH");
      expect(sentBody(calls[0]!)).toEqual({
        managementApiUrl: "http://host.docker.internal:17600",
        apiKey: KEY,
      });
      expect(out).toContain("Frankfurt");
      expect(out).toContain("status.v1");
      expect(out).toContain("0.72.0");
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("host.docker.internal");
      expect(out).not.toContain("do-not-print-me");
    });

    it("--json carries the same fields and no URL, key or commands", async () => {
      stubFetch([{ body: enrolled }]);
      const path = await keyFile(0o600);
      const out = await run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key-file=${path}`, "--confirm", "--json"]);
      expect(JSON.parse(out)).toEqual({
        id: BRIDGE,
        name: "Frankfurt",
        managementStatus: "ok",
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        agentCapabilities: ["status.v1"],
        frpsVersion: "0.72.0",
        frpsReachable: true,
      });
    });

    it("refuses a key file that group or others can read, before any request", async () => {
      const calls = stubFetch([{ body: enrolled }]);
      const path = await keyFile(0o644);
      await expect(
        run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key-file=${path}`, "--confirm"]),
      ).rejects.toThrow(/accessible by group or others/);
      expect(calls).toHaveLength(0);
    });

    it("refuses an inline key, a non-UUID id and a missing key flag", async () => {
      const calls = stubFetch([{ body: enrolled }]);
      await expect(
        run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key=${KEY}`, "--confirm"]),
      ).rejects.toThrow(/Unknown flag/);
      await expect(
        run(["bridge-enroll", "frankfurt", URL_ARG, "--api-key-file=-", "--confirm"]),
      ).rejects.toThrow(/must be a UUID/);
      await expect(run(["bridge-enroll", BRIDGE, URL_ARG, "--confirm"])).rejects.toThrow(/Usage: bridge-enroll/);
      expect(calls).toHaveLength(0);
    });

    it("surfaces an identity mismatch with a hint", async () => {
      stubFetch([{ status: 409, body: { error: "BRIDGE_IDENTITY_MISMATCH", message: "other bridge" } }]);
      const path = await keyFile(0o600);
      await expect(
        run(["bridge-enroll", BRIDGE, URL_ARG, `--api-key-file=${path}`, "--confirm"]),
      ).rejects.toThrow(/BRIDGE_IDENTITY_MISMATCH: other bridge\n.*bridge id/);
    });
  });

  it("bridge-enroll reads the key from stdin for -", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const api = ((_path: string, init?: RequestInit) => {
      calls.push({ init });
      return Promise.resolve({ id: BRIDGE, name: "Frankfurt", managementStatus: "ok" });
    }) as Parameters<typeof cmdBridgeEnroll>[0];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await cmdBridgeEnroll(
        api,
        [BRIDGE, "--api-url=http://host.docker.internal:17600", "--api-key-file=-", "--confirm"],
        undefined,
        { readFile: (path) => (path === "-" ? `${"s".repeat(40)}\n` : "wrong") },
      );
    } finally {
      logSpy.mockRestore();
    }
    expect(sentBody(calls[0]!)).toMatchObject({ apiKey: "s".repeat(40) });
  });

  describe("bridge-agent-update and bridge-agent-log", () => {
    const DIGEST = `sha256:${"a".repeat(64)}`;
    const OP = "55555555-5555-4555-8555-555555555555";
    const operation = {
      operationId: OP,
      state: "queued",
      requestedDigest: DIGEST,
      requestedVersion: "0.2.0",
      fromVersion: "0.1.0",
      requestedAt: "2026-11-13T10:00:00.000Z",
      sentAt: null,
      acknowledgedAt: null,
      lastCheckedAt: null,
      notAfter: "2026-11-13T10:02:00.000Z",
      acknowledgementOverdueSince: null,
      contactLostSince: null,
      errorCode: null,
      result: null,
    };
    const view = {
      bridgeId: BRIDGE,
      enrolled: true,
      installedVersion: "0.1.0",
      updateSupported: true,
      jobsEnabled: true,
      offered: [
        { image: `ghcr.io/example/amnezia/bridge-agent@${DIGEST}`, repository: "ghcr.io/example/amnezia/bridge-agent", version: "0.2.0", digest: DIGEST },
      ],
      operation: null,
      history: [],
    };

    it("previews installed against offered without --confirm and changes nothing", async () => {
      const calls = stubFetch([{ body: view }]);
      const out = await run(["bridge-agent-update", BRIDGE]);
      expect(out).toContain("0.1.0 installed");
      expect(out).toContain("offered: 0.2.0");
      expect(out).toContain("Nothing was changed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    });

    it("--confirm requests exactly the offered digest and says how to follow it", async () => {
      const calls = stubFetch([{ body: view }, { status: 202, body: { created: true, operation } }]);
      const out = await run(["bridge-agent-update", BRIDGE, "--confirm"]);
      expect(calls[1]?.url).toContain(`/api/admin/vpn-bridges/${BRIDGE}/agent-update`);
      expect(calls[1]?.init?.method).toBe("POST");
      expect(sentBody(calls[1]!)).toEqual({ imageDigest: DIGEST });
      expect(out).toContain(`Requesting ghcr.io/example/amnezia/bridge-agent@${DIGEST}`);
      expect(out).toContain("update to 0.2.0 requested");
      expect(out).toContain(`bridge-agent-log ${BRIDGE}`);
    });

    it("a repeat reports the already outstanding operation", async () => {
      stubFetch([{ body: view }, { body: { created: false, operation } }]);
      expect(await run(["bridge-agent-update", BRIDGE, "--confirm"])).toContain("already outstanding");
    });

    it("surfaces a 409 with its hint, and refuses a bad id or flag without a request", async () => {
      stubFetch([
        { body: view },
        { status: 409, body: { error: "BRIDGE_UPDATE_IN_PROGRESS", message: "busy" } },
      ]);
      await expect(run(["bridge-agent-update", BRIDGE, "--confirm"])).rejects.toThrow(
        /BRIDGE_UPDATE_IN_PROGRESS: busy\n.*bridge-agent-log/,
      );
      const calls = stubFetch([{ body: view }]);
      await expect(run(["bridge-agent-update", "frankfurt"])).rejects.toThrow(/must be a UUID/);
      await expect(run(["bridge-agent-update", BRIDGE, "--image=x"])).rejects.toThrow(/Unknown flag/);
      expect(calls).toHaveLength(0);
    });

    it("refuses --confirm when nothing is offered", async () => {
      const calls = stubFetch([{ body: { ...view, offered: [] } }]);
      await expect(run(["bridge-agent-update", BRIDGE, "--confirm"])).rejects.toThrow(/nothing to request/);
      expect(calls).toHaveLength(1);
    });

    it("bridge-agent-log names a pickup timeout and lost contact, and --json is the typed projection", async () => {
      const timedOut = {
        ...operation,
        state: "pickup_timeout",
        errorCode: "UPDATE_NOT_ACKNOWLEDGED",
        result: { finishedAt: "2026-11-13T10:03:00.000Z", errorCode: "UPDATE_NOT_ACKNOWLEDGED" },
      };
      const lost = { ...operation, operationId: "66666666-6666-4666-8666-666666666666", state: "running", contactLostSince: "2026-11-13T09:00:00.000Z" };
      stubFetch([{ body: { ...view, operation: timedOut, history: [lost] } }]);
      const out = await run(["bridge-agent-log", BRIDGE]);
      expect(out).toContain("pickup_timeout");
      expect(out).toContain("confirmed the request expired");
      expect(out).toContain("not retried automatically");
      expect(out).toContain("management contact lost since 2026-11-13T09:00:00.000Z");

      stubFetch([{ body: { ...view, operation: timedOut, history: [], extra: "dropped" } }]);
      const parsed = JSON.parse(await run(["bridge-agent-log", BRIDGE, "--json"])) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("extra");
      expect(parsed.operation).toMatchObject({ state: "pickup_timeout", result: { errorCode: "UPDATE_NOT_ACKNOWLEDGED" } });
    });

    it("never falls back to an outstanding operation's digest when nothing is offered, and names an overdue acknowledgement", async () => {
      const running = { ...operation, state: "sent", acknowledgementOverdueSince: "2026-11-13T10:05:00.000Z" };
      const calls = stubFetch([{ body: { ...view, offered: [], operation: running } }]);
      await expect(run(["bridge-agent-update", BRIDGE, "--confirm"])).rejects.toThrow(/nothing to request/);
      expect(calls).toHaveLength(1);
      stubFetch([{ body: { ...view, operation: running } }]);
      expect(await run(["bridge-agent-log", BRIDGE])).toContain("acknowledgement overdue since 2026-11-13T10:05:00.000Z");
    });

    it("words lost contact by state", async () => {
      stubFetch([{ body: { ...view, operation: { ...operation, state: "sent", contactLostSince: "2026-11-13T10:01:00.000Z" } } }]);
      expect(await run(["bridge-agent-log", BRIDGE])).toContain("before the host acknowledged the request");
      stubFetch([{ body: { ...view, operation: { ...operation, state: "running", contactLostSince: "2026-11-13T10:01:00.000Z" } } }]);
      expect(await run(["bridge-agent-log", BRIDGE])).toContain("expected while the agent is replaced");
    });

    it("bridge-agent-log with no operation says so", async () => {
      stubFetch([{ body: view }]);
      expect(await run(["bridge-agent-log", BRIDGE])).toContain("no agent update was requested");
    });
  });

  describe("bridge-rollback-preflight", () => {
    const NODE = "66666666-6666-4666-8666-666666666666";
    const blocked = {
      activeAssignments: { count: 1, nodeIds: [NODE] },
      outstandingAgentUpdates: { count: 0, bridgeIds: [] },
      pendingJobs: { count: 2, byType: { "bridge_agent.poll": 2 } },
      jobsEnabled: true,
      readyForPreBridgeRollback: false,
      blockingReasons: ["BRIDGE_JOBS_ENABLED", "ACTIVE_ASSIGNMENTS", "PENDING_BRIDGE_JOBS"],
    };

    it("prints what blocks the rollback and calls only the read endpoint", async () => {
      const calls = stubFetch([{ body: blocked }]);
      const out = await run(["bridge-rollback-preflight"]);
      expect(out).toContain(`active bridge assignments: 1 (nodes ${NODE}`);
      expect(out).toContain("pending bridge jobs: 2 (bridge_agent.poll 2)");
      expect(out).toContain("VPN_BRIDGE_JOBS_ENABLED: true (set it to false first");
      expect(out).toContain("ready for pre-bridge rollback: NO");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/api/admin/vpn-bridges/rollback-preflight");
      expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    });

    it("gate on with zero counts is not ready and names the gate as the reason", async () => {
      stubFetch([
        {
          body: {
            activeAssignments: { count: 0, nodeIds: [] },
            outstandingAgentUpdates: { count: 0, bridgeIds: [] },
            pendingJobs: { count: 0, byType: {} },
            jobsEnabled: true,
            readyForPreBridgeRollback: false,
            blockingReasons: ["BRIDGE_JOBS_ENABLED"],
          },
        },
      ]);
      const out = await run(["bridge-rollback-preflight"]);
      expect(out).toContain("ready for pre-bridge rollback: NO");
      expect(out).toContain("blocked by: BRIDGE_JOBS_ENABLED");
      expect(out).not.toContain("ready for pre-bridge rollback: yes");
    });

    it("says yes when nothing is left, and --json is the typed body", async () => {
      const ready = {
        activeAssignments: { count: 0, nodeIds: [] },
        outstandingAgentUpdates: { count: 0, bridgeIds: [] },
        pendingJobs: { count: 0, byType: {} },
        jobsEnabled: false,
        readyForPreBridgeRollback: true,
        blockingReasons: [],
      };
      stubFetch([{ body: ready }]);
      expect(await run(["bridge-rollback-preflight"])).toContain("ready for pre-bridge rollback: yes");
      stubFetch([{ body: ready }]);
      expect(JSON.parse(await run(["bridge-rollback-preflight", "--json"]))).toEqual(ready);
    });

    it("rejects a stray argument without calling the API", async () => {
      const calls = stubFetch([{ body: blocked }]);
      await expect(run(["bridge-rollback-preflight", "extra"])).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  it("bridge-add surfaces a duplicate address", async () => {
    stubFetch([{ status: 409, body: { error: "BRIDGE_IPV4_CONFLICT", message: "dup" } }]);
    await expect(
      run(["bridge-add", "--name=F", "--ipv4=198.51.100.7", "--confirm"]),
    ).rejects.toThrow(/BRIDGE_IPV4_CONFLICT: dup/);
  });

  it("bridge-delete rejects a non-UUID without calling the API", async () => {
    const calls = stubFetch([{ body: {} }]);
    await expect(run(["bridge-delete", "frankfurt", "--confirm"])).rejects.toThrow(/must be a UUID/);
    expect(calls).toHaveLength(0);
  });

  it("bridge-delete without --confirm deletes nothing; with it, surfaces BRIDGE_HAS_ROUTES", async () => {
    const calls = stubFetch([{ status: 409, body: { error: "BRIDGE_HAS_ROUTES", message: "has routes" } }]);
    expect(await run(["bridge-delete", BRIDGE])).toContain("Nothing was changed");
    expect(calls).toHaveLength(0);
    await expect(run(["bridge-delete", BRIDGE, "--confirm"])).rejects.toThrow(
      /BRIDGE_HAS_ROUTES: has routes\n.*bridge-route-release/,
    );
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("bridge-routes prints Direct, revision, drafts and retiring", async () => {
    stubFetch([
      {
        body: {
          nodeId: NODE,
          vpnEndpointRevision: 4,
          activeRoute: null,
          drafts: [{ id: ROUTE, bridgeId: BRIDGE, publicUdpPort: 41000, state: "draft", bridgeName: "Frankfurt", bridgePublicIpv4: "198.51.100.7", frpProxyName: `awg-route-${ROUTE}`, observedOnline: true, verificationResult: "success", verifiedAt: "t", verificationMethod: "probe" }],
          retiring: [],
        },
      },
    ]);
    const out = await run(["bridge-routes", NODE]);
    expect(out).toContain("revision 4");
    expect(out).toContain("Direct");
    expect(out).toContain("drafts (1)");
    expect(out).toContain("online");
    expect(out).toContain("verified");
  });

  it("bridge-routes prints the API's registration and AWG path evidence", async () => {
    stubFetch([
      {
        body: {
          nodeId: NODE,
          vpnEndpointRevision: 2,
          activeRoute: {
            id: ROUTE,
            bridgeId: BRIDGE,
            publicUdpPort: 41000,
            state: "active",
            bridgeName: "Frankfurt",
            bridgePublicIpv4: "198.51.100.7",
            registration: { status: "unknown", marker: null, observedAt: null },
            verification: { kind: "awg_path", status: "failed", checkedAt: "2026-11-13T10:00:00.000Z" },
          },
          drafts: [],
          retiring: [],
        },
      },
    ]);
    const out = await run(["bridge-routes", NODE]);
    expect(out).toContain("unknown");
    expect(out).toContain("awg path failed (checked 2026-11-13T10:00:00.000Z)");
  });

  it("bridge-route-prepare without --confirm reserves nothing", async () => {
    const calls = stubFetch([{ body: {} }]);
    expect(await run(["bridge-route-prepare", NODE, BRIDGE])).toContain("Nothing was changed");
    expect(calls).toHaveLength(0);
  });

  it("bridge-route-prepare --confirm posts the pairing and prints the reservation", async () => {
    const calls = stubFetch([
      { status: 201, body: { created: true, route: { id: ROUTE, bridgeId: BRIDGE, publicUdpPort: 41005, state: "draft", bridgePublicIpv4: "198.51.100.7", bridgeName: "Frankfurt", frpProxyName: `awg-route-${ROUTE}` } } },
    ]);
    const out = await run(["bridge-route-prepare", NODE, BRIDGE, "--port=41005", "--confirm"]);
    expect(calls[0]!.url).toContain(`/api/admin/nodes/${NODE}/vpn-bridge-routes`);
    expect(sentBody(calls[0]!)).toEqual({ bridgeId: BRIDGE, publicUdpPort: 41005 });
    expect(out).toContain("198.51.100.7");
    expect(out).toContain("41005");
    expect(out).toContain(`awg-route-${ROUTE}`);
  });

  it("bridge-route-prepare prints the route setup commands and keeps them in --json", async () => {
    const setupCommands = { install: "sudo sh install-frpc.sh --route-id r", dryRun: "sudo sh install-frpc.sh --route-id r --dry-run", remove: "sudo sh install-frpc.sh --route-id r --remove" };
    const route = { id: ROUTE, bridgeId: BRIDGE, publicUdpPort: 41005, state: "draft", frpProxyName: `awg-route-${ROUTE}`, setupCommands };
    stubFetch([{ status: 201, body: { created: true, route } }]);
    const out = await run(["bridge-route-prepare", NODE, BRIDGE, "--confirm"]);
    expect(out).toContain(`install: ${setupCommands.install}`);
    expect(out).toContain(`dryRun: ${setupCommands.dryRun}`);
    expect(out).toContain(`remove: ${setupCommands.remove}`);
    stubFetch([{ status: 201, body: { created: true, route } }]);
    const json = JSON.parse(await run(["bridge-route-prepare", NODE, BRIDGE, "--confirm", "--json"])) as { route: { setupCommands: unknown } };
    expect(json.route.setupCommands).toEqual(setupCommands);
  });

  it("bridge-route-prepare surfaces BRIDGE_NODE_NOT_AWG31", async () => {
    stubFetch([{ status: 409, body: { error: "BRIDGE_NODE_NOT_AWG31", message: "no awg3" } }]);
    await expect(run(["bridge-route-prepare", NODE, BRIDGE, "--confirm"])).rejects.toThrow(/BRIDGE_NODE_NOT_AWG31/);
  });

  it("bridge-route-activate without --confirm reads but never PATCHes", async () => {
    const calls = stubFetch([{ body: [bridge] }]);
    expect(await run(["bridge-route-activate", ROUTE])).toContain("Nothing was changed");
    expect(calls.every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("bridge-route-activate finds the node, reads the revision and PATCHes with it", async () => {
    const calls = stubFetch([
      { body: [bridge] },
      { body: { nodeId: NODE, vpnEndpointRevision: 7, activeRoute: null, drafts: [], retiring: [] } },
      { body: { id: NODE, vpnEndpoint: { changed: true, vpnEndpointRevision: 8, activeRoute: null } } },
    ]);
    const out = await run(["bridge-route-activate", ROUTE, "--confirm"]);
    expect(calls[1]!.url).toContain(`/api/admin/nodes/${NODE}/vpn-bridge-routes`);
    expect(calls[2]!.url).toContain(`/api/admin/nodes/${NODE}`);
    expect(calls[2]!.init?.method).toBe("PATCH");
    expect(sentBody(calls[2]!)).toEqual({
      vpnBridgeRouteId: ROUTE,
      expectedVpnEndpointRevision: 7,
    });
    expect(out).toContain("revision 8");
  });

  it("bridge-route-activate fails clearly for an unknown route and on a stale revision", async () => {
    stubFetch([{ body: [{ ...bridge, routes: [] }] }]);
    await expect(run(["bridge-route-activate", ROUTE, "--confirm"])).rejects.toThrow(/BRIDGE_ROUTE_NOT_FOUND/);
    stubFetch([
      { body: [bridge] },
      { body: { nodeId: NODE, vpnEndpointRevision: 7, activeRoute: null, drafts: [], retiring: [] } },
      { status: 409, body: { error: "BRIDGE_REVISION_CONFLICT", message: "stale" } },
    ]);
    await expect(run(["bridge-route-activate", ROUTE, "--confirm"])).rejects.toThrow(
      /BRIDGE_REVISION_CONFLICT: stale\n.*bridge-routes/,
    );
  });

  it("bridge-route-direct sends a null route with the current revision, only with --confirm", async () => {
    const calls = stubFetch([{ body: {} }]);
    expect(await run(["bridge-route-direct", NODE])).toContain("Nothing was changed");
    expect(calls).toHaveLength(0);
    const sent = stubFetch([
      { body: { nodeId: NODE, vpnEndpointRevision: 2, activeRoute: null, drafts: [], retiring: [] } },
      { body: { id: NODE, vpnEndpoint: { changed: false, vpnEndpointRevision: 2, activeRoute: null } } },
    ]);
    const out = await run(["bridge-route-direct", NODE, "--confirm"]);
    expect(sentBody(sent[1]!)).toEqual({
      vpnBridgeRouteId: null,
      expectedVpnEndpointRevision: 2,
    });
    expect(out).toContain("no change");
  });

  it("bridge-route-release needs --confirm and surfaces active / stale conflicts", async () => {
    const calls = stubFetch([{ body: {} }]);
    expect(await run(["bridge-route-release", ROUTE])).toContain("Nothing was changed");
    expect(calls).toHaveLength(0);
    const sent = stubFetch([{ body: { id: ROUTE, released: true, nodeId: NODE, bridgeId: BRIDGE, publicUdpPort: 41000 } }]);
    expect(await run(["bridge-route-release", ROUTE, "--confirm"])).toContain("released");
    expect(sent[0]!.url).toContain(`/api/admin/vpn-bridge-routes/${ROUTE}?confirmed=true`);
    expect(sent[0]!.init?.method).toBe("DELETE");
    for (const code of ["BRIDGE_ROUTE_ACTIVE", "BRIDGE_OBSERVATION_STALE"]) {
      stubFetch([{ status: 409, body: { error: code, message: "no" } }]);
      await expect(run(["bridge-route-release", ROUTE, "--confirm"])).rejects.toThrow(new RegExp(code));
    }
  });

  it("prototype names are unknown commands, not dispatched", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
        process.exitCode = undefined;
        await dispatch([name]);
        expect(process.exitCode).toBe(1);
      }
      expect(err).toHaveBeenCalledWith(expect.stringContaining("Unknown command: constructor"));
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("rejects space-separated value flags and surplus operands with no request", async () => {
    const calls = stubFetch([{ body: {} }]);
    await expect(
      run(["bridge-route-prepare", NODE, BRIDGE, "--port", "41005", "--confirm"]),
    ).rejects.toThrow(/--port=<value>/);
    await expect(
      run(["bridge-add", "--name=F", "--ipv4=198.51.100.7", "--udp-start", "42000", "--confirm"]),
    ).rejects.toThrow(/--udp-start=<value>/);
    await expect(
      run(["bridge-add", "--name=F", "--ipv4=198.51.100.7", "--control-port", "7000", "--confirm"]),
    ).rejects.toThrow(/--control-port=<value>/);
    await expect(run(["bridge-delete", BRIDGE, "extra", "--confirm"])).rejects.toThrow(/Unexpected argument/);
    await expect(run(["bridge-route-release", ROUTE, BRIDGE, "--confirm"])).rejects.toThrow(/Unexpected argument/);
    await expect(run(["bridges", "extra"])).rejects.toThrow(/Unexpected argument/);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-UUID targets for every command with no request", async () => {
    const calls = stubFetch([{ body: {} }]);
    for (const argv of [
      ["bridge-routes", "n1"],
      ["bridge-route-prepare", "n1", BRIDGE, "--confirm"],
      ["bridge-route-prepare", NODE, "b1", "--confirm"],
      ["bridge-route-activate", "r1", "--confirm"],
      ["bridge-route-direct", "n1", "--confirm"],
      ["bridge-route-release", "r1", "--confirm"],
    ]) {
      await expect(run(argv)).rejects.toThrow(/must be a UUID/);
    }
    expect(calls).toHaveLength(0);
  });

  it("--json is projected to typed fields", async () => {
    const leaky = { ...bridge, secretToken: "s3cr3t", setupCommands: { install: "i", dryRun: "d", remove: "r", token: "t" } };
    stubFetch([{ body: [leaky] }]);
    const out = await run(["bridges", "--json"]);
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain('"token"');
    expect((JSON.parse(out) as Array<{ setupCommands: unknown }>)[0]!.setupCommands).toEqual({ install: "i", dryRun: "d", remove: "r" });
    stubFetch([{ body: { nodeId: NODE, vpnEndpointRevision: 1, internal: "x", activeRoute: null, drafts: [{ id: ROUTE, bridgeId: BRIDGE, publicUdpPort: 1, state: "draft", observedRegistrationMarker: "m" }], retiring: [] } }]);
    const routes = await run(["bridge-routes", NODE, "--json"]);
    expect(routes).not.toContain("internal");
    expect(routes).not.toContain("observedRegistrationMarker");
  });
});

describe("bridge candidate validation commands", () => {
  const ROUTE = "44444444-4444-4444-8444-444444444444";
  const KEY = "55555555-5555-4555-8555-555555555555";
  let dir: string;

  /** A fetch stub that also serves raw bodies and response headers. */
  const stubRaw = (
    responses: Array<{ status?: number; body: string; headers?: Record<string, string> }>,
  ): Array<{ url: string; init?: RequestInit }> => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit) => {
        const index = calls.length;
        calls.push({ url: String(url), init });
        const response = responses[Math.min(index, responses.length - 1)]!;
        const status = response.status ?? 200;
        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: "",
          headers: new Headers(response.headers ?? {}),
          text: () => Promise.resolve(response.body),
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(response.body).buffer),
        } as unknown as Response);
      }),
    );
    return calls;
  };

  const runWithStderr = async (argv: string[]) => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    });
    try {
      return { out: await run(argv), err: errors.join("\n") };
    } finally {
      errorSpy.mockRestore();
    }
  };

  beforeEach(async () => {
    process.env.PANEL_ADMIN_EMAIL = "cli-test@example.com";
    dir = await mkdtemp(join(tmpdir(), "bridge-test-config-"));
  });
  afterEach(async () => {
    delete process.env.PANEL_ADMIN_EMAIL;
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("bridge-route-test-config saves a new 0600 file and prints the marker, never the config", async () => {
    const out = join(dir, "test.vpn");
    const calls = stubRaw([
      {
        body: "vpn://secret-config",
        headers: { "x-bridge-registration-marker": "client-1%2006-13%2010%3A20%3A30" },
      },
    ]);
    const { out: printed } = await runWithStderr([
      "bridge-route-test-config",
      ROUTE,
      `--key=${KEY}`,
      `--out=${out}`,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/api/admin/vpn-bridge-routes/${ROUTE}/test-config?keyId=${KEY}`);
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(await readFile(out, "utf8")).toBe("vpn://secret-config");
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(printed).not.toContain("secret-config");
    expect(printed).toContain("registration marker: client-1 06-13 10:20:30");
    expect(printed).toContain(
      `bridge-route-verify ${ROUTE} --operator-verified --registration='client-1 06-13 10:20:30' --confirm`,
    );
  });

  it("bridge-route-test-config warns when no registration was observed", async () => {
    stubRaw([{ body: "vpn://secret-config" }]);
    const { out: printed, err } = await runWithStderr([
      "bridge-route-test-config",
      ROUTE,
      `--key=${KEY}`,
      `--out=${join(dir, "test.vpn")}`,
    ]);
    expect(printed).not.toContain("registration marker:");
    expect(err).toContain("no frps registration has been observed");
  });

  it("bridge-route-test-config refuses to overwrite an existing file and sends nothing", async () => {
    const out = join(dir, "existing.vpn");
    await writeFile(out, "keep me");
    const calls = stubRaw([{ body: "vpn://secret-config" }]);
    await expect(
      run(["bridge-route-test-config", ROUTE, `--key=${KEY}`, `--out=${out}`]),
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(calls).toHaveLength(0);
    expect(await readFile(out, "utf8")).toBe("keep me");
  });

  it("bridge-route-test-config leaves no file behind when the API refuses", async () => {
    const out = join(dir, "refused.vpn");
    stubRaw([
      {
        status: 403,
        body: JSON.stringify({ error: "BRIDGE_TEST_KEY_WRONG_NODE", message: "wrong node" }),
      },
    ]);
    await expect(
      run(["bridge-route-test-config", ROUTE, `--key=${KEY}`, `--out=${out}`]),
    ).rejects.toThrow(/BRIDGE_TEST_KEY_WRONG_NODE: wrong node\n.*route's VPN node/);
    await expect(stat(out)).rejects.toThrow();
  });

  it("bridge-route-test-config validates its arguments before any request", async () => {
    const calls = stubRaw([{ body: "" }]);
    const out = `--out=${join(dir, "x.vpn")}`;
    await expect(run(["bridge-route-test-config", "r1", `--key=${KEY}`, out])).rejects.toThrow(/must be a UUID/);
    await expect(run(["bridge-route-test-config", ROUTE, "--key=k1", out])).rejects.toThrow(/must be a UUID/);
    await expect(run(["bridge-route-test-config", ROUTE, `--key=${KEY}`])).rejects.toThrow(/Usage/);
    await expect(run(["bridge-route-test-config", ROUTE, "--key", KEY, out])).rejects.toThrow(/--key=<value>/);
    expect(calls).toHaveLength(0);
  });

  it("bridge-route-verify without --confirm submits nothing", async () => {
    const calls = stubRaw([{ body: "{}" }]);
    expect(await run(["bridge-route-verify", ROUTE])).toContain("Nothing was changed");
    expect(
      await run(["bridge-route-verify", ROUTE, "--operator-verified", "--registration=m-1"]),
    ).toContain("Nothing was changed");
    expect(calls).toHaveLength(0);
  });

  it("bridge-route-verify --confirm queues the probe check", async () => {
    const calls = stubRaw([
      {
        status: 202,
        body: JSON.stringify({
          method: "probe",
          routeId: ROUTE,
          jobId: "66666666-6666-4666-8666-666666666666",
          queued: true,
          status: "queued",
          runId: null,
          registrationMarker: "m-1",
        }),
      },
    ]);
    const out = await run(["bridge-route-verify", ROUTE, "--confirm"]);
    expect(calls[0]!.url).toContain(`/api/admin/vpn-bridge-routes/${ROUTE}/verify`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(sentBody(calls[0]!)).toEqual({ method: "probe" });
    expect(out).toContain("probe check queued (job 66666666-6666-4666-8666-666666666666) for registration m-1");
  });

  it("bridge-route-verify reports a check whose run is still out", async () => {
    stubRaw([
      {
        status: 202,
        body: JSON.stringify({
          method: "probe",
          routeId: ROUTE,
          jobId: null,
          queued: false,
          status: "running",
          runId: "77777777-7777-4777-8777-777777777777",
          registrationMarker: "m-1",
        }),
      },
    ]);
    expect(await run(["bridge-route-verify", ROUTE, "--confirm"])).toContain(
      "probe check already running (run 77777777-7777-4777-8777-777777777777) for registration m-1",
    );
    stubRaw([
      {
        status: 409,
        body: JSON.stringify({ error: "BRIDGE_CHECK_PENDING", message: "older check pending" }),
      },
    ]);
    await expect(run(["bridge-route-verify", ROUTE, "--confirm"])).rejects.toThrow(
      /BRIDGE_CHECK_PENDING: older check pending\n.*ask again/,
    );
  });

  it("bridge-route-verify --operator-verified sends the tested marker and the attestation", async () => {
    const calls = stubRaw([
      {
        body: JSON.stringify({
          method: "operator",
          routeId: ROUTE,
          route: {
            id: ROUTE,
            bridgeId: "33333333-3333-4333-8333-333333333333",
            publicUdpPort: 41000,
            state: "draft",
            verificationResult: "success",
            verificationMethod: "operator",
            verifiedAt: "2026-11-13T10:00:00.000Z",
          },
        }),
      },
    ]);
    const out = await run([
      "bridge-route-verify",
      ROUTE,
      "--operator-verified",
      "--registration=client-1 06-13",
      "--confirm",
    ]);
    expect(sentBody(calls[0]!)).toEqual({
      method: "operator",
      registrationMarker: "client-1 06-13",
      confirmHandshakeAndHttp: true,
    });
    expect(out).toContain("verified 2026-11-13T10:00:00.000Z (operator)");
  });

  it("bridge-route-verify rejects incomplete operator evidence without a request", async () => {
    const calls = stubRaw([{ body: "{}" }]);
    await expect(run(["bridge-route-verify", ROUTE, "--operator-verified", "--confirm"])).rejects.toThrow(
      /needs --registration/,
    );
    await expect(run(["bridge-route-verify", ROUTE, "--registration=m-1", "--confirm"])).rejects.toThrow(
      /only used with --operator-verified/,
    );
    await expect(
      run(["bridge-route-verify", ROUTE, "--operator-verified", "--registration", "m-1", "--confirm"]),
    ).rejects.toThrow(/--registration=<value>/);
    await expect(run(["bridge-route-verify", "r1", "--confirm"])).rejects.toThrow(/must be a UUID/);
    expect(calls).toHaveLength(0);
  });

  it("bridge-route-verify explains an unavailable probe", async () => {
    stubRaw([
      {
        status: 409,
        body: JSON.stringify({ error: "BRIDGE_UNSUPPORTED_CAPABILITY", message: "no capable probe" }),
      },
    ]);
    await expect(run(["bridge-route-verify", ROUTE, "--confirm"])).rejects.toThrow(
      /BRIDGE_UNSUPPORTED_CAPABILITY: no capable probe\n.*--operator-verified/,
    );
  });
});
