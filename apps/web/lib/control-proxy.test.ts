import { describe, it, expect } from "vitest";
import {
  buildControlTarget,
  relayedContentSecurityPolicy,
  relayedContentType,
} from "./control-proxy";

const BASE = "http://127.0.0.1:3001";

describe("buildControlTarget", () => {
  // Next.js splits the catch-all on "/" and THEN percent-decodes each segment,
  // so these are the segment arrays the handler really receives for the
  // encoded paths named in the backlog.
  it("rejects https:%2F%2Fevil.com%2Fx (absolute URL smuggled in one segment)", () => {
    expect(buildControlTarget(BASE, ["https://evil.com/x"], "")).toBeNull();
  });

  it("rejects %2F%2Fevil.com%2Fx (protocol-relative URL)", () => {
    expect(buildControlTarget(BASE, ["//evil.com/x"], "")).toBeNull();
  });

  it("rejects http:%2F%2F169.254.169.254%2F... (cloud metadata endpoint)", () => {
    expect(
      buildControlTarget(BASE, ["http://169.254.169.254/latest/meta-data/"], ""),
    ).toBeNull();
  });

  it("rejects an empty segment (a literal // in the request path)", () => {
    expect(buildControlTarget(BASE, ["https:", "", "evil.com", "x"], "")).toBeNull();
  });

  it("rejects a path that climbs above a prefixed base", () => {
    expect(buildControlTarget("http://api.internal/panel", ["..", "admin"], "")).toBeNull();
  });

  it("proxies a normal path and keeps the query string", () => {
    const target = buildControlTarget(BASE, ["api", "me"], "?days=7");
    expect(target?.href).toBe("http://127.0.0.1:3001/api/me?days=7");
  });

  it("re-encodes legitimately encoded characters inside a segment", () => {
    // /api/control/api/keys/abc%20def%40x/config arrives decoded; the upstream
    // must see the same bytes the client sent, not a raw space or "@".
    const target = buildControlTarget(BASE, ["api", "keys", "abc def@x", "config"], "?format=qr");
    expect(target?.href).toBe("http://127.0.0.1:3001/api/keys/abc%20def%40x/config?format=qr");
  });

  it("tolerates a trailing slash on the base URL", () => {
    const target = buildControlTarget("http://127.0.0.1:3001/", ["healthz"], "");
    expect(target?.href).toBe("http://127.0.0.1:3001/healthz");
  });
});

describe("relayedContentType", () => {
  it("passes through the media types the control API emits", () => {
    expect(relayedContentType("application/json; charset=utf-8")).toBe(
      "application/json; charset=utf-8",
    );
    expect(relayedContentType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(relayedContentType("image/png")).toBe("image/png");
  });

  it("relays the QR SVG, which the dialog loads straight into an <img>", () => {
    // format=qr-svg answers image/svg+xml. Downgrading it to
    // application/octet-stream under `nosniff` makes the browser refuse to
    // decode it, and the config dialog shows a broken-image placeholder for a
    // full-tunnel key that has a perfectly good code.
    expect(relayedContentType("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml; charset=utf-8",
    );
  });

  it("downgrades anything else to an opaque download", () => {
    expect(relayedContentType("text/html; charset=utf-8")).toBe("application/octet-stream");
    expect(relayedContentType("application/xml")).toBe("application/octet-stream");
  });

  it("returns null when the upstream sent no content-type (e.g. 204)", () => {
    expect(relayedContentType(null)).toBeNull();
  });
});

describe("relayedContentSecurityPolicy", () => {
  it("locks down an SVG body, which can carry script when opened as a document", () => {
    // <img> never runs script in an SVG, but the same URL can be typed into the
    // address bar, and then it is a same-origin document. The policy makes that
    // document inert rather than trusting the renderer's output shape.
    expect(relayedContentSecurityPolicy("image/svg+xml; charset=utf-8")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  it("adds no policy to the media types that cannot execute", () => {
    expect(relayedContentSecurityPolicy("application/json; charset=utf-8")).toBeNull();
    expect(relayedContentSecurityPolicy("image/png")).toBeNull();
    expect(relayedContentSecurityPolicy(null)).toBeNull();
  });
});
