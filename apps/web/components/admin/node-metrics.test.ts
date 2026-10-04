import { describe, expect, it } from "vitest";
import { barFraction, barTone, memoryUsedBytes } from "./node-metrics";

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
