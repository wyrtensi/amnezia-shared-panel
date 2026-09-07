import { describe, expect, it } from "vitest";
import { memoryUsedBytes } from "./node-metrics";

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
