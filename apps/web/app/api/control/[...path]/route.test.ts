import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

type FetchCall = { url: string; headers: Headers; method: string };

const CONTROL_API_URL = "http://control.test:3001";

let calls: FetchCall[];

const stubFetch = (upstream: {
  status?: number;
  contentType?: string | null;
  // null for a null-body status: Node refuses `new Response("", {status: 204})`.
  body?: string | null;
}) => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
      });
      const headers = new Headers();
      if (upstream.contentType) headers.set("content-type", upstream.contentType);
      const body = upstream.body === undefined ? "{}" : upstream.body;
      return Promise.resolve(new Response(body, { status: upstream.status ?? 200, headers }));
    }),
  );
};

const invoke = (
  handler: typeof GET,
  segments: string[],
  options: { search?: string; method?: string; body?: string } = {},
) => {
  const request = new NextRequest(`https://panel.test/api/control/x${options.search ?? ""}`, {
    method: options.method ?? "GET",
    headers: { cookie: "panel_session=session-token", accept: "application/json" },
    body: options.body,
  });
  return handler(request, { params: Promise.resolve({ path: segments }) });
};

beforeEach(() => {
  vi.stubEnv("CONTROL_API_URL", CONTROL_API_URL);
  stubFetch({ contentType: "application/json; charset=utf-8" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/api/control/[...path] — hostile paths", () => {
  // Segment arrays as Next.js hands them over for the encoded request paths.
  const hostile: Array<[string, string[]]> = [
    ["https:%2F%2Fevil.com%2Fx", ["https://evil.com/x"]],
    ["%2F%2Fevil.com%2Fx", ["//evil.com/x"]],
    [
      "http:%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F",
      ["http://169.254.169.254/latest/meta-data/"],
    ],
  ];

  for (const [encoded, segments] of hostile) {
    it(`answers 400 and issues no outbound request for ${encoded}`, async () => {
      const response = await invoke(GET, segments);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "INVALID_PROXY_PATH",
        message: "Path must stay on the control API",
      });
      expect(calls).toHaveLength(0);
    });
  }
});

describe("/api/control/[...path] — normal traffic", () => {
  it("proxies /api/control/api/me to the control API with the session as x-panel-identity", async () => {
    const response = await invoke(GET, ["api", "me"]);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CONTROL_API_URL}/api/me`);
    expect(calls[0]?.headers.get("x-panel-identity")).toBe("session-token");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });

  it("keeps the query string", async () => {
    await invoke(GET, ["api", "traffic"], { search: "?days=7&scope=self" });
    expect(calls[0]?.url).toBe(`${CONTROL_API_URL}/api/traffic?days=7&scope=self`);
  });

  it("re-encodes characters that were legitimately encoded by the client", async () => {
    await invoke(GET, ["api", "keys", "abc def@x", "config"], { search: "?format=qr" });
    expect(calls[0]?.url).toBe(`${CONTROL_API_URL}/api/keys/abc%20def%40x/config?format=qr`);
  });

  it("forwards a POST body and method", async () => {
    await invoke(POST, ["api", "keys"], { method: "POST", body: '{"nodeId":"n1"}' });
    expect(calls[0]?.method).toBe("POST");
  });
});

describe("/api/control/[...path] — response headers", () => {
  it("relays a JSON content-type and adds nosniff", async () => {
    const response = await invoke(GET, ["api", "me"]);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("relays format=qr-svg as an image the dialog's <img> can decode", async () => {
    // The reproduction for the broken-image placeholder on a full-tunnel key:
    // the renderer is fine (apps/control-api/src/qrRender.test.ts measures the
    // real payload at 113 modules), but this proxy was rewriting the image
    // content-type, and `nosniff` then stopped the browser decoding it.
    stubFetch({
      contentType: "image/svg+xml; charset=utf-8",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 121 121"></svg>',
    });
    const response = await invoke(GET, ["api", "keys", "k1", "config"], {
      search: "?format=qr-svg",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Relayed as an image, but never as an executable same-origin document.
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  it("never echoes an HTML content-type from upstream", async () => {
    stubFetch({ contentType: "text/html; charset=utf-8", body: "<script>1</script>" });
    const response = await invoke(GET, ["api", "me"]);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("sets no content-type when upstream sent none", async () => {
    stubFetch({ status: 204, contentType: null, body: null });
    const response = await invoke(GET, ["api", "keys", "k1"]);
    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
  });
});
