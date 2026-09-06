import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { createProxy, createResilientJwks } from "./proxy";
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

// `createResilientJwks` is the module-scope cache `resolveJwks` builds on top
// of for the real (network) path. Every test above injects a pre-verified
// `jwks` and never exercises this code at all, so it gets its own coverage
// here with an injected `fetchJwks` and clock — modeled directly on
// `apps/control-api/src/resilientJwks.test.ts`, which covers the same shape
// for the control-api's copy.
describe("createResilientJwks — JWKS cache", () => {
  const jwksKeyMaterial = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    return {
      privateKey,
      kid,
      document: { keys: [{ ...jwk, kid, alg: "RS256" }] } as JSONWebKeySet,
    };
  };

  const jwksTokenFor = (material: Awaited<ReturnType<typeof jwksKeyMaterial>>) =>
    new SignJWT({ email: "person@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: material.kid })
      .setSubject("cf-user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(material.privateKey);

  const verifyWithJwks = (getKey: JWTVerifyGetKey, token: string) =>
    jwtVerify(token, getKey, { issuer: ISSUER, audience: AUDIENCE });

  it("fetches once and reuses the cached document within the cache window", async () => {
    const material = await jwksKeyMaterial("k1");
    const fetchJwks = vi.fn(() => Promise.resolve(material.document));
    let now = 1_000_000;
    const getKey = createResilientJwks({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await jwksTokenFor(material);

    await verifyWithJwks(getKey, token);
    now += 599_000;
    await verifyWithJwks(getKey, token);

    // A key set refetched on every lookup turns any upstream hiccup into
    // every page navigation failing, which is exactly the outage this cache
    // exists to prevent.
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("attempts a refresh once the cache window has elapsed", async () => {
    const material = await jwksKeyMaterial("k1");
    const fetchJwks = vi.fn(() => Promise.resolve(material.document));
    let now = 1_000_000;
    const getKey = createResilientJwks({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await jwksTokenFor(material);

    await verifyWithJwks(getKey, token);
    now += 600_001;
    await verifyWithJwks(getKey, token);

    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good document when a refresh fails, inside the stale window", async () => {
    const material = await jwksKeyMaterial("k1");
    const fetchJwks = vi
      .fn<() => Promise<JSONWebKeySet>>()
      .mockResolvedValueOnce(material.document)
      .mockRejectedValue(new Error("ETIMEDOUT"));
    let now = 1_000_000;
    const getKey = createResilientJwks({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await jwksTokenFor(material);
    await verifyWithJwks(getKey, token);

    now += 600_001;
    await expect(verifyWithJwks(getKey, token)).resolves.toBeDefined();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("stops verifying past the stale window when refresh keeps failing, and the page gate redirects rather than 500s", async () => {
    const material = await jwksKeyMaterial("k1");
    const fetchJwks = vi
      .fn<() => Promise<JSONWebKeySet>>()
      .mockResolvedValueOnce(material.document)
      .mockRejectedValue(new Error("ETIMEDOUT"));
    let now = 1_000_000;
    const getKey = createResilientJwks({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 3_600_000,
      now: () => now,
    });

    // Warm the cache with one good document.
    await verifyWithJwks(getKey, await jwksTokenFor(material));

    // Past the stale window: the cached document is no longer trusted, and
    // the only refresh available keeps failing, so this lookup must fail...
    now += 3_600_001;
    await expect(verifyWithJwks(getKey, await jwksTokenFor(material))).rejects.toThrow();

    // ...and driving that failure through the actual page gate must produce
    // a redirect, never an unhandled 500 at a real user.
    const proxy = createProxy({ jwks: getKey });
    const response = await proxy(requestWith({ header: await signAssertion() }));
    expect(redirectsToLogin(response)).toBe(true);
  });

  it("collapses a burst of concurrent lookups on an expired cache into exactly one fetch", async () => {
    const material = await jwksKeyMaterial("k1");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchJwks = vi.fn(async () => {
      await gate;
      return material.document;
    });
    const getKey = createResilientJwks({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => 1_000_000,
    });
    const token = await jwksTokenFor(material);

    const verifications = [
      verifyWithJwks(getKey, token),
      verifyWithJwks(getKey, token),
      verifyWithJwks(getKey, token),
    ];
    release?.();
    await Promise.all(verifications);

    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});
