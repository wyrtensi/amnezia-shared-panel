import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { signPanelIdentity, firstBootstrapAdmin, authHeaders } from "./identity.js";

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Decode the email claim from a minted x-panel-identity header. */
const emailOf = (headers: Record<string, string>): unknown => {
  const token = headers["x-panel-identity"];
  if (!token) throw new Error("no x-panel-identity header");
  const payload = token.split(".")[1];
  if (!payload) throw new Error("malformed token");
  return decode(payload).email;
};

describe("signPanelIdentity", () => {
  it("produces an HS256 JWT with the panel-session claims", () => {
    const token = signPanelIdentity("s3cret", "Admin@Example.com", 1000);
    const [header, payload] = token.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.email).toBe("admin@example.com");
    expect(claims.sub).toBe("admin@example.com");
    expect(claims.provider).toBe("cli");
    expect(claims.iss).toBe("amnezia-panel-web");
    expect(claims.aud).toBe("amnezia-panel-api");
    expect(claims.iat).toBe(1000);
    expect(claims.exp).toBe(1300);
  });

  it("signs with HMAC-SHA256 over header.payload (verifiable with the secret)", () => {
    const token = signPanelIdentity("top-secret", "a@b.io", 42);
    const [header, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const expected = createHmac("sha256", "top-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
    // A different secret must not verify.
    const wrong = createHmac("sha256", "other")
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).not.toBe(wrong);
  });
});

describe("firstBootstrapAdmin", () => {
  const saved = process.env.BOOTSTRAP_ADMIN_EMAILS;
  afterEach(() => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = saved;
  });
  it("returns the first, lower-cased", () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = " First@X.io , second@x.io ";
    expect(firstBootstrapAdmin()).toBe("first@x.io");
  });
  it("is undefined when unset", () => {
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;
    expect(firstBootstrapAdmin()).toBeUndefined();
  });
});

describe("authHeaders", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const key of [
      "PANEL_IDENTITY_SECRET",
      "CLI_ADMIN_EMAIL",
      "BOOTSTRAP_ADMIN_EMAILS",
      "CF_ACCESS_CLIENT_ID",
      "CF_ACCESS_CLIENT_SECRET",
      "PANEL_ADMIN_EMAIL",
    ]) {
      delete process.env[key];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers a minted panel-session token, acting as the first bootstrap admin", () => {
    process.env.PANEL_IDENTITY_SECRET = "s";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "a@x.io, b@x.io";
    const headers = authHeaders();
    expect(Object.keys(headers)).toEqual(["x-panel-identity"]);
    expect(emailOf(headers)).toBe("a@x.io");
  });

  it("lets CLI_ADMIN_EMAIL override the identity", () => {
    process.env.PANEL_IDENTITY_SECRET = "s";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "a@x.io";
    process.env.CLI_ADMIN_EMAIL = "Ops@x.io";
    expect(emailOf(authHeaders())).toBe("ops@x.io");
  });

  it("falls back to the Cloudflare Access service token", () => {
    process.env.CF_ACCESS_CLIENT_ID = "id";
    process.env.CF_ACCESS_CLIENT_SECRET = "secret";
    expect(authHeaders()).toEqual({
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    });
  });

  it("falls back to the dev header", () => {
    process.env.PANEL_ADMIN_EMAIL = "dev@x.io";
    expect(authHeaders()).toEqual({ "x-dev-user-email": "dev@x.io" });
  });

  it("throws when nothing is configured", () => {
    expect(() => authHeaders()).toThrow(/No credentials/);
  });
});
