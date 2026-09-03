import { describe, expect, it, vi } from "vitest";
import type { ClientPlatformDownload } from "@amnezia/contracts";
import { createClientReleaseResolver } from "./clientReleases.js";

// Trimmed copy of the real api.github.com payload (release 5.0.1.5, fetched
// 2026-09-02): the three assets we look for plus one we deliberately ignore.
const RELEASE_BODY = {
  tag_name: "5.0.1.5",
  html_url: "https://github.com/amnezia-vpn/amnezia-client/releases/tag/5.0.1.5",
  published_at: "2026-08-21T14:47:49Z",
  assets: [
    {
      name: "AmneziaVPN_5.0.1.5_windows_x64.exe",
      browser_download_url:
        "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_windows_x64.exe",
      size: 91_991_200,
    },
    {
      name: "AmneziaVPN_5.0.1.5_macos_x64.pkg",
      browser_download_url:
        "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_macos_x64.pkg",
      size: 111_188_003,
    },
    {
      name: "AmneziaVPN_5.0.1.5_android11+_arm64-v8a.apk",
      browser_download_url:
        "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_android11%2B_arm64-v8a.apk",
      size: 75_586_403,
    },
    {
      name: "AmneziaVPN_5.0.1.5_linux_x64.run",
      browser_download_url:
        "https://github.com/amnezia-vpn/amnezia-client/releases/download/5.0.1.5/AmneziaVPN_5.0.1.5_linux_x64.run",
      size: 96_380_585,
    },
  ],
};

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const forPlatform = (
  downloads: ClientPlatformDownload[],
  platform: string,
): ClientPlatformDownload => {
  const entry = downloads.find((item) => item.platform === platform);
  if (!entry) throw new Error(`no download for ${platform}`);
  return entry;
};

/** A clock the test moves by hand, so no timers or real waiting are involved. */
const createClock = (startMs = Date.UTC(2026, 8, 2, 9, 0, 0)) => {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe("createClientReleaseResolver", () => {
  it("maps release assets onto per-platform downloads", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse(RELEASE_BODY)));
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const release = await resolver.get();

    expect(release.fallback).toBe(false);
    expect(release.version).toBe("5.0.1.5");
    expect(release.publishedAt).toBe("2026-08-21T14:47:49.000Z");

    const windows = forPlatform(release.downloads, "windows");
    expect(windows.primary.kind).toBe("installer");
    expect(windows.primary.fileName).toBe("AmneziaVPN_5.0.1.5_windows_x64.exe");
    expect(windows.primary.sizeBytes).toBe(91_991_200);

    expect(forPlatform(release.downloads, "macos").primary.fileName).toBe(
      "AmneziaVPN_5.0.1.5_macos_x64.pkg",
    );

    // Android leads with Google Play; the APK is the fallback route.
    const android = forPlatform(release.downloads, "android");
    expect(android.primary.kind).toBe("store");
    expect(android.primary.url).toContain("id=org.amnezia.vpn");
    expect(android.alternate?.kind).toBe("installer");
    // The "+" in the asset name is percent-encoded by GitHub; the URL is taken
    // from the payload verbatim rather than rebuilt.
    expect(android.alternate?.url).toContain("android11%2B_arm64-v8a.apk");

    const ios = forPlatform(release.downloads, "ios");
    expect(ios.primary.kind).toBe("store");
    expect(ios.primary.url).toContain("id6744725017");
    expect(ios.alternate).toBeNull();
  });

  it("degrades a single platform to the release page when its asset is missing", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        okResponse({
          ...RELEASE_BODY,
          assets: RELEASE_BODY.assets.filter(
            (asset) => !asset.name.endsWith("_windows_x64.exe"),
          ),
        }),
      ),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const release = await resolver.get();

    // The whole resolve still succeeds — only Windows loses its direct link.
    expect(release.fallback).toBe(false);
    const windows = forPlatform(release.downloads, "windows");
    expect(windows.primary.kind).toBe("releasePage");
    expect(windows.primary.url).toBe(RELEASE_BODY.html_url);
    expect(forPlatform(release.downloads, "macos").primary.kind).toBe("installer");
  });

  it("serves the cached snapshot until the success TTL expires", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse(RELEASE_BODY)));
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      successTtlMs: 6 * 60 * 60 * 1000,
    });

    await resolver.get();
    clock.advance(5 * 60 * 60 * 1000);
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.advance(2 * 60 * 60 * 1000);
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers into a single upstream request", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse(RELEASE_BODY)));
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const [a, b, c] = await Promise.all([
      resolver.get(),
      resolver.get(),
      resolver.get(),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("serves the version-free pinned fallback when GitHub is unreachable", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com")),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const release = await resolver.get();

    expect(release.fallback).toBe(true);
    expect(release.version).toBeNull();
    expect(release.publishedAt).toBeNull();
    expect(release.releaseUrl).toBe(
      "https://github.com/amnezia-vpn/amnezia-client/releases/latest",
    );
    // Nothing version-pinned ships in the repo: every non-store link is the
    // permanent latest redirect.
    for (const download of release.downloads) {
      for (const asset of [download.primary, download.alternate]) {
        if (!asset) continue;
        expect(asset.url).not.toMatch(/\d+\.\d+\.\d+/);
      }
    }
    expect(forPlatform(release.downloads, "android").primary.kind).toBe("store");
    expect(forPlatform(release.downloads, "ios").primary.kind).toBe("store");
  });

  it("keeps serving the last good snapshot when a refresh fails", async () => {
    const clock = createClock();
    let failing = false;
    const fetchImpl = vi.fn(() =>
      failing
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(okResponse(RELEASE_BODY)),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      successTtlMs: 60_000,
      failureTtlMs: 10_000,
    });

    const good = await resolver.get();
    failing = true;
    clock.advance(61_000);

    const stale = await resolver.get();
    // Stale-but-real beats the pin.
    expect(stale.fallback).toBe(false);
    expect(stale).toEqual(good);
  });

  it("does not retry before the failure TTL expires", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      failureTtlMs: 15 * 60 * 1000,
    });

    await resolver.get();
    clock.advance(60_000);
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.advance(15 * 60 * 1000);
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a rate-limited or error response as a failure", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("rate limited", { status: 403 })),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const release = await resolver.get();
    expect(release.fallback).toBe(true);
  });

  it("treats a payload that does not match GitHub's shape as a failure", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ message: "Not Found" })),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: createClock().now,
    });

    const release = await resolver.get();
    expect(release.fallback).toBe(true);
  });

  it("replaces the pinned fallback once GitHub recovers", async () => {
    // A failure is never final: only a successful value is treated as settled.
    const clock = createClock();
    let failing = true;
    const fetchImpl = vi.fn(() =>
      failing
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(okResponse(RELEASE_BODY)),
    );
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      failureTtlMs: 15 * 60 * 1000,
    });

    expect((await resolver.get()).fallback).toBe(true);

    failing = false;
    clock.advance(15 * 60 * 1000);

    const recovered = await resolver.get();
    expect(recovered.fallback).toBe(false);
    expect(recovered.version).toBe("5.0.1.5");
  });

  it("refresh() re-resolves immediately, ignoring both TTLs", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse(RELEASE_BODY)));
    const resolver = createClientReleaseResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      successTtlMs: 6 * 60 * 60 * 1000,
    });

    await resolver.get();
    // Well inside the success TTL: get() would be a cache hit.
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const refreshed = await resolver.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshed.fallback).toBe(false);

    // And the new deadline applies from the refresh, so the next read is cached.
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
