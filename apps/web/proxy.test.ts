import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { createProxy } from "./proxy";
import { SESSION_COOKIE, signSession } from "@/lib/session";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "portal-audience";
const KID = "test-key";

let signingKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeEach(async () => {
  const keyPair = await generateKeyPair("RS256");
  signingKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256" }] });

  vi.stubEnv("PANEL_IDENTITY_SECRET", "test-identity-secret");
  vi.stubEnv("CF_ACCESS_ISSUER", ISSUER);
  vi.stubEnv("CF_ACCESS_AUDIENCE", AUDIENCE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Builds a Cloudflare Access-shaped assertion. Signs with `signingKey` (whose
// public half is in `jwks`) unless a different key is supplied, which is how
// the "wrongly signed" test produces a syntactically valid token `jwks`
// cannot verify.
const signAssertion = (overrides: {
  issuer?: string;
  audience?: string;
  expired?: boolean;
  key?: CryptoKey;
} = {}) =>
  new SignJWT({ email: "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("cf-user")
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expired ? "-1m" : "5m")
    .sign(overrides.key ?? signingKey);

const requestWith = (init: { header?: string; cookie?: string }) =>
  new NextRequest("https://panel.test/dashboard", {
    headers: {
      ...(init.header ? { "cf-access-jwt-assertion": init.header } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });

// NextResponse.next() stamps this header; NextResponse.redirect() does not.
const passedThrough = (response: Response) =>
  response.headers.get("x-middleware-next") === "1";

const redirectsToLogin = (response: Response) =>
  new URL(response.headers.get("location") ?? "", "https://panel.test").pathname ===
  "/login";

describe("proxy — Cloudflare Access assertion", () => {
  it("passes a request with a valid assertion (right issuer, audience, signature)", async () => {
    const proxy = createProxy({ jwks });
    const token = await signAssertion();

    const response = await proxy(requestWith({ header: token }));

    expect(passedThrough(response)).toBe(true);
  });

  it("does not pass a syntactically valid but wrongly signed assertion", async () => {
    const otherKeyPair = await generateKeyPair("RS256");
    const proxy = createProxy({ jwks });
    const token = await signAssertion({ key: otherKeyPair.privateKey });

    const response = await proxy(requestWith({ header: token }));

    expect(redirectsToLogin(response)).toBe(true);
  });

  it("does not pass an assertion with the wrong audience", async () => {
    const proxy = createProxy({ jwks });
    const token = await signAssertion({ audience: "someone-elses-app" });

    const response = await proxy(requestWith({ header: token }));

    expect(redirectsToLogin(response)).toBe(true);
  });

  it("does not pass an expired assertion", async () => {
    const proxy = createProxy({ jwks });
    const token = await signAssertion({ expired: true });

    const response = await proxy(requestWith({ header: token }));

    expect(redirectsToLogin(response)).toBe(true);
  });

  it("does not admit any assertion on its own when CF_ACCESS_ISSUER/AUDIENCE are unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("PANEL_IDENTITY_SECRET", "test-identity-secret");
    const proxy = createProxy({ jwks });
    const token = await signAssertion();

    const response = await proxy(requestWith({ header: token }));

    expect(redirectsToLogin(response)).toBe(true);
  });

  it("still passes a valid panel_session cookie with no assertion at all", async () => {
    const proxy = createProxy({ jwks });
    const cookieToken = await signSession({
      email: "person@example.com",
      sub: "person@example.com",
      provider: "google",
    });

    const response = await proxy(
      requestWith({ cookie: `${SESSION_COOKIE}=${cookieToken}` }),
    );

    expect(passedThrough(response)).toBe(true);
  });

  it("gates nothing when PANEL_IDENTITY_SECRET is unset, even with no assertion or cookie", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CF_ACCESS_ISSUER", ISSUER);
    vi.stubEnv("CF_ACCESS_AUDIENCE", AUDIENCE);
    const proxy = createProxy({ jwks });

    const response = await proxy(requestWith({}));

    expect(passedThrough(response)).toBe(true);
  });

  it("redirects instead of throwing when the JWKS lookup fails", async () => {
    const failingJwks: JWTVerifyGetKey = () =>
      Promise.reject(new Error("network unreachable"));
    const proxy = createProxy({ jwks: failingJwks });
    const token = await signAssertion();

    const response = await proxy(requestWith({ header: token }));

    expect(redirectsToLogin(response)).toBe(true);
  });
});
