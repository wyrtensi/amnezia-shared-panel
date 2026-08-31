import { SignJWT } from "jose";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  PANEL_SESSION_AUDIENCE,
  PANEL_SESSION_ISSUER,
  chainIdentityAdapters,
  createPanelSessionAdapter,
} from "./panelSession.js";

const secret = "test-secret-at-least-thirty-two-bytes-long";
const key = new TextEncoder().encode(secret);

const sign = (
  claims: { email?: string; provider?: string; sub?: string },
  signingKey = key,
): Promise<string> => {
  let jwt = new SignJWT({ email: claims.email, provider: claims.provider })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(PANEL_SESSION_ISSUER)
    .setAudience(PANEL_SESSION_AUDIENCE)
    .setExpirationTime("1h");
  if (claims.sub) jwt = jwt.setSubject(claims.sub);
  return jwt.sign(signingKey);
};

const req = (headers: Record<string, string>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

describe("createPanelSessionAdapter", () => {
  it("returns null when the header is absent", async () => {
    const adapter = createPanelSessionAdapter({ secret });
    expect(await adapter(req({}))).toBeNull();
  });

  it("verifies a signed token into a normalised claim", async () => {
    const adapter = createPanelSessionAdapter({ secret });
    const token = await sign({ email: "A@X.io", provider: "google", sub: "g-123" });
    expect(await adapter(req({ "x-panel-identity": token }))).toEqual({
      provider: "google",
      subject: "g-123",
      email: "a@x.io",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const adapter = createPanelSessionAdapter({ secret });
    const forged = await sign(
      { email: "a@x.io", sub: "g-1" },
      new TextEncoder().encode("a-totally-different-secret-value-here"),
    );
    await expect(
      adapter(req({ "x-panel-identity": forged })),
    ).rejects.toThrow();
  });
});

describe("chainIdentityAdapters", () => {
  it("returns the first non-null claim and skips the rest", async () => {
    const claim = { provider: "x", subject: "s", email: "e@x.io" };
    const chained = chainIdentityAdapters([
      () => Promise.resolve(null),
      () => Promise.resolve(claim),
      () => {
        throw new Error("should not be reached");
      },
    ]);
    expect(await chained(req({}))).toEqual(claim);
  });
});
