import { describe, expect, it } from "vitest";

import { pickLatestReleaseTag, resolveNodeAgentRelease } from "./agentRelease.js";

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
