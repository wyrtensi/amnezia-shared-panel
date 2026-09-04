import { describe, expect, it } from "vitest";
import {
  awgCell,
  formatBytes,
  handshakeCell,
  METRIC_WARNINGS,
  metricPair,
  metricWarnings,
} from "./nodeMetrics.js";

describe("formatting", () => {
  it("shows a dash for anything unreported, never a zero", () => {
    // A zero here reads as a measurement: "this host has no swap" is a
    // different statement from "this agent does not report swap", and only one
    // of them is true of an older agent.
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(metricPair(null, "1024")).toBe("—");
    expect(awgCell(null, null)).toBe("—");
  });

  it("still shows a real zero as a number", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(awgCell(true, 0)).toBe("up:0");
  });

  it("formats bytes short enough for a terminal column", () => {
    expect(formatBytes("361267200")).toBe("345MiB");
    expect(formatBytes("2097152")).toBe("2.0MiB");
    expect(metricPair("1073741824", "2147483648")).toBe("1.0GiB/2.0GiB");
  });

  it("reads a handshake as an age, not as a verdict", () => {
    // The panel cannot probe a node's public endpoint, so this is a real user's
    // connection succeeding. "never" is the honest answer for a node no peer
    // has reached, and it is not the same as "unreachable".
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(handshakeCell("2026-09-04T11:58:00.000Z", now)).toBe("2m ago");
    expect(handshakeCell(null, now)).toBe("never");
  });
});

describe("metricWarnings", () => {
  const healthy = {
    memAvailableBytes: "500000000",
    diskUsedPercent: 40,
    agentPidsCurrent: 12,
    agentPidsMax: 128,
    awg3Up: true,
  };

  it("says nothing about a healthy node", () => {
    expect(metricWarnings("node-1", healthy)).toEqual([]);
  });

  it("claims nothing about a node that has never been polled", () => {
    expect(metricWarnings("node-1", null)).toEqual([]);
  });

  it("names the three numbers the panel paints red", () => {
    const warnings = metricWarnings("node-1", {
      ...healthy,
      memAvailableBytes: String(METRIC_WARNINGS.memAvailableBytes - 1),
      diskUsedPercent: 90,
      agentPidsCurrent: 120,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/memory available/);
    expect(warnings[1]).toMatch(/docker image prune/);
    // The signature failure of a small host, and the one that looks like
    // nothing: a container at its task cap serves traffic and cannot fork.
    expect(warnings[2]).toMatch(/cannot fork/);
  });

  it("warns about a data plane that is down", () => {
    expect(metricWarnings("node-1", { ...healthy, awg3Up: false })).toEqual([
      "node-1: the AWG 3.1 interface is down",
    ]);
  });

  it("does not warn about an AWG 2.0 the node does not serve", () => {
    // null means "not reported", which on a 3.1-only node is the normal shape.
    expect(metricWarnings("node-1", { ...healthy, awg2Up: null })).toEqual([]);
  });
});
