import { describe, expect, it } from "vitest";

import { ApiClientError } from "./api";
import { refreshKeyConfig } from "./config-refresh";

const TOKEN = "ab".repeat(32);
type Answer = unknown;

/** Answers in order; an Error answer is thrown. Records every call. */
const scripted = (answers: Answer[]) => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const request = <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = answers.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T);
  };
  return { request, calls, posts: () => calls.filter((c) => c.method === "POST") };
};

const eligible = (revision: number) => ({ eligible: true, revision, refreshToken: TOKEN });

describe("refreshKeyConfig", () => {
  it("checks, then commits exactly once with the token it got", async () => {
    const { request, calls, posts } = scripted([eligible(0), { revision: 1 }]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({
      kind: "refreshed",
      revision: 1,
    });
    expect(calls[0]).toMatchObject({ path: "/api/keys/key-1/config-refresh", method: "GET" });
    expect(posts()).toEqual([
      {
        path: "/api/keys/key-1/config-refresh",
        method: "POST",
        body: JSON.stringify({ refreshToken: TOKEN }),
      },
    ]);
  });

  it("never posts for an artifact that cannot take a profile", async () => {
    const { request, posts } = scripted([{ eligible: false }]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({ kind: "unavailable" });
    expect(posts()).toHaveLength(0);
  });

  it("delivers without a second commit when someone else refreshed first", async () => {
    const stale = new ApiClientError(409, "CONFIG_REFRESH_STALE", "stale");
    const { request, posts } = scripted([eligible(1), stale, eligible(2)]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({
      kind: "refreshed",
      revision: 2,
    });
    expect(posts()).toHaveLength(1);
  });

  it("delivers when the commit's answer was lost but the revision moved", async () => {
    const { request, posts } = scripted([eligible(0), new TypeError("network"), eligible(1)]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({
      kind: "refreshed",
      revision: 1,
    });
    expect(posts()).toHaveLength(1);
  });

  it("leaves the next try to the user when nothing moved, and never retries itself", async () => {
    for (const failure of [
      new ApiClientError(409, "CONFIG_REFRESH_STALE", "stale"),
      new ApiClientError(503, "CONTROL_API_UNAVAILABLE", "down"),
    ]) {
      const { request, posts } = scripted([eligible(0), failure, eligible(0)]);
      await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({ kind: "retry" });
      expect(posts()).toHaveLength(1);
    }
    const { request } = scripted([eligible(0), new TypeError("network"), new TypeError("still down")]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({ kind: "retry" });
  });

  it("says unavailable when the key changed under the check", async () => {
    const { request } = scripted([
      eligible(0),
      new ApiClientError(409, "CONFIG_REFRESH_UNAVAILABLE", "no"),
    ]);
    await expect(refreshKeyConfig("key-1", request)).resolves.toEqual({ kind: "unavailable" });
  });

  it("passes a definite refusal through", async () => {
    const denied = new ApiClientError(403, "POLICY_DENIED", "Config download is disabled");
    const { request, calls } = scripted([eligible(0), denied]);
    await expect(refreshKeyConfig("key-1", request)).rejects.toBe(denied);
    expect(calls).toHaveLength(2);
  });
});

describe("configUrl revision", () => {
  it("adds the revision only when there is one", async () => {
    const { configUrl } = await import("./api");
    expect(configUrl("k", "qr-svg")).toBe("/api/control/api/keys/k/config?format=qr-svg");
    expect(configUrl("k", "qr-svg", 3)).toBe("/api/control/api/keys/k/config?format=qr-svg&rev=3");
  });
});
