import { describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { createCloudflareAccessAdapter } from "./cloudflareAccess.js";

describe("Cloudflare Access identity adapter", () => {
  it("verifies signature, issuer, audience, expiry, and normalizes email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const issuer = "https://example.cloudflareaccess.com";
    const token = await new SignJWT({ email: "Employee@Example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("cloudflare-user-id")
      .setIssuer(issuer)
      .setAudience("portal-audience")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const adapter = createCloudflareAccessAdapter({
      issuer,
      audience: "portal-audience",
      jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }),
    });

    await expect(
      adapter({ headers: { "cf-access-jwt-assertion": token } } as never),
    ).resolves.toEqual({
      provider: "cloudflare-access",
      subject: "cloudflare-user-id",
      email: "employee@example.com",
    });
  });

  it("rejects a token for another audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const issuer = "https://example.cloudflareaccess.com";
    const token = await new SignJWT({ email: "employee@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("cloudflare-user-id")
      .setIssuer(issuer)
      .setAudience("wrong-audience")
      .setExpirationTime("5m")
      .sign(privateKey);
    const adapter = createCloudflareAccessAdapter({
      issuer,
      audience: "portal-audience",
      jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }),
    });

    await expect(
      adapter({ headers: { "cf-access-jwt-assertion": token } } as never),
    ).rejects.toThrow();
  });
});
