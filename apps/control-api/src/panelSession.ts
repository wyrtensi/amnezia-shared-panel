import { jwtVerify } from "jose";
import type { IdentityAdapter } from "./app.js";
import { ApiError } from "./service.js";

export const PANEL_SESSION_ISSUER = "amnezia-panel-web";
export const PANEL_SESSION_AUDIENCE = "amnezia-panel-api";

/**
 * Identity from the web app's OWN session (server-side Google login), for users
 * who reach the panel directly instead of through Cloudflare Access — e.g. when
 * Cloudflare is not reachable for them. The web app is the auth boundary: after
 * a successful login it signs a short-lived HS256 token with a secret shared
 * with this API and forwards it as `x-panel-identity`; here we verify it.
 *
 * Extensible by design: whatever method the web used (google today) is carried
 * in the `provider` claim, so new login methods need no change here.
 */
export const createPanelSessionAdapter = ({
  secret,
}: {
  secret: string;
}): IdentityAdapter => {
  const key = new TextEncoder().encode(secret);
  return async (request) => {
    const raw = request.headers["x-panel-identity"];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) return null;
    const { payload } = await jwtVerify(token, key, {
      issuer: PANEL_SESSION_ISSUER,
      audience: PANEL_SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
    const email =
      typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const provider =
      typeof payload.provider === "string" && payload.provider
        ? payload.provider
        : "google";
    if (!email) {
      throw new ApiError(
        401,
        "Panel session is missing an email claim",
        "INVALID_IDENTITY_TOKEN",
      );
    }
    const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : email;
    return { provider, subject, email };
  };
};

/**
 * Try each identity adapter in order and return the first non-null claim. An
 * adapter that finds its token but rejects it (throws) stops the chain — an
 * invalid token is a failed auth, not a fall-through.
 */
export const chainIdentityAdapters =
  (adapters: IdentityAdapter[]): IdentityAdapter =>
  async (request) => {
    for (const adapter of adapters) {
      const claim = await adapter(request);
      if (claim) return claim;
    }
    return null;
  };
