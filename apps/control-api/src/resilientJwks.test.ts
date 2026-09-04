import { describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from "jose";

import { createResilientJWKSet } from "./resilientJwks.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "portal-audience";

/** A key pair plus the JWKS document a provider would publish for it. */
const keyMaterial = async (kid: string) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    kid,
    document: { keys: [{ ...jwk, kid, alg: "RS256" }] },
  };
};

const tokenFor = (material: Awaited<ReturnType<typeof keyMaterial>>) =>
  new SignJWT({ email: "employee@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: material.kid })
    .setSubject("cloudflare-user-id")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(material.privateKey);

const verifyWith = async (
  getKey: ReturnType<typeof createResilientJWKSet>,
  token: string,
) => jwtVerify(token, getKey, { issuer: ISSUER, audience: AUDIENCE });

describe("createResilientJWKSet", () => {
  it("fetches once and serves the cached document within its freshness window", async () => {
    const material = await keyMaterial("k1");
    const fetchJwks = vi.fn(() => Promise.resolve(material.document));
    let now = 1_000_000;
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await tokenFor(material);

    await verifyWith(getKey, token);
    now += 599_000;
    await verifyWith(getKey, token);

    // A key set refetched per request turns every upstream hiccup into an
    // outage of the whole API, which is exactly what happened.
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("refetches once the document is no longer fresh", async () => {
    const material = await keyMaterial("k1");
    const fetchJwks = vi.fn(() => Promise.resolve(material.document));
    let now = 1_000_000;
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await tokenFor(material);

    await verifyWith(getKey, token);
    now += 600_001;
    await verifyWith(getKey, token);

    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good document when the refresh fails", async () => {
    // The whole point. A two-minute network blip to the identity provider must
    // not turn every /api request into a 500: the signing keys did not change,
    // only our ability to re-download them did.
    const material = await keyMaterial("k1");
    const fetchJwks = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(material.document)
      .mockRejectedValue(new Error("ETIMEDOUT"));
    let now = 1_000_000;
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });
    const token = await tokenFor(material);
    await verifyWith(getKey, token);

    now += 600_001;
    await expect(verifyWith(getKey, token)).resolves.toBeDefined();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("stops serving a stale document once it is genuinely too old", async () => {
    // Serving a cached key set forever would mean a revoked or rotated signing
    // key kept working indefinitely. The stale window is a bounded grace
    // period, not a substitute for reaching the provider.
    const material = await keyMaterial("k1");
    const fetchJwks = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(material.document)
      .mockRejectedValue(new Error("ETIMEDOUT"));
    let now = 1_000_000;
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 3_600_000,
      now: () => now,
    });
    const token = await tokenFor(material);
    await verifyWith(getKey, token);

    now += 3_600_001;
    await expect(verifyWith(getKey, token)).rejects.toThrow();
  });

  it("picks up a rotated key once the provider is reachable again", async () => {
    const first = await keyMaterial("k1");
    const second = await keyMaterial("k2");
    const fetchJwks = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(first.document)
      .mockResolvedValueOnce(second.document);
    let now = 1_000_000;
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => now,
    });

    await verifyWith(getKey, await tokenFor(first));
    now += 600_001;
    await expect(verifyWith(getKey, await tokenFor(second))).resolves.toBeDefined();
  });

  it("surfaces the failure when it has never had a document at all", async () => {
    // A cold start against an unreachable provider genuinely cannot verify
    // anything, and must say so rather than pretend.
    const fetchJwks = vi.fn(() => Promise.reject(new Error("ETIMEDOUT")));
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => 1_000_000,
    });
    const material = await keyMaterial("k1");

    await expect(verifyWith(getKey, await tokenFor(material))).rejects.toThrow();
  });

  it("collapses concurrent refreshes into one request", async () => {
    // Every API request goes through this. A burst arriving the moment the
    // cache expires must not become a burst of identical outbound fetches at
    // the provider that is already struggling.
    const material = await keyMaterial("k1");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchJwks = vi.fn(async () => {
      await gate;
      return material.document;
    });
    const getKey = createResilientJWKSet({
      fetchJwks,
      cacheMaxAgeMs: 600_000,
      staleMaxAgeMs: 86_400_000,
      now: () => 1_000_000,
    });
    const token = await tokenFor(material);

    const verifications = [
      verifyWith(getKey, token),
      verifyWith(getKey, token),
      verifyWith(getKey, token),
    ];
    release?.();
    await Promise.all(verifications);

    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});
