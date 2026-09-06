import { afterEach, describe, expect, it, vi } from "vitest";

import { createCloudflareAccessClient } from "./cloudflareApi.js";

const CONFIG = {
  accountId: "acc-1",
  appId: "app-1",
  policyId: "pol-1",
  apiToken: "token-1",
};

const BASE = "https://api.cloudflare.com/client/v4";
const APP_SCOPED = `${BASE}/accounts/acc-1/access/apps/app-1/policies/pol-1`;
const ACCOUNT_SCOPED = `${BASE}/accounts/acc-1/access/policies/pol-1`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const policyBody = (extra: Record<string, unknown> = {}) => ({
  success: true,
  errors: [],
  result: {
    id: "pol-1",
    name: "panel allow",
    decision: "allow",
    include: [{ email: { email: "a@example.com" } }],
    exclude: [],
    require: [],
    ...extra,
  },
});

const notFound = () =>
  json(
    {
      success: false,
      errors: [{ code: 12083, message: "access.api.error.policy_not_found" }],
    },
    404,
  );

/** A `fetch` stub whose recorded calls stay typed, so assertions can read them. */
const fetchStub = (reply: (url: string) => Response) =>
  vi.fn((url: string, _init?: RequestInit) => Promise.resolve(reply(url)));

type FetchStub = ReturnType<typeof fetchStub>;

const requestsTo = (fetchMock: FetchStub, method: string): string[] =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === method).map(([url]) => url);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCloudflareAccessClient", () => {
  it("reports whether the policy is reusable", async () => {
    const fetchMock = fetchStub(() => json(policyBody({ reusable: true })));
    vi.stubGlobal("fetch", fetchMock);

    const policy = await createCloudflareAccessClient(CONFIG).getPolicy();

    expect(policy.reusable).toBe(true);
  });

  it("updates an app-scoped policy through the application endpoint", async () => {
    const fetchMock = fetchStub(() => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await createCloudflareAccessClient(CONFIG).updatePolicy({
      id: "pol-1",
      name: "panel allow",
      decision: "allow",
      include: [],
      reusable: false,
    });

    expect(requestsTo(fetchMock, "PUT")).toEqual([APP_SCOPED]);
  });

  it("updates a reusable policy through the account endpoint", async () => {
    // Cloudflare answers the application endpoint with
    // "can not update reusable policies through this endpoint" (400), and the
    // dashboard now creates reusable policies whatever an operator clicks.
    const fetchMock = fetchStub(() => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await createCloudflareAccessClient(CONFIG).updatePolicy({
      id: "pol-1",
      name: "panel allow",
      decision: "allow",
      include: [],
      reusable: true,
    });

    expect(requestsTo(fetchMock, "PUT")).toEqual([ACCOUNT_SCOPED]);
  });

  it("sends the same document to either endpoint", async () => {
    const fetchMock = fetchStub(() => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await createCloudflareAccessClient(CONFIG).updatePolicy({
      id: "pol-1",
      name: "panel allow",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }],
      exclude: [{ email: { email: "b@example.com" } }],
      require: [],
      reusable: true,
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    // `id` and `reusable` are stripped (see the next two tests); everything
    // else modeled by the type is echoed back unchanged.
    expect(JSON.parse(body as string)).toEqual({
      name: "panel allow",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }],
      exclude: [{ email: { email: "b@example.com" } }],
      require: [],
    });
  });

  it("writes back a policy carrying fields it does not model, unchanged, with only include updated", async () => {
    // This is the actual production shape: accessReconcile.ts reads a policy
    // via getPolicy(), which casts the raw Cloudflare JSON straight into
    // CfAccessPolicy, then spreads it back with a new `include`. Any field an
    // admin set by hand in the dashboard — session_duration, approval_required,
    // precedence, or something this client has genuinely never heard of —
    // must survive that round-trip, or it gets silently reset to Cloudflare's
    // default on every sync.
    const fetchMock = fetchStub(() => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await createCloudflareAccessClient(CONFIG).updatePolicy({
      id: "pol-1",
      name: "panel allow",
      decision: "allow",
      include: [{ email: { email: "new@example.com" } }],
      exclude: [],
      require: [],
      reusable: false,
      session_duration: "24h",
      approval_required: true,
      precedence: 3,
      some_field_this_client_has_never_heard_of: { nested: ["value"] },
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(body as string)).toEqual({
      name: "panel allow",
      decision: "allow",
      include: [{ email: { email: "new@example.com" } }],
      exclude: [],
      require: [],
      session_duration: "24h",
      approval_required: true,
      precedence: 3,
      some_field_this_client_has_never_heard_of: { nested: ["value"] },
    });
  });

  it("never sends the read-only fields it strips from the read document", async () => {
    const fetchMock = fetchStub(() => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await createCloudflareAccessClient(CONFIG).updatePolicy({
      id: "pol-1",
      uid: "uid-1",
      name: "panel allow",
      decision: "allow",
      include: [],
      exclude: [],
      require: [],
      reusable: false,
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2020-06-01T00:00:00Z",
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    const sent = JSON.parse(body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("id");
    expect(sent).not.toHaveProperty("uid");
    expect(sent).not.toHaveProperty("reusable");
    expect(sent).not.toHaveProperty("created_at");
    expect(sent).not.toHaveProperty("updated_at");
  });

  it("says so when the policy exists but is not attached to the application", async () => {
    // A reusable policy the operator created but never attached gates nothing.
    // Managing its allowlist would tell an admin access is controlled when it
    // is not, so this must fail loudly rather than quietly succeed.
    const fetchMock = fetchStub((url) =>
      url === APP_SCOPED ? notFound() : json(policyBody({ reusable: true })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCloudflareAccessClient(CONFIG).getPolicy()).rejects.toThrow(
      /not attached to Access application app-1/,
    );
  });

  it("reports a policy that exists nowhere as a plain read failure", async () => {
    const fetchMock = fetchStub(() => notFound());
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCloudflareAccessClient(CONFIG).getPolicy()).rejects.toThrow(
      /get policy failed \(404\)/,
    );
  });
});
