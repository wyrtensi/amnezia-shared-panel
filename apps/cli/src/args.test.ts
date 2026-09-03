import { describe, it, expect } from "vitest";
import {
  DEVICE_TYPES,
  DEVICE_TYPE_ORDER,
  RETIRED_DEVICE_TYPES,
  deviceTypeUsage,
  flagOf,
  formatDeviceType,
  formatUpdateStatus,
  parseDeviceType,
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

describe("parseDeviceType", () => {
  // This literal is the same one packages/contracts/src/contracts.test.ts
  // asserts against deviceTypeSchema.options. The CLI ships with no
  // dependencies, so the list is copied and both copies are pinned here.
  it("is exactly the contract's device types, in the same order", () => {
    expect([...DEVICE_TYPES]).toEqual([
      "android",
      "ios",
      "macos",
      "windows",
      "linux",
      "other",
      "unspecified",
    ]);
  });

  it("accepts every current device type", () => {
    for (const device of DEVICE_TYPES) {
      expect(parseDeviceType(device)).toBe(device);
    }
  });

  it("names the replacement for a retired value", () => {
    expect(() => parseDeviceType("iphone")).toThrow(
      '--device-type="iphone" was retired — use ios',
    );
    expect(() => parseDeviceType("laptop")).toThrow(
      '--device-type="laptop" was retired — use windows, macos or linux',
    );
    expect(() => parseDeviceType("desktop")).toThrow(
      '--device-type="desktop" was retired — use windows, macos or linux',
    );
    expect(() => parseDeviceType("phone")).toThrow(
      '--device-type="phone" was retired — use android or ios',
    );
    expect(() => parseDeviceType("tablet")).toThrow(
      '--device-type="tablet" was retired — use android or ios',
    );
  });

  it("lists the valid values for anything else", () => {
    expect(() => parseDeviceType("router")).toThrow(
      '--device-type expects one of android, ios, macos, windows, linux, other, unspecified; got "router"',
    );
    expect(() => parseDeviceType("")).toThrow("--device-type expects one of");
  });
});

describe("DEVICE_TYPE_ORDER", () => {
  // D2 says this order exists so the CLI's usage text, the docs and the wizard
  // list the same six values in the same sequence. Hand-typing it into three
  // strings with no test is the drift this whole item exists to kill.
  it("is exactly the contract's offered order", () => {
    expect([...DEVICE_TYPE_ORDER]).toEqual([
      "android", "ios", "macos", "windows", "linux", "other",
    ]);
  });

  it("is a subset of DEVICE_TYPES, missing only unspecified", () => {
    expect(DEVICE_TYPE_ORDER.every((v) => DEVICE_TYPES.includes(v))).toBe(true);
    expect(
      DEVICE_TYPES.filter(
        (v) => !(DEVICE_TYPE_ORDER as readonly string[]).includes(v),
      ),
    ).toEqual(["unspecified"]);
  });

  it("builds the usage fragment, so the string cannot drift from the list", () => {
    expect(deviceTypeUsage()).toBe(
      "--device-type=android|ios|macos|windows|linux|other",
    );
  });
});

describe("RETIRED_DEVICE_TYPES", () => {
  it("names every value the contract retires, and nothing else", () => {
    // The contract's LEGACY_DEVICE_TYPE_REPLACEMENT is the authority. `tablet`
    // is in both even though it never existed in the database — it was the
    // phantom wizard value that produced the 400 this plan fixes, so an
    // operator who types it must still be told what to use instead.
    expect(Object.keys(RETIRED_DEVICE_TYPES).sort()).toEqual(
      ["desktop", "iphone", "laptop", "phone", "tablet"],
    );
  });
});

describe("parseDeviceType — unspecified", () => {
  it("accepts it explicitly, because a bulk import may need to say so", () => {
    // Deliberately NOT rejected: it is a real stored value. It is left out of
    // DEVICE_TYPE_ORDER because the wizard does not offer it, and documented in
    // docs/CLI.md so the spelling is discoverable.
    expect(parseDeviceType("unspecified")).toBe("unspecified");
  });
});

describe("formatDeviceType", () => {
  it("renders the unset platform as a dash", () => {
    expect(formatDeviceType("unspecified")).toBe("—");
    expect(formatDeviceType(undefined)).toBe("—");
  });
  it("prints a real platform as itself", () => {
    expect(formatDeviceType("ios")).toBe("ios");
  });
  it("prints a legacy value verbatim rather than crashing or hiding it", () => {
    // D7's rule for the web: an unknown string is shown, never mapped to a
    // message key. A pre-migration row must be visible, not silently blank.
    expect(formatDeviceType("laptop")).toBe("laptop");
  });
});
