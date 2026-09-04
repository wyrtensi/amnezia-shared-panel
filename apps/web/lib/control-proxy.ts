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
 * downloads), image/png (the downloadable QR) or image/svg+xml (the QR the
 * config dialog displays, `format=qr-svg`) — see
 * apps/control-api/src/defaultService.ts and app.ts
 * `reply.type(result.contentType)`. Anything else is relayed as an opaque
 * download instead of being echoed, so no upstream can ever make the browser
 * render a body as same-origin HTML. Null means "upstream sent none" (a 204)
 * and the route sets no content-type at all.
 *
 * image/svg+xml was absent here while `format=qr-svg` was already being served,
 * so the dialog's `<img src=".../config?format=qr-svg">` received
 * application/octet-stream under `nosniff` and rendered a broken-image
 * placeholder for every full-tunnel key. It is relayed as an image and made
 * inert as a document by `relayedContentSecurityPolicy` below.
 */
const RELAYED_MEDIA_TYPES = new Set([
  "application/json",
  "text/plain",
  "image/png",
  "image/svg+xml",
]);

/**
 * Media types that a browser will execute script from when the URL is opened as
 * a top-level document rather than loaded through `<img>`. SVG is the only one
 * the control API emits.
 */
const SCRIPTABLE_MEDIA_TYPES = new Set(["image/svg+xml"]);

/**
 * The policy that keeps a relayed SVG from being an executable same-origin
 * page. `default-src 'none'` kills scripts and subresources, the style
 * allowance is what the QR's own inline attributes need, and `sandbox` with no
 * token drops the response into an opaque origin so it cannot reach the
 * panel's cookies even if the other two are ever relaxed.
 */
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const mediaTypeOf = (upstream: string | null): string | null =>
  upstream ? (upstream.split(";")[0]?.trim().toLowerCase() ?? null) : null;

export const relayedContentType = (upstream: string | null): string | null => {
  if (!upstream) return null;
  const mediaType = mediaTypeOf(upstream);
  return mediaType && RELAYED_MEDIA_TYPES.has(mediaType)
    ? upstream
    : "application/octet-stream";
};

/** The `content-security-policy` for a relayed body, or null when none is needed. */
export const relayedContentSecurityPolicy = (upstream: string | null): string | null => {
  const mediaType = mediaTypeOf(upstream);
  return mediaType && SCRIPTABLE_MEDIA_TYPES.has(mediaType)
    ? SVG_CONTENT_SECURITY_POLICY
    : null;
};
