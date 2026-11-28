import { describe, expect, it, vi } from "vitest";
import { createWytunnelReleaseResolver } from "./wytunnelReleases.js";

const VALID_AMD64_SHA = "a".repeat(64);
const VALID_ARM64_SHA = "b".repeat(64);

describe("wytunnelReleases", () => {
  it("resolves GitHub latest release with amd64/arm64 assets and SHA256SUMS, caches, and refreshes", async () => {
    let calls = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      calls += 1;
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (href.endsWith("/releases/latest")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tag_name: "v0.2.0",
              html_url: "https://github.com/wyrtensi/wytunnel/releases/tag/v0.2.0",
              published_at: "2026-11-28T14:00:00Z",
              assets: [
                {
                  name: "wytunnel-linux-amd64-musl.tar.gz",
                  browser_download_url:
                    "https://github.com/wyrtensi/wytunnel/releases/download/v0.2.0/wytunnel-linux-amd64-musl.tar.gz",
                  size: 1234567,
                },
                {
                  name: "wytunnel-linux-arm64-musl.tar.gz",
                  browser_download_url:
                    "https://github.com/wyrtensi/wytunnel/releases/download/v0.2.0/wytunnel-linux-arm64-musl.tar.gz",
                  size: 1200000,
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url:
                    "https://github.com/wyrtensi/wytunnel/releases/download/v0.2.0/SHA256SUMS",
                  size: 192,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (href.endsWith("/SHA256SUMS")) {
        return Promise.resolve(
          new Response(
            `${VALID_AMD64_SHA}  wytunnel-linux-amd64-musl.tar.gz\n${VALID_ARM64_SHA}  wytunnel-linux-arm64-musl.tar.gz\n`,
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    let clock = 1_000_000;
    const resolver = createWytunnelReleaseResolver({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
    });

    const first = await resolver.get();
    expect(first).toEqual({
      repository: "wyrtensi/wytunnel",
      tag: "v0.2.0",
      version: "0.2.0",
      htmlUrl: "https://github.com/wyrtensi/wytunnel/releases/tag/v0.2.0",
      publishedAt: "2026-11-28T14:00:00Z",
      source: "github",
      assets: {
        amd64: {
          name: "wytunnel-linux-amd64-musl.tar.gz",
          url: "https://github.com/wyrtensi/wytunnel/releases/download/v0.2.0/wytunnel-linux-amd64-musl.tar.gz",
          size: 1234567,
          sha256: VALID_AMD64_SHA,
        },
        arm64: {
          name: "wytunnel-linux-arm64-musl.tar.gz",
          url: "https://github.com/wyrtensi/wytunnel/releases/download/v0.2.0/wytunnel-linux-arm64-musl.tar.gz",
          size: 1200000,
          sha256: VALID_ARM64_SHA,
        },
      },
    });
    expect(calls).toBe(2);

    // Cached inside TTL
    clock += 60_000;
    await resolver.get();
    expect(calls).toBe(2);

    // Explicit refresh busts cache
    await resolver.refresh();
    expect(calls).toBe(4);
  });

  it("uses pinned_env immediately without hitting GitHub", async () => {
    const fetchMock = vi.fn();
    const resolver = createWytunnelReleaseResolver({
      repository: "custom/wytunnel",
      pinnedVersion: "v0.1.5",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const rel = await resolver.get();
    expect(rel.source).toBe("pinned_env");
    expect(rel.repository).toBe("custom/wytunnel");
    expect(rel.tag).toBe("v0.1.5");
    expect(rel.version).toBe("0.1.5");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back cleanly to v0.1.0 metadata when GitHub returns 404 or network fails", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("Not Found", { status: 404 })));
    const resolver = createWytunnelReleaseResolver({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const rel = await resolver.get();
    expect(rel.source).toBe("fallback");
    expect(rel.tag).toBe("v0.1.0");
    expect(rel.version).toBe("0.1.0");
    expect(rel.assets).toEqual({ amd64: null, arm64: null });
  });
});
