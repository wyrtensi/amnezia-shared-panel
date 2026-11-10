import { describe, expect, it } from "vitest";

import {
  isProbeStale,
  probeRunRequestSchema,
  probeRunStateSchema,
  reachabilityNotifyPayloadSchema,
  updateNodeRequestSchema,
  upsertReachabilityProbeRequestSchema,
} from "./index.js";

const validProbe = {
  label: "Testland",
  apiBaseUrl: "http://host.docker.internal:4120",
  apiKey: "k".repeat(32),
  controlUrl: "https://example.com/",
};

const level = { ok: true, detail: null, latencyMs: 12 };

describe("upsertReachabilityProbeRequestSchema", () => {
  it("accepts a minimal probe", () => {
    expect(upsertReachabilityProbeRequestSchema.parse(validProbe)).toMatchObject(validProbe);
  });

  it("refuses a control target that is not https", () => {
    expect(
      upsertReachabilityProbeRequestSchema.safeParse({
        ...validProbe,
        controlUrl: "http://example.com/",
      }).success,
    ).toBe(false);
  });

  it("refuses a short api key", () => {
    expect(
      upsertReachabilityProbeRequestSchema.safeParse({ ...validProbe, apiKey: "short" })
        .success,
    ).toBe(false);
  });

  it("refuses an interval under five minutes", () => {
    expect(
      upsertReachabilityProbeRequestSchema.safeParse({ ...validProbe, intervalSec: 299 })
        .success,
    ).toBe(false);
  });

  it("refuses an empty label", () => {
    expect(
      upsertReachabilityProbeRequestSchema.safeParse({ ...validProbe, label: "  " }).success,
    ).toBe(false);
  });
});

describe("probe wire format", () => {
  it("parses a run state and drops unknown fields", () => {
    const parsed = probeRunStateSchema.parse({
      runId: "r1",
      startedAt: "2026-01-01T10:00:00.000Z",
      finishedAt: null,
      control: level,
      results: [
        {
          targetId: "t1",
          protocol: "awg3",
          status: "done",
          detail: null,
          endpointHost: "192.0.2.10",
          egressIp: "192.0.2.10",
          levels: { ping: level, tcp: level, handshake: level, http: level },
          futureField: 1,
        },
      ],
      futureTop: true,
    });
    expect(parsed.results[0]).not.toHaveProperty("futureField");
    expect(parsed).not.toHaveProperty("futureTop");
  });

  it("caps a run request at 500 targets", () => {
    const target = { targetId: "t", protocol: "awg3", config: "x" };
    expect(
      probeRunRequestSchema.safeParse({
        runId: "r",
        control: { url: "https://example.com/" },
        egress: { url: "https://example.org/" },
        targets: Array.from({ length: 501 }, () => target),
      }).success,
    ).toBe(false);
  });
});

describe("reachability notify payload", () => {
  it("refuses an empty or oversized text", () => {
    expect(reachabilityNotifyPayloadSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      reachabilityNotifyPayloadSchema.safeParse({ text: "x".repeat(3_501) }).success,
    ).toBe(false);
  });
});

describe("updateNodeRequestSchema", () => {
  it("accepts reachabilityEnabled on its own", () => {
    expect(updateNodeRequestSchema.parse({ reachabilityEnabled: false })).toEqual({
      reachabilityEnabled: false,
    });
  });
});

describe("isProbeStale", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  it("measures from the newest result", () => {
    expect(
      isProbeStale({
        now: new Date("2026-01-01T05:00:00Z"),
        staleAfterSec: 10_800,
        lastResultAt: new Date("2026-01-01T03:00:00Z"),
        createdAt,
      }),
    ).toBe(false);
  });

  it("measures from registration before the first result", () => {
    expect(
      isProbeStale({
        now: new Date("2026-01-01T03:00:01Z"),
        staleAfterSec: 10_800,
        lastResultAt: null,
        createdAt,
      }),
    ).toBe(true);
  });
});

describe("updateNodeRequestSchema defaults", () => {
  it("never fills create-time defaults into a patch", () => {
    expect(updateNodeRequestSchema.parse({ checksEnabled: false })).toEqual({
      checksEnabled: false,
    });
  });
});
