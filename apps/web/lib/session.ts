import { SignJWT, jwtVerify } from "jose";

// Must match apps/control-api/src/panelSession.ts.
const ISSUER = "amnezia-panel-web";
const AUDIENCE = "amnezia-panel-api";
export const SESSION_COOKIE = "panel_session";
export const STATE_COOKIE = "panel_oauth_state";
const TTL_SECONDS = 7 * 24 * 60 * 60; // 1 week

export type SessionClaims = { email: string; sub: string; provider: string };

const secretKey = (): Uint8Array => {
  const secret = process.env.PANEL_IDENTITY_SECRET;
  if (!secret) throw new Error("PANEL_IDENTITY_SECRET is not set");
  return new TextEncoder().encode(secret);
};

/**
 * Sign the session token. It IS the `x-panel-identity` token the API verifies —
 * same issuer/audience/secret — so the proxy can forward the cookie verbatim.
 */
export const signSession = (claims: SessionClaims): Promise<string> =>
  new SignJWT({ email: claims.email, provider: claims.provider })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey());

export const verifySession = async (
  token: string | undefined,
): Promise<SessionClaims | null> => {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!email) return null;
    return {
      email,
      sub: typeof payload.sub === "string" ? payload.sub : email,
      provider: typeof payload.provider === "string" ? payload.provider : "google",
    };
  } catch {
    return null;
  }
};

/**
 * Base URL for server-issued redirects (login, OAuth callback). Behind a reverse
 * proxy the request's own origin resolves to the container's internal address
 * (e.g. http://localhost:3000), so prefer the configured public URL and fall back
 * to the request origin only when it is not set.
 */
export const publicBaseUrl = (fallbackOrigin: string): string =>
  process.env.PANEL_PUBLIC_URL?.replace(/\/$/, "") || fallbackOrigin;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: TTL_SECONDS,
};
