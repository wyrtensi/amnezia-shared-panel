import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, publicBaseUrl, verifySession } from "@/lib/session";

const CF_ACCESS_HEADER = "cf-access-jwt-assertion";

// How long a fetched JWKS document is trusted before we ask Cloudflare again,
// and how long a stale one may keep being served after a refresh fails.
// Mirrors apps/control-api/src/resilientJwks.ts.
const CACHE_MAX_AGE_MS = 10 * 60_000;
const STALE_MAX_AGE_MS = 24 * 60 * 60_000;

export type ResilientJwksOptions = {
  /** Fetches and parses the JWKS document. Injected in tests to avoid the network. */
  fetchJwks: () => Promise<JSONWebKeySet>;
  /** How long a fetched document is trusted before asking again. */
  cacheMaxAgeMs?: number;
  /** How long a document may still be served after a refresh has failed. */
  staleMaxAgeMs?: number;
  now?: () => number;
};

/**
 * A JWKS lookup that survives Cloudflare's certs endpoint being briefly
 * unreachable — a hand-copy of `apps/control-api/src/resilientJwks.ts`'s
 * `createResilientJWKSet` (kept as a self-contained port rather than a shared
 * import: `control-api` is not, and should not become, a dependency of `web`).
 * `jose`'s `createRemoteJWKSet` throws when a scheduled refresh fails, and
 * this gate runs on every page navigation, so a short network blip must not
 * lock every Cloudflare Access user out. `proxy.ts` always runs on Next.js's
 * Node.js runtime (the framework enforces this — it is not a `runtime`
 * export choice made here), which for a self-hosted deployment is a
 * long-lived process, so the module-scope cache built on top of this
 * (`resolveJwks` below) persists across requests exactly like it does in the
 * control-api.
 *
 * Exported so tests can inject a fake `fetchJwks` and clock and exercise the
 * caching/staleness/dedup behaviour directly, instead of only through a
 * pre-verified key set that never touches this code.
 */
export const createResilientJwks = ({
  fetchJwks,
  cacheMaxAgeMs = CACHE_MAX_AGE_MS,
  staleMaxAgeMs = STALE_MAX_AGE_MS,
  now = () => Date.now(),
}: ResilientJwksOptions): JWTVerifyGetKey => {
  let cached: { getKey: JWTVerifyGetKey; fetchedAt: number } | null = null;
  // One refresh at a time so a burst of requests arriving the moment the
  // cache expires doesn't become a burst of identical outbound fetches.
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    const document = await fetchJwks();
    cached = { getKey: createLocalJWKSet(document), fetchedAt: now() };
  };

  const ensureFresh = async (): Promise<void> => {
    if (cached && now() - cached.fetchedAt <= cacheMaxAgeMs) return;

    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });

    try {
      await inFlight;
    } catch (error) {
      // Serve the last good document rather than refusing every request,
      // unless it is old enough that continuing to trust it would be wrong.
      if (cached && now() - cached.fetchedAt <= staleMaxAgeMs) return;
      throw error;
    }
  };

  return async (protectedHeader, token) => {
    await ensureFresh();
    if (!cached) throw new Error("No JWKS document is available");
    return cached.getKey(protectedHeader, token);
  };
};

/** Fetches and parses the JWKS document for an issuer over HTTP, with a timeout. */
const fetchJwksOverHttp =
  (issuer: string) => async (): Promise<JSONWebKeySet> => {
    const response = await fetch(new URL(`${issuer}/cdn-cgi/access/certs`), {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/jwk-set+json, application/json" },
    });
    if (!response.ok) {
      throw new Error(`JWKS request failed with status ${response.status}`);
    }
    return (await response.json()) as JSONWebKeySet;
  };

// One resilient key set per issuer, reused for the lifetime of this process.
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

const resolveJwks = (issuer: string): JWTVerifyGetKey => {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createResilientJwks({ fetchJwks: fetchJwksOverHttp(issuer) });
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
};

/**
 * Verify the `cf-access-jwt-assertion` header against Cloudflare's public
 * keys — same check as `apps/control-api/src/cloudflareAccess.ts` (issuer,
 * audience, RS256 signature). Never throws: an absent, unverifiable, or
 * (when Access isn't configured for this deployment) merely-present header
 * is not a valid way in, so the caller falls through to the session-cookie
 * check instead of failing the request outright.
 */
const verifyCloudflareAccess = async (
  request: NextRequest,
  jwksOverride?: JWTVerifyGetKey,
): Promise<boolean> => {
  const token = request.headers.get(CF_ACCESS_HEADER);
  if (!token) return false;

  const issuerRaw = process.env.CF_ACCESS_ISSUER;
  const audience = process.env.CF_ACCESS_AUDIENCE;
  // Without both configured, this deployment isn't behind Cloudflare Access,
  // so the header is unauthenticated user input — it must not admit anyone
  // on the strength of merely being present.
  if (!issuerRaw || !audience) return false;
  const issuer = issuerRaw.replace(/\/$/, "");

  try {
    const jwks = jwksOverride ?? resolveJwks(issuer);
    await jwtVerify(token, jwks, { issuer, audience, algorithms: ["RS256"] });
    return true;
  } catch {
    return false;
  }
};

export type ProxyOptions = {
  /** Injected in tests to verify against a local key set instead of the network. */
  jwks?: JWTVerifyGetKey;
};

/**
 * Gate page navigations. Two ways in:
 *   1. Behind Cloudflare Access — the edge injects `cf-access-jwt-assertion`,
 *      verified above against Cloudflare's JWKS (issuer, audience, signature).
 *   2. Direct (server-side Google login) — a valid `panel_session` cookie.
 * Anything else is redirected to /login. API routes are excluded (they return
 * 401/JSON from the control-api instead of an HTML redirect).
 */
export const createProxy = (options: ProxyOptions = {}) =>
  async function proxy(request: NextRequest) {
    // Direct login is off unless a shared secret is configured. When off, don't
    // gate at all — Cloudflare Access (edge) and the control-api handle auth, so a
    // CF-only deployment is completely unaffected by this middleware.
    if (!process.env.PANEL_IDENTITY_SECRET) {
      return NextResponse.next();
    }
    if (await verifyCloudflareAccess(request, options.jwks)) {
      return NextResponse.next();
    }
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (await verifySession(token)) {
      return NextResponse.next();
    }
    return NextResponse.redirect(
      new URL("/login", publicBaseUrl(request.nextUrl.origin)),
    );
  };

export const proxy = createProxy();

export const config = {
  matcher: [
    // Everything except: /login, /api/*, Next internals, and files with an
    // extension (static assets).
    "/((?!login|api|_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};
