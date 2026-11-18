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

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Parent domain shared by sibling subdomains of PANEL_PUBLIC_URL (e.g.
 * `example.test` for `link.example.test` and `me.example.test`), or null for
 * single-label hosts, two-label apex hosts, or IP literals.
 */
export const sharedParentDomain = (
  publicUrlRaw = process.env.PANEL_PUBLIC_URL,
): string | null => {
  if (!publicUrlRaw) return null;
  try {
    const hostname = new URL(publicUrlRaw).hostname.toLowerCase();
    if (!HOSTNAME_RE.test(hostname) || IPV4_RE.test(hostname)) return null;
    const parts = hostname.split(".").filter(Boolean);
    if (parts.length < 3) return null;
    return parts.slice(1).join(".");
  } catch {
    return null;
  }
};

/**
 * Base URL for server-issued redirects (login, OAuth callback). Behind a reverse
 * proxy the request's own origin resolves to the container's internal address
 * (e.g. http://localhost:3000), so prefer the configured public URL and fall back
 * to the request origin only when it is not set. When the request arrives via a
 * sibling subdomain sharing `sharedParentDomain` (such as a bridge domain),
 * preserve that subdomain so the user stays on the bridge door.
 */
export const publicBaseUrl = (
  fallbackOrigin: string,
  headers?: Pick<Headers, "get">,
): string => {
  const configured = process.env.PANEL_PUBLIC_URL?.replace(/\/$/, "");
  if (!configured) return fallbackOrigin;
  const parent = sharedParentDomain(configured);
  const rawHost =
    headers?.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headers?.get("host")?.trim();
  if (parent && rawHost) {
    const hostname = rawHost.replace(/:\d+$/, "").toLowerCase();
    if (
      HOSTNAME_RE.test(hostname) &&
      !IPV4_RE.test(hostname) &&
      (hostname === parent || hostname.endsWith(`.${parent}`))
    ) {
      const proto = new URL(configured).protocol;
      return `${proto}//${hostname}`;
    }
  }
  return configured;
};

export const encodeOAuthState = (nonce: string, returnOrigin?: string): string => {
  const configured = process.env.PANEL_PUBLIC_URL?.replace(/\/$/, "");
  if (!returnOrigin || !configured || returnOrigin === configured) return nonce;
  return `${nonce}.${Buffer.from(returnOrigin, "utf8").toString("base64url")}`;
};

export const decodeOAuthReturnOrigin = (state: string, fallbackBase: string): string => {
  const dot = state.indexOf(".");
  if (dot <= 0) return fallbackBase;
  try {
    const candidate = Buffer.from(state.slice(dot + 1), "base64url").toString("utf8");
    const host = new URL(candidate).host;
    return publicBaseUrl(fallbackBase, {
      get: (name: string) => (name.toLowerCase() === "host" ? host : null),
    });
  } catch {
    return fallbackBase;
  }
};

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: TTL_SECONDS,
};

export const domainScopedCookieOptions = <T extends Record<string, unknown>>(
  base: T,
  publicUrlRaw = process.env.PANEL_PUBLIC_URL,
): T & { domain?: string } => {
  const parent = sharedParentDomain(publicUrlRaw);
  return parent ? { ...base, domain: parent } : base;
};
