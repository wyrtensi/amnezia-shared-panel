import { describe, it, expect } from "vitest";
import {
  flagOf,
  formatUpdateStatus,
  positionals,
  csvList,
  parseNodeLimits,
  parseNodeSpec,
} from "./args.js";

describe("flagOf", () => {
  it("reads --name=value and preserves '=' in the value", () => {
    expect(flagOf(["--a=1", "--b=x=y"], "b")).toBe("x=y");
  });
  it("is undefined for a missing flag", () => {
    expect(flagOf(["--a=1"], "z")).toBeUndefined();
  });
});

describe("positionals", () => {
  it("keeps only non-flag args", () => {
    expect(positionals(["x", "--a=1", "y"])).toEqual(["x", "y"]);
  });
});

describe("csvList", () => {
  it("trims and drops empties", () => {
    expect(csvList(" a , b ,,c ")).toEqual(["a", "b", "c"]);
    expect(csvList("")).toEqual([]);
  });
});

describe("parseNodeSpec", () => {
  it("maps all -> null (every node)", () => {
    expect(parseNodeSpec("all")).toBeNull();
  });
  it("maps none -> [] (no node)", () => {
    expect(parseNodeSpec("none")).toEqual([]);
  });
  it("maps a csv to a trimmed list", () => {
    expect(parseNodeSpec("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("parseNodeLimits", () => {
  const nodeA = "11111111-1111-4111-8111-111111111111";
  const nodeB = "22222222-2222-4222-8222-222222222222";

  it("parses a <nodeId>:<n> list", () => {
    expect(parseNodeLimits(`${nodeA}:2, ${nodeB}:0`)).toEqual({
      [nodeA]: 2,
      [nodeB]: 0,
    });
  });

  it("clears every per-node limit for an empty value, 'none' or 'clear'", () => {
    expect(parseNodeLimits("")).toBeNull();
    expect(parseNodeLimits("none")).toBeNull();
    expect(parseNodeLimits("clear")).toBeNull();
  });

  it("rejects a malformed entry or an out-of-range limit", () => {
    expect(() => parseNodeLimits(nodeA)).toThrowError(/expected <nodeId>:<n>/);
    expect(() => parseNodeLimits(`${nodeA}:`)).toThrowError(/integer 0\.\.1000/);
    expect(() => parseNodeLimits(`${nodeA}:-1`)).toThrowError(/integer 0\.\.1000/);
    expect(() => parseNodeLimits(`${nodeA}:1001`)).toThrowError(/integer 0\.\.1000/);
    expect(() => parseNodeLimits(`${nodeA}:two`)).toThrowError(/integer 0\.\.1000/);
  });
});

describe("formatUpdateStatus", () => {
  it("says when the mechanism is not installed", () => {
    expect(formatUpdateStatus({ enabled: false, pending: null, lastResult: null }))
      .toBe("update mechanism not configured on this host");
  });
  it("shows a request that is still queued", () => {
    const shown = formatUpdateStatus({
      enabled: true,
      pending: { id: "req-1", requestedAt: "2026-09-02T10:00:00.000Z" },
      lastResult: null,
    });
    expect(shown).toContain("pending");
    expect(shown).toContain("req-1");
  });
  it("shows a REFUSED run and its reason — the case that is silent today", () => {
    const shown = formatUpdateStatus({
      enabled: true,
      pending: null,
      lastResult: { id: "unknown", ok: false, error: "request file is not a regular spool file" },
    });
    expect(shown).toContain("FAILED");
    expect(shown).toContain("regular spool file");
  });
  it("shows a successful run", () => {
    const shown = formatUpdateStatus({
      enabled: true, pending: null, lastResult: { id: "req-1", ok: true },
    });
    expect(shown).toContain("ok");
    expect(shown).toContain("req-1");
  });
});
