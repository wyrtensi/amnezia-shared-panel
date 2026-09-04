import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

/**
 * A JWKS that survives its provider being briefly unreachable.
 *
 * Every authenticated request verifies a token against the identity provider's
 * key set, so whatever fetches that key set is on the path of the entire API.
 * `createRemoteJWKSet` refetches when its cache expires and **throws** if that
 * fetch fails — which turns a two-minute network blip into every `/api/*`
 * request returning 500. That is not hypothetical: it is what took the panel
 * down on 2026-09-04 while the tunnels themselves were fine.
 *
 * The signing keys did not change during that window. Only our ability to
 * re-download them did. So a failed refresh keeps serving the last good
 * document, for a bounded time.
 */
export type ResilientJWKSetOptions = {
  /** Returns the parsed JWKS document. */
  fetchJwks: () => Promise<unknown>;
  /** How long a document is served without asking again. */
  cacheMaxAgeMs?: number;
  /**
   * How long a document may still be served after a refresh has failed. This
   * is a bounded grace period, not a substitute for reaching the provider: a
   * rotated or revoked signing key must stop working eventually.
   */
  staleMaxAgeMs?: number;
  now?: () => number;
};

const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_STALE_MAX_AGE_MS = 24 * 60 * 60_000;

export const createResilientJWKSet = ({
  fetchJwks,
  cacheMaxAgeMs = DEFAULT_CACHE_MAX_AGE_MS,
  staleMaxAgeMs = DEFAULT_STALE_MAX_AGE_MS,
  now = () => Date.now(),
}: ResilientJWKSetOptions): JWTVerifyGetKey => {
  let cached: { getKey: JWTVerifyGetKey; fetchedAt: number } | null = null;
  // One refresh at a time. Every request goes through here, so a burst arriving
  // the moment the cache expires would otherwise become a burst of identical
  // outbound fetches at a provider that may already be struggling.
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    const document = (await fetchJwks()) as JSONWebKeySet;
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

/**
 * Fetch a JWKS over HTTP with an explicit timeout.
 *
 * The timeout matters as much as the caching: without one the request path
 * inherits whatever the platform's default is, and a provider that accepts the
 * connection and then goes quiet holds an API request open for as long as it
 * likes.
 */
export const createJwksFetcher =
  (url: URL, { timeoutMs = 5_000, fetchImpl = fetch } = {}) =>
  async (): Promise<unknown> => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/jwk-set+json, application/json" },
    });
    if (!response.ok) {
      throw new Error(`JWKS request failed with status ${response.status}`);
    }
    return response.json();
  };
