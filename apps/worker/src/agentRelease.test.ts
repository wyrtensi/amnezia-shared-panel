import { createHash } from "node:crypto";
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

// The bridge-agent resolver is the same implementation with a filter. The fake
// registry is content-addressed with REAL sha256 digests, because the resolver
// verifies every body against the digest that referenced it.
const BRIDGE_REPO = "ghcr.io/owner/repo/bridge-agent";
const LABEL = "io.amnezia.bridge-agent.api-version";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

type ImageSpec = {
  labels?: Record<string, string>;
  /** A plain manifest instead of an index. */
  single?: boolean;
  /** An index without a linux entry. */
  noLinux?: boolean;
};
type Faults = {
  /** URL fragment -> status returned instead of the body. */
  status?: Record<string, number>;
  /** URL fragment -> body served instead of the real bytes. */
  tamper?: Record<string, string>;
  /** The digest a tag's HEAD reports (a tag moved after it was listed). */
  repush?: Record<string, string>;
};

const bridgeRegistry = (images: Record<string, ImageSpec>, faults: Faults = {}) => {
  const blobs = new Map<string, string>();
  const topDigest: Record<string, string> = {};
  const put = (body: unknown): string => {
    const text = JSON.stringify(body);
    const digest = sha(text);
    blobs.set(digest, text);
    return digest;
  };
  for (const [tag, spec] of Object.entries(images)) {
    const config = put({ config: { Labels: spec.labels ?? null }, tag });
    const manifest = put({ config: { digest: config } });
    topDigest[tag] = spec.single
      ? manifest
      : put({
          manifests: [
            { digest: sha("attestation"), platform: { os: "unknown", architecture: "unknown" } },
            ...(spec.noLinux ? [] : [{ digest: manifest, platform: { os: "linux", architecture: "amd64" } }]),
          ],
        });
  }
  const calls: { url: string; method: string }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/token")) return json({ token: "t" });
    if (url.includes("/tags/list")) return json({ tags: [...Object.keys(images), "sha-abcdef123456"] });
    for (const [fragment, status] of Object.entries(faults.status ?? {})) {
      if (url.includes(fragment) && method === "GET") return Promise.resolve(new Response(null, { status }));
    }
    const ref = /\/(?:manifests|blobs)\/(.+)$/.exec(url)?.[1] ?? "";
    if (method === "HEAD") {
      const tag = ref;
      const digest = topDigest[tag];
      return Promise.resolve(
        new Response(null, {
          status: digest ? 200 : 404,
          headers: { "docker-content-digest": faults.repush?.[tag] ?? digest ?? "" },
        }),
      );
    }
    for (const [fragment, body] of Object.entries(faults.tamper ?? {})) {
      if (url.includes(fragment)) return Promise.resolve(new Response(body));
    }
    const body = blobs.get(ref);
    return Promise.resolve(body ? new Response(body) : new Response(null, { status: 404 }));
  }) as unknown as typeof fetch;
  return { impl, calls, topDigest, blobs };
};

describe("resolveBridgeAgentRelease", () => {
  it("offers the newest release as repository@digest of exactly the inspected image", async () => {
    const { impl, topDigest } = bridgeRegistry({
      "0.1.0": { labels: { [LABEL]: "1" } },
      "0.2.0": { labels: { [LABEL]: "1" } },
    });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toEqual({
      repository: BRIDGE_REPO,
      version: "0.2.0",
      digest: topDigest["0.2.0"],
      image: `${BRIDGE_REPO}@${topDigest["0.2.0"]}`,
    });
  });

  it("reads the label through a plain single manifest too", async () => {
    const ok = bridgeRegistry({ "0.2.0": { single: true, labels: { [LABEL]: "1" } } });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, ok.impl))?.version).toBe("0.2.0");
    const bad = bridgeRegistry({ "0.2.0": { single: true, labels: { [LABEL]: "2" } } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, bad.impl)).toBe(null);
  });

  it("skips a newer release whose API version the panel does not support", async () => {
    const { impl } = bridgeRegistry({
      "0.1.0": { labels: { [LABEL]: "1" } },
      "1.0.0": { labels: { [LABEL]: "2" } },
    });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.version).toBe("0.1.0");
  });

  it("returns null when every release is incompatible", async () => {
    const { impl } = bridgeRegistry({ "1.0.0": { labels: { [LABEL]: "2" } } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toBe(null);
  });

  it("falls back to the minimum version only when the config was read and has no label", async () => {
    const { impl } = bridgeRegistry({ "0.3.0": {} });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.version).toBe("0.3.0");
    const old = bridgeRegistry({ "0.0.9": {} });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, old.impl)).toBe(null);
    expect(old.calls.some((call) => call.url.includes("/manifests/"))).toBe(false);
  });

  it("fails closed when the registry walk breaks: a newer api-v2 tag is never offered on version alone", async () => {
    const images = {
      "0.1.0": { labels: { [LABEL]: "1" } },
      "1.0.0": { labels: { [LABEL]: "2" } },
    };
    const walk = bridgeRegistry(images);
    const newest = walk.topDigest["1.0.0"]!;
    const config = [...walk.blobs.keys()].find((d) => walk.blobs.get(d)?.includes('"tag":"1.0.0"'))!;
    const linux = [...walk.blobs.keys()].find((d) => walk.blobs.get(d) === JSON.stringify({ config: { digest: config } }) )!;
    for (const [what, fragment] of [["config blob", `/blobs/${config}`], ["linux manifest", `/manifests/${linux}`], ["index", `/manifests/${newest}`]] as const) {
      for (const status of [404, 401]) {
        const { impl } = bridgeRegistry(images, { status: { [fragment]: status } });
        // The broken newest tag is skipped; the older verified one is offered, never the broken one.
        const release = await resolveBridgeAgentRelease(BRIDGE_REPO, impl);
        expect(release?.version, `${what} ${status}`).toBe("0.1.0");
      }
    }
    // With nothing verifiable left, nothing is offered.
    const only = bridgeRegistry({ "1.0.0": { labels: { [LABEL]: "2" } } });
    const onlyConfig = [...only.blobs.keys()].find((d) => only.blobs.get(d)?.includes('"tag":"1.0.0"'))!;
    const none = bridgeRegistry({ "1.0.0": { labels: { [LABEL]: "2" } } }, { status: { [`/blobs/${onlyConfig}`]: 401 } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, none.impl)).toBe(null);
  });

  it("an index without a linux entry cannot be inspected and is not offered", async () => {
    const { impl } = bridgeRegistry({ "0.2.0": { noLinux: true, labels: { [LABEL]: "1" } } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toBe(null);
  });

  it("skips a tag whose reported digest no longer resolves to the manifest (tag moved)", async () => {
    const images = {
      "0.1.0": { labels: { [LABEL]: "1" } },
      "0.2.0": { labels: { [LABEL]: "1" } },
    };
    const { impl } = bridgeRegistry(images, { repush: { "0.2.0": sha("a re-pushed manifest") } });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.version).toBe("0.1.0");
  });

  it("offers the digest it inspected, never the tag's current one", async () => {
    const images = { "0.1.0": { labels: { [LABEL]: "1" } }, "0.2.0": { labels: { [LABEL]: "1" } } };
    const probe = bridgeRegistry(images);
    // The tag now reports the 0.1.0 image's digest: that image is inspected and
    // offered, with the digest that was inspected.
    const { impl } = bridgeRegistry(images, { repush: { "0.2.0": probe.topDigest["0.1.0"]! } });
    expect((await resolveBridgeAgentRelease(BRIDGE_REPO, impl))?.digest).toBe(probe.topDigest["0.1.0"]);
  });

  it("refuses a body whose hash is not the digest that referenced it, at every step", async () => {
    const images = { "0.2.0": { labels: { [LABEL]: "1" } } };
    const probe = bridgeRegistry(images);
    const top = probe.topDigest["0.2.0"]!;
    const config = [...probe.blobs.keys()].find((d) => probe.blobs.get(d)?.includes('"tag"'))!;
    for (const fragment of [`/manifests/${top}`, `/blobs/${config}`]) {
      const { impl } = bridgeRegistry(images, { tamper: { [fragment]: JSON.stringify({ config: { Labels: { [LABEL]: "1" } } }) } });
      expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl), fragment).toBe(null);
    }
  });

  it("does not read a body over the byte limit", async () => {
    const images = { "0.2.0": { labels: { [LABEL]: "1" } } };
    const probe = bridgeRegistry(images);
    const config = [...probe.blobs.keys()].find((d) => probe.blobs.get(d)?.includes('"tag"'))!;
    const huge = JSON.stringify({ pad: "x".repeat(1_100_000) });
    const { impl } = bridgeRegistry(images, { tamper: { [`/blobs/${config}`]: huge } });
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, impl)).toBe(null);
  });

  it("only speaks to GHCR and never offers a manual-run sha tag", async () => {
    const other = bridgeRegistry({});
    expect(await resolveBridgeAgentRelease("docker.io/owner/bridge-agent", other.impl)).toBe(null);
    expect(other.calls).toEqual([]);
    expect(await resolveBridgeAgentRelease(BRIDGE_REPO, bridgeRegistry({}).impl)).toBe(null);
  });
});
