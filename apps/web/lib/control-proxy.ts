/**
 * Helpers for the /api/control/[...path] proxy route. Pure functions, no Next
 * imports, so they are unit-testable in isolation.
 */

/**
 * Build the upstream URL for one /api/control/<...path> request.
 *
 * Next.js splits the catch-all on "/" and THEN percent-decodes every segment,
 * so `https:%2F%2Fevil.com%2Fx` reaches the handler as the single segment
 * "https://evil.com/x". Joining that back and handing it to `new URL(path,
 * base)` yields an absolute URL and the base is discarded — the caller then
 * controls scheme, host and path of a server-side fetch that carries the
 * victim's session token. Re-encoding each segment keeps every decoded
 * character inside its own path segment; the origin/prefix check is the
 * backstop for anything the encoding does not cover.
 *
 * Returns null when the result would leave the control API's origin or path
 * prefix, or when a segment is empty (a literal "//" in the request path —
 * nothing in apps/web/lib/api.ts ever produces one). The route answers 400.
 */
const PATH_SEPARATORS = /[/\\]/;

export const buildControlTarget = (
  baseUrl: string,
  segments: readonly string[],
  search: string,
): URL | null => {
  const base = new URL(`${baseUrl.replace(/\/$/, "")}/`);
  // A decoded segment that still holds a separator can only have arrived as
  // %2F / %5C: every caller in apps/web/lib/api.ts encodes its variable part,
  // so nothing legitimate produces one. Re-encoding below would keep such a
  // segment on this origin, but only as a guaranteed 404 — rejecting says what
  // actually happened instead of proxying a request nobody meant to make.
  // An empty segment is the same story for a literal "//" in the path.
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || PATH_SEPARATORS.test(segment))
  ) {
    return null;
  }
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const target = new URL(path, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    return null;
  }
  target.search = search;
  return target;
};

/**
 * The control API answers with JSON (every route), text/plain (config
 * downloads) or image/png (QR codes) — see apps/control-api/src/defaultService.ts
 * and app.ts `reply.type(result.contentType)`. Anything else is relayed as an
 * opaque download instead of being echoed, so no upstream can ever make the
 * browser render a body as same-origin HTML. Null means "upstream sent none"
 * (a 204) and the route sets no content-type at all.
 */
const RELAYED_MEDIA_TYPES = new Set(["application/json", "text/plain", "image/png"]);

export const relayedContentType = (upstream: string | null): string | null => {
  if (!upstream) return null;
  const mediaType = upstream.split(";")[0]?.trim().toLowerCase();
  return mediaType && RELAYED_MEDIA_TYPES.has(mediaType)
    ? upstream
    : "application/octet-stream";
};
