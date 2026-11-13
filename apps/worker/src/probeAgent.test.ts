import { describe, expect, it, vi } from "vitest";

import { createProbeClient } from "./probeAgent.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const level = { ok: true, detail: null, latencyMs: 5 };
const run = {
  runId: "r1",
  startedAt: "2026-01-01T10:00:00.000Z",
  finishedAt: "2026-01-01T10:01:00.000Z",
  control: level,
  results: [],
};
const request = {
  runId: "r1",
  control: { url: "https://example.com/" },
  egress: { url: "https://example.org/" },
  targets: [{ targetId: "t", protocol: "awg3", config: "secret-config" }],
};

describe("createProbeClient", () => {
  it("sends the api key and posts the run", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(202, { runId: "r1" })));
    const client = createProbeClient({
      baseUrl: "http://probe.test:4002/",
      apiKey: "k".repeat(32),
      fetchImpl,
    });
    await expect(client.startRun(request)).resolves.toEqual({ runId: "r1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://probe.test:4002/runs");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k".repeat(32));
    expect(init.method).toBe("POST");
  });

  it("reports a busy probe", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: "k".repeat(32),
      fetchImpl: vi.fn(() => Promise.resolve(json(409, {}))),
    });
    await expect(client.startRun(request)).resolves.toBe("busy");
  });

  it("returns null before the first run", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: "k".repeat(32),
      fetchImpl: vi.fn(() => Promise.resolve(json(404, {}))),
    });
    await expect(client.latestRun()).resolves.toBeNull();
  });

  it("parses the latest run", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: "k".repeat(32),
      fetchImpl: vi.fn(() => Promise.resolve(json(200, run))),
    });
    await expect(client.latestRun()).resolves.toEqual(run);
  });

  it("throws on a malformed run without echoing the body", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: "k".repeat(32),
      fetchImpl: vi.fn(() => Promise.resolve(json(200, { runId: 5, secret: "x" }))),
    });
    await expect(client.latestRun()).rejects.toThrow("Probe returned a malformed run");
  });

  it("throws on an auth failure", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: "k".repeat(32),
      fetchImpl: vi.fn(() => Promise.resolve(json(401, {}))),
    });
    await expect(client.latestRun()).rejects.toThrow("status 401");
  });

  it("never echoes an unusable api key", async () => {
    const client = createProbeClient({
      baseUrl: "http://probe.test",
      apiKey: `${"k".repeat(32)}\nsecret`,
      fetchImpl: vi.fn(() =>
        Promise.reject(new TypeError(`Headers.append: "${"k".repeat(32)}\nsecret" is an invalid header value.`)),
      ),
    });
    await expect(client.latestRun()).rejects.toThrow(
      "The stored probe API key is not a valid header value",
    );
  });

  describe("capabilities", () => {
    const clientFor = (response: () => Promise<Response>) =>
      createProbeClient({
        baseUrl: "http://probe.test",
        apiKey: "k".repeat(32),
        fetchImpl: vi.fn(response),
      });

    it("parses a new probe's capability response", async () => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(json(200, { apiVersion: 1, capabilities: ["bridge-measurement"] })),
      );
      const client = createProbeClient({
        baseUrl: "http://probe.test",
        apiKey: "k".repeat(32),
        fetchImpl,
      });
      await expect(client.capabilities()).resolves.toEqual({
        apiVersion: 1,
        capabilities: ["bridge-measurement"],
      });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://probe.test/capabilities");
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k".repeat(32));
    });

    it("treats a 404 as a legacy probe", async () => {
      const client = clientFor(() => Promise.resolve(json(404, { error: "not found" })));
      await expect(client.capabilities()).resolves.toBe("legacy");
    });

    it("does not mistake a refusal or an outage for a legacy probe", async () => {
      await expect(
        clientFor(() => Promise.resolve(json(401, {}))).capabilities(),
      ).rejects.toThrow("status 401");
      await expect(
        clientFor(() => Promise.resolve(json(502, {}))).capabilities(),
      ).rejects.toThrow("status 502");
    });

    it("throws on a malformed response without echoing the body", async () => {
      const client = clientFor(() => Promise.resolve(json(200, { capabilities: "SENTINEL" })));
      const error = await client.capabilities().catch((e: unknown) => e as Error);
      expect((error as Error).message).toBe("Probe returned a malformed capability response");
    });
  });
});
