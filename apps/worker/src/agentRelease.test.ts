import { describe, expect, it } from "vitest";

import { pickLatestReleaseTag, resolveNodeAgentRelease } from "./agentRelease.js";
import { resolveBridgeAgentRelease } from "./bridgeAgentRelease.js";

const REPO = "ghcr.io/owner/repo/node-agent";
const DIGEST = `sha256:${"c".repeat(64)}`;

describe("pickLatestReleaseTag", () => {
  it("orders numerically, not lexically", () => {
    expect(pickLatestReleaseTag(["1.9.0", "1.10.0", "1.2.0"])).toBe("1.10.0");
    expect(pickLatestReleaseTag(["1.1.2", "1.1.3"])).toBe("1.1.3");
  });

  it("ignores tags that are not releases", () => {
    // The release workflow publishes sha-<short sha> on a manual run. Those are
    // not releases and nothing orders them against a version.
    expect(pickLatestReleaseTag(["1.1.3", "sha-abcdef123456"])).toBe("1.1.3");
    expect(pickLatestReleaseTag(["sha-abcdef123456"])).toBe(null);
    expect(pickLatestReleaseTag([])).toBe(null);
  });
});

type Route = {
  token?: unknown;
  tags?: unknown;
  tokenStatus?: number;
  tagsStatus?: number;
  manifestStatus?: number;
  digest?: string | null;
};

const fetchStub = (route: Route) => {
  const calls: { url: string; method: string }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/token")) {
      return Promise.resolve(
        new Response(JSON.stringify({ token: "token" in route ? route.token : "t" }), {
          status: route.tokenStatus ?? 200,
        }),
      );
    }
    if (url.includes("/tags/list")) {
      return Promise.resolve(
        new Response(JSON.stringify({ tags: route.tags ?? ["1.1.3"] }), {
          status: route.tagsStatus ?? 200,
        }),
      );
    }
    const headers = new Headers();
    if (route.digest !== null) {
      headers.set("docker-content-digest", route.digest ?? DIGEST);
    }
    return Promise.resolve(
      new Response(null, { status: route.manifestStatus ?? 200, headers }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("resolveNodeAgentRelease", () => {
  it("resolves the newest release to a digest reference", async () => {
    const { impl, calls } = fetchStub({ tags: ["1.1.2", "1.1.3"] });

    expect(await resolveNodeAgentRelease(REPO, impl)).toEqual({
      repository: REPO,
      version: "1.1.3",
      digest: DIGEST,
      image: `${REPO}@${DIGEST}`,
    });
    // HEAD, not GET: the digest is a header, and the manifest body is not needed.
    expect(calls.at(-1)?.method).toBe("HEAD");
  });

  it("returns null rather than falling back to a tag", async () => {
    // Every failure mode has to end in "cannot resolve the current image". A
    // tag resolved on the node is exactly the mutable reference preflight
    // refuses, so there is no safe fallback.
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ tokenStatus: 403 }).impl)).toBe(null);
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ token: null }).impl)).toBe(null);
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ tagsStatus: 404 }).impl)).toBe(null);
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ tags: [] }).impl)).toBe(null);
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ manifestStatus: 500 }).impl)).toBe(null);
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ digest: null }).impl)).toBe(null);
  });

  it("refuses a digest the node itself would refuse", async () => {
    // Catching this here is one log line; catching it on the node is a failed
    // update on a live host.
    expect(await resolveNodeAgentRelease(REPO, fetchStub({ digest: "sha256:short" }).impl)).toBe(
      null,
    );
    expect(
      await resolveNodeAgentRelease(REPO, fetchStub({ digest: `sha256:${"C".repeat(64)}` }).impl),
    ).toBe(null);
  });

  it("only speaks to GHCR", async () => {
    const { impl, calls } = fetchStub({});

    expect(await resolveNodeAgentRelease("docker.io/owner/node-agent", impl)).toBe(null);
    expect(await resolveNodeAgentRelease("ghcr.io/", impl)).toBe(null);
    expect(calls).toEqual([]);
  });
});

// The bridge-agent resolver is the same implementation with a filter.
const BRIDGE_REPO = "ghcr.io/owner/repo/bridge-agent";
const LABEL = "io.amnezia.bridge-agent.api-version";

type Image = { labels?: Record<string, string>; digest?: string };

/** A registry whose tags carry labels via index -> linux manifest -> config blob. */
const bridgeRegistry = (images: Record<string, Image>) => {
  const calls: { url: string; method: string }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/token")) return json({ token: "t" });
    if (url.includes("/tags/list")) return json({ tags: [...Object.keys(images), "sha-abcdef123456"] });
    const manifest = /\/manifests\/(.+)$/.exec(url)?.[1] ?? "";
    if (method === "HEAD") {
      const image = images[manifest];
      return Promise.resolve(
        new Response(null, {
          status: image ? 200 : 404,
          headers: { "docker-content-digest": image?.digest ?? DIGEST },
        }),
      );
    }
    if (manifest in images) {
      return json({
        manifests: [
          { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
          { digest: `sha256:linux-${manifest}`, platform: { os: "linux", architecture: "amd64" } },
        ],
      });
    }
    if (manifest.startsWith("sha256:linux-")) return json({ config: { digest: `sha256:cfg-${manifest.slice(13)}` } });
    const cfg = /\/blobs\/sha256:cfg-(.+)$/.exec(url)?.[1] ?? "";
    return json({ config: { Labels: images[cfg]?.labels ?? null } });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("resolveBridgeAgentRelease", () => {
  it("offers the newest release of the approved repository as repository@digest", async () => {
    const { impl } = bridgeRegistry({
      "0.1.0": { labels: { [LABEL]: "1" }, digest: `sha256:${"1".repeat(64)}` },
      "0.2.0": { labels: { [LABEL]: "1" }, digest: `sha256:${"2".repeat(64)}` },
    });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toEqual({
      repository: BRIDGE_REPO,
      version: "0.2.0",
      digest: `sha256:${"2".repeat(64)}`,
      image: `${BRIDGE_REPO}@sha256:${"2".repeat(64)}`,
    });
  });

  it("skips a newer release whose API version the panel does not support", async () => {
    const { impl } = bridgeRegistry({
      "0.1.0": { labels: { [LABEL]: "1" }, digest: `sha256:${"1".repeat(64)}` },
      "1.0.0": { labels: { [LABEL]: "2" }, digest: `sha256:${"2".repeat(64)}` },
    });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.version).toBe("0.1.0");
  });

  it("returns null when every release is incompatible", async () => {
    const { impl } = bridgeRegistry({ "1.0.0": { labels: { [LABEL]: "2" } } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toBe(null);
  });

  it("falls back to the minimum version when the image carries no label", async () => {
    const { impl } = bridgeRegistry({ "0.3.0": {} });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.version).toBe("0.3.0");
    const old = bridgeRegistry({ "0.0.9": {} });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, old.impl)).toBe(null);
    // The below-minimum tag is never even inspected.
    expect(old.calls.some((call) => call.url.includes("/manifests/"))).toBe(false);
  });

  it("only speaks to GHCR and never offers a manual-run sha tag", async () => {
    const other = bridgeRegistry({});
    expect(await resolveBridgeAgentRelease("docker.io/owner/bridge-agent", other.impl)).toBe(null);
    expect(other.calls).toEqual([]);
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, bridgeRegistry({}).impl)).toBe(null);
  });

  it("refuses a malformed digest like the node resolver", async () => {
    const { impl } = bridgeRegistry({ "0.1.0": { labels: { [LABEL]: "1" }, digest: "sha256:short" } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toBe(null);
  });
});
