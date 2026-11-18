import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadLevel, parseDownloadFixture } from "../src/download.js";

vi.mock("node:https", () => ({ request: vi.fn() }));

const body = Buffer.from("download fixture\n".repeat(1_024));
const fixture = {
  url: new URL("https://fixture.example.test/reachability.bin"),
  bytes: body.length,
  sha256: createHash("sha256").update(body).digest("hex"),
};

const env = {
  PROBE_DOWNLOAD_URL: fixture.url.href,
  PROBE_DOWNLOAD_BYTES: String(fixture.bytes),
  PROBE_DOWNLOAD_SHA256: fixture.sha256,
};

describe("parseDownloadFixture", () => {
  it("disables the fixture when omitted and reads a complete HTTPS fixture", () => {
    expect(parseDownloadFixture({})).toBeUndefined();
    expect(parseDownloadFixture(env)).toEqual(fixture);
  });

  it.each([
    { PROBE_DOWNLOAD_BYTES: "" },
    { PROBE_DOWNLOAD_BYTES: "262145" },
    { PROBE_DOWNLOAD_SHA256: "not-a-sha256" },
    { PROBE_DOWNLOAD_URL: "http://fixture.example.test/" },
    { PROBE_DOWNLOAD_URL: "https://user:pass@fixture.example.test/" },
    { PROBE_DOWNLOAD_URL: "https://fixture.example.test/?token=sensitive" },
  ])("rejects invalid fixture settings without including their values", (invalid) => {
    expect(() => parseDownloadFixture({ ...env, ...invalid })).toThrow(/^invalid PROBE_DOWNLOAD_/);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(request).mockReset();
});

const respond = ({ statusCode = 200, headers = {}, complete = true } = {}) => {
  const response = Object.assign(new EventEmitter(), { statusCode, headers, complete });
  const socket = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  vi.mocked(request).mockImplementation((_url, _options, onResponse) => {
    queueMicrotask(() => (onResponse as (stream: typeof response) => void)(response));
    return socket as unknown as ReturnType<typeof request>;
  });
  return { response, socket };
};

describe("downloadLevel", () => {
  it("binds HTTPS to the AWG address and verifies all bytes beyond the short HTTP cut-off", async () => {
    const { response, socket } = respond();
    const result = downloadLevel(fixture, "10.90.0.7");
    await Promise.resolve();
    response.emit("data", body.subarray(0, 4_096));
    response.emit("data", body.subarray(4_096));
    response.emit("end");

    expect(request).toHaveBeenCalledWith(fixture.url, expect.objectContaining({
      method: "GET",
      agent: false,
      localAddress: "10.90.0.7",
      family: 4,
      headers: expect.objectContaining({ "accept-encoding": "identity" }),
    }), expect.any(Function));
    expect(await result).toEqual({ ok: true, detail: `${body.length} bytes verified`, latencyMs: expect.any(Number) });
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { description: "an incomplete transfer", stream: { complete: false }, payload: body, detail: "incomplete download" },
    { description: "a short body", stream: {}, payload: body.subarray(0, -1), detail: "download size differs" },
    { description: "an oversized body", stream: {}, payload: Buffer.concat([body, Buffer.from("x")]), detail: "download size differs" },
    { description: "altered bytes of equal size", stream: {}, payload: Buffer.alloc(body.length), detail: "download checksum differs" },
  ])("fails on $description", async ({ stream, payload, detail }) => {
    const { response } = respond(stream);
    const result = downloadLevel(fixture, "10.90.0.7");
    await Promise.resolve();
    response.emit("data", payload);
    response.emit("end");
    expect(await result).toMatchObject({ ok: false, detail });
  });

  it("rejects a redirection without sending a second request or reporting its URL", async () => {
    const { socket } = respond({ statusCode: 302, headers: { location: "https://redirect.example.test/" } });
    expect(await downloadLevel(fixture, "10.90.0.7")).toMatchObject({ ok: false, detail: "HTTP 302" });
    expect(request).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("times out despite progress and closes the request", async () => {
    vi.useFakeTimers();
    const { response, socket } = respond();
    const result = downloadLevel(fixture, "10.90.0.7");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9_000);
    response.emit("data", body);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ ok: false, detail: "download timeout", latencyMs: null });
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
