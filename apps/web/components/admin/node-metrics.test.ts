import { describe, expect, it } from "vitest";
import { messages, type MessageKey } from "@/lib/i18n/messages";
import type { AdminNodeMetrics } from "@/lib/types";
import { barFraction, barTone, cpuCell, memoryUsedBytes } from "./node-metrics";

// The real English strings, so the assertions read like the card does.
const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
  messages.en[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && name in vars ? String(vars[name]) : match,
  );

const metricsWith = (overrides: Partial<AdminNodeMetrics>): AdminNodeMetrics => ({
  observedAt: "2026-10-10T00:00:00.000Z",
  agentLatencyMs: 12,
  uptimeSec: 3600,
  cpuCores: 2,
  load1: 0.42,
  load5: 0.4,
  load15: 0.37,
  cpuUsedPercent: null,
  cpuIowaitPercent: null,
  cpuStealPercent: null,
  cpuPerCorePercent: null,
  memTotalBytes: null,
  memAvailableBytes: null,
  swapTotalBytes: null,
  swapUsedBytes: null,
  diskTotalBytes: null,
  diskAvailableBytes: null,
  diskUsedPercent: null,
  agentPidsCurrent: null,
  agentPidsMax: null,
  awg3Up: null,
  awg3Peers: null,
  awg2Up: null,
  awg2Peers: null,
  listenPorts: null,
  ...overrides,
});

describe("cpuCell", () => {
  // The numbers from the host that prompted this: load average read 40-90 % of
  // its cores while the CPU itself was doing about a fifth of that.
  const reported = metricsWith({
    cpuUsedPercent: 23.4,
    cpuIowaitPercent: 18.9,
    cpuStealPercent: 0.5,
    cpuPerCorePercent: [30.1, 16.7],
  });

  it("shows real utilisation as a percent of every core", () => {
    const cell = cpuCell(reported, t);

    expect(cell.label).toBe("CPU");
    expect(cell.value).toBe("23%");
    expect(cell.bar?.fraction).toBeCloseTo(0.234);
    expect(cell.bar?.tone).toBe("ok");
  });

  it("puts each core, iowait, steal and the load average in the hover", () => {
    const lines = cpuCell(reported, t).hover.split("\n");

    expect(lines).toEqual([
      "CPU 23.4%",
      "core 0: 30.1%",
      "core 1: 16.7%",
      "iowait 18.9%",
      "steal 0.5%",
      "load 0.42 / 0.40 / 0.37",
    ]);
  });

  it("leaves out what the agent could not split", () => {
    // An empty per-core list arrives as null from the worker; iowait and steal
    // are null together with it on an agent that could not read /proc/stat.
    const lines = cpuCell(
      metricsWith({ cpuUsedPercent: 5, load1: null, load5: null, load15: null }),
      t,
    ).hover.split("\n");

    expect(lines).toEqual(["CPU 5.0%"]);
  });

  it("colours a busy host the way every other bar does", () => {
    expect(cpuCell(metricsWith({ cpuUsedPercent: 91 }), t).bar?.tone).toBe("bad");
  });

  it("falls back to load / cores, exactly as before, for an older agent", () => {
    const cell = cpuCell(metricsWith({}), t);

    expect(cell.label).toBe("Load / cores");
    expect(cell.value).toBe("0.42 / 2");
    // The hover is the figure itself, like every other cell.
    expect(cell.hover).toBe("0.42 / 2");
    expect(cell.bar).toEqual({ fraction: 0.21, tone: "ok" });
  });

  it("shows a dash when the node reported neither", () => {
    const cell = cpuCell(metricsWith({ load1: null }), t);

    expect(cell.value).toBe("—");
    expect(cell.bar).toBeNull();
  });
});

describe("memoryUsedBytes", () => {
  // The numbers a live 1 GB node reported while the row above it claimed the
  // machine was using 280 MB: 961 MiB total, 280 MiB available, so 681 MiB in
  // use. `free -m` on that host agreed.
  it("reports what is in use, not what is left", () => {
    const total = String(1008201728);
    const available = String(293285888);
    expect(memoryUsedBytes(total, available)).toBe(String(1008201728 - 293285888));
  });

  it("accepts numbers as well as the strings a bigint column serialises to", () => {
    expect(memoryUsedBytes(1024, 256)).toBe("768");
  });

  it("has no answer when either side is missing", () => {
    // An agent that could not read /proc/meminfo reports no availableBytes, and
    // guessing from freeBytes there would count the page cache as used.
    expect(memoryUsedBytes(1024, null)).toBeNull();
    expect(memoryUsedBytes(null, 256)).toBeNull();
    expect(memoryUsedBytes(undefined, undefined)).toBeNull();
  });

  it("refuses a negative result rather than rendering one", () => {
    expect(memoryUsedBytes(256, 1024)).toBeNull();
  });

  it("survives a value that is not a number at all", () => {
    expect(memoryUsedBytes("many", 256)).toBeNull();
  });
});

describe("barFraction", () => {
  it("is the share of the ceiling", () => {
    expect(barFraction(12, 128)).toBeCloseTo(0.09375);
  });

  it("clamps an overloaded host to a full bar", () => {
    // load1 of 3.2 on one core
    expect(barFraction(3.2, 1)).toBe(1);
  });

  it("has no bar rather than an empty one when a side is missing", () => {
    expect(barFraction(null, 100)).toBeNull();
    expect(barFraction(5, null)).toBeNull();
    // Swap disabled: 0 / 0 is not "0 % used".
    expect(barFraction(0, 0)).toBeNull();
    expect(barFraction(Number.NaN, 10)).toBeNull();
  });
});

describe("barTone", () => {
  it("steps from ok to warn to bad", () => {
    expect(barTone(0.45)).toBe("ok");
    expect(barTone(0.7)).toBe("warn");
    expect(barTone(0.85)).toBe("bad");
  });

  it("goes red when the metric's own threshold says so", () => {
    expect(barTone(0.3, true)).toBe("bad");
  });
});
