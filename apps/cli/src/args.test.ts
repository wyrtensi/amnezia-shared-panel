import { describe, it, expect } from "vitest";
import {
  DEVICE_TYPES,
  DEVICE_TYPE_ORDER,
  RETIRED_DEVICE_TYPES,
  deviceTypeUsage,
  flagOf,
  formatAccessSyncStatus,
  formatDeviceType,
  formatUpdateStatus,
  parseDeviceType,
  positionals,
  csvList,
  parseNodeLimits,
  parseNodeSpec,
  KEY_LIMIT_MODES,
  effectiveKeyLimitMode,
  parseEnumFlag,
  parseKeyLimitMode,
  quotaCurrentLimit,
  annotateNodeOrder,
  checkRecommendedPrefix,
  formatPolicyValue,
  matchesNodeFilter,
  parsePolicyNodeList,
  quotaTargetLabel,
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

describe("formatAccessSyncStatus", () => {
  it("says when nothing has ever been requested", () => {
    expect(formatAccessSyncStatus({ status: "idle" })).toBe(
      "no reconcile requested yet",
    );
  });
  it("shows a queued run and when it was queued", () => {
    expect(
      formatAccessSyncStatus({
        status: "pending",
        queuedAt: "2026-09-05T09:00:00.000Z",
      }),
    ).toBe("pending since 2026-09-05T09:00:00.000Z");
  });
  it("shows a run in flight", () => {
    expect(formatAccessSyncStatus({ status: "processing" })).toBe("running");
  });
  it("shows a completed run and when it finished", () => {
    expect(
      formatAccessSyncStatus({
        status: "completed",
        completedAt: "2026-09-05T09:00:10.000Z",
      }),
    ).toBe("completed at 2026-09-05T09:00:10.000Z");
  });
  it("shows a REFUSED run and its reason — deliberately not reported as success", () => {
    expect(
      formatAccessSyncStatus({
        status: "failed",
        lastError: "aborted: 12 account(s) would be disabled",
      }),
    ).toBe("failed: aborted: 12 account(s) would be disabled");
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

describe("KEY_LIMIT_MODES", () => {
  // The same literal packages/contracts/src/contracts.test.ts asserts against
  // keyLimitModeSchema.options. Copied, not imported — the CLI has no deps.
  it("is exactly the contract's modes, in the same order", () => {
    expect([...KEY_LIMIT_MODES]).toEqual(["per_node", "global"]);
  });
});

describe("parseKeyLimitMode", () => {
  it("accepts the two real modes", () => {
    expect(parseKeyLimitMode("global")).toBe("global");
    expect(parseKeyLimitMode("per_node")).toBe("per_node");
  });
  it("maps inherit to null, which clears the per-user override", () => {
    expect(parseKeyLimitMode("inherit")).toBeNull();
  });
  it("names the three accepted words for anything else", () => {
    expect(() => parseKeyLimitMode("total")).toThrowError(
      /--mode must be per_node, global or inherit/,
    );
    expect(() => parseKeyLimitMode("")).toThrowError(
      /per_node, global or inherit/,
    );
  });
});

describe("parseEnumFlag", () => {
  it("returns an allowed value unchanged", () => {
    expect(parseEnumFlag("keyLimitMode", "global", ["per_node", "global"])).toBe(
      "global",
    );
  });
  it("lists the allowed values in the error", () => {
    expect(() =>
      parseEnumFlag("keyLimitMode", "x", ["per_node", "global"]),
    ).toThrowError(/--keyLimitMode must be one of per_node, global/);
  });
  it("does not accept 'inherit' here — the global switch has no inherit", () => {
    expect(() =>
      parseEnumFlag("keyLimitMode", "inherit", ["per_node", "global"]),
    ).toThrowError(/must be one of/);
  });
});

describe("effectiveKeyLimitMode", () => {
  // The CLI-side mirror of the API's resolution: the per-user override wins,
  // and anything unrecognised falls back to per_node — the pre-mode behaviour
  // and therefore the safe default.
  it("prefers the per-user override over the global mode", () => {
    expect(effectiveKeyLimitMode("per_node", "global")).toBe("global");
  });
  it("falls back to the global mode when the user has no override", () => {
    expect(effectiveKeyLimitMode("global", undefined)).toBe("global");
    expect(effectiveKeyLimitMode("global", null)).toBe("global");
  });
  it("falls back to per_node for anything unrecognised", () => {
    expect(effectiveKeyLimitMode(undefined, "bogus")).toBe("per_node");
    expect(effectiveKeyLimitMode(undefined, undefined)).toBe("per_node");
  });
});

describe("quotaCurrentLimit", () => {
  const user = { keyLimitOverride: 3, nodeKeyLimits: { n1: 1 } };

  it("prefers a per-node entry in per_node mode", () => {
    expect(quotaCurrentLimit("per_node", user, "n1", 5)).toBe("1");
  });
  it("IGNORES per-node entries in global mode — they are dormant", () => {
    // The bug this test exists to stop: without the mode, the CLI would print
    // "1 → 8" for a user whose real pool is 3, right before quota-approve.
    expect(quotaCurrentLimit("global", user, "n1", 5)).toBe("3");
  });
  it("falls back to the policy default when nothing is overridden", () => {
    expect(
      quotaCurrentLimit(
        "global",
        { keyLimitOverride: null, nodeKeyLimits: null },
        null,
        5,
      ),
    ).toBe("5");
    expect(
      quotaCurrentLimit(
        "per_node",
        { keyLimitOverride: null, nodeKeyLimits: null },
        "n1",
        5,
      ),
    ).toBe("5");
  });
  it("says 'default' when even the policy default is unknown", () => {
    // A panel older than this field, or a request whose user is gone: the cell
    // must still render rather than printing "undefined".
    expect(quotaCurrentLimit("per_node", {}, null, undefined)).toBe("default");
  });
});

describe("quotaTargetLabel", () => {
  it("names the server in per_node mode", () => {
    expect(quotaTargetLabel("per_node", "frankfurt")).toBe("frankfurt");
    expect(quotaTargetLabel("per_node", null)).toBe("all servers");
  });
  it("says the named server is coerced away in global mode", () => {
    // Approving this grants a total, not a per-server limit, and the admin
    // must see that before they type quota-approve.
    expect(quotaTargetLabel("global", "frankfurt")).toBe(
      "all servers (request named frankfurt)",
    );
    expect(quotaTargetLabel("global", null)).toBe("all servers");
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

describe("matchesNodeFilter", () => {
  it("keeps every key when no filter is given", () => {
    expect(matchesNodeFilter("n1", undefined)).toBe(true);
  });

  it("keeps only the named node", () => {
    expect(matchesNodeFilter("n1", "n1")).toBe(true);
    expect(matchesNodeFilter("n2", "n1")).toBe(false);
  });

  it("is case-insensitive, because ids are pasted from other output", () => {
    expect(matchesNodeFilter("A1B2", "a1b2")).toBe(true);
  });
});

describe("parsePolicyNodeList", () => {
  const nodeA = "11111111-1111-4111-8111-111111111111";
  const nodeB = "22222222-2222-4222-8222-222222222222";

  it("keeps the given order — the order IS the value", () => {
    expect(parsePolicyNodeList(`${nodeB}, ${nodeA}`)).toEqual([nodeB, nodeA]);
  });

  it("clears the list for 'none' and for an empty value", () => {
    expect(parsePolicyNodeList("none")).toEqual([]);
    expect(parsePolicyNodeList("")).toEqual([]);
  });

  it("rejects 'all', which means nothing for these lists", () => {
    // `allowedNodeIds` takes "all"; recommending or ordering "all" does not
    // parse, and must say so rather than posting a literal ["all"].
    expect(() => parsePolicyNodeList("all")).toThrow(/all/);
  });
});

describe("formatPolicyValue", () => {
  const nodeA = "11111111-1111-4111-8111-111111111111";

  it("prints an empty allowed-node list as (all)", () => {
    expect(formatPolicyValue("allowedNodeIds", [])).toBe("(all)");
    expect(formatPolicyValue("allowedNodeIds", null)).toBe("(all)");
  });

  it("prints an empty recommended list and an empty order as (none)", () => {
    expect(formatPolicyValue("recommendedNodeIds", [])).toBe("(none)");
    expect(formatPolicyValue("nodeOrder", [])).toBe("(none)");
  });

  it("joins a non-empty list and stringifies scalars", () => {
    expect(formatPolicyValue("nodeOrder", [nodeA, nodeA])).toBe(
      `${nodeA},${nodeA}`,
    );
    expect(formatPolicyValue("defaultKeyLimit", 10)).toBe("10");
    expect(formatPolicyValue("allowKeyCreation", false)).toBe("false");
  });
});

describe("annotateNodeOrder", () => {
  const a = { id: "a", name: "zurich" };
  const b = { id: "b", name: "frankfurt" };
  const c = { id: "c", name: "amsterdam" };

  it("puts positioned nodes in the stored order, not in name order", () => {
    // The whole point of the feature: `nodes` must show what a user sees.
    expect(
      annotateNodeOrder([a, b, c], ["b", "a"], []).map((r) => r.name),
    ).toEqual(["frankfurt", "zurich", "amsterdam"]);
  });

  it("ranks positioned nodes from one and marks the rest", () => {
    const rows = annotateNodeOrder([a, b], ["b"], []);
    expect(rows.map((r) => r.rank)).toEqual(["1", "-"]);
  });

  it("sorts unpositioned nodes after, by name", () => {
    expect(annotateNodeOrder([a, c], [], []).map((r) => r.name)).toEqual([
      "amsterdam",
      "zurich",
    ]);
  });

  it("ignores an id in the order that names no node", () => {
    // A node deleted between the two reads must not leave a hole or throw.
    expect(annotateNodeOrder([a], ["gone", "a"], []).map((r) => r.rank)).toEqual(
      ["1"],
    );
  });

  it("marks exactly the recommended ids", () => {
    expect(
      annotateNodeOrder([a, b], ["a", "b"], ["a"]).map((r) => r.rec),
    ).toEqual(["yes", ""]);
  });

  it("does not mutate its input", () => {
    const rows = [a, b];
    annotateNodeOrder(rows, ["b", "a"], []);
    expect(rows).toEqual([a, b]);
  });
});

describe("checkRecommendedPrefix", () => {
  it("accepts an empty recommended list against any order", () => {
    expect(checkRecommendedPrefix([], ["a", "b"])).toEqual({ ok: true });
  });

  it("accepts a true prefix regardless of the order it is written in", () => {
    expect(checkRecommendedPrefix(["b", "a"], ["a", "b", "c"])).toEqual({
      ok: true,
    });
  });

  it("names a recommended node that is not in the prefix", () => {
    expect(checkRecommendedPrefix(["a", "c"], ["a", "b", "c"])).toEqual({
      ok: false,
      nodeId: "c",
      reason: "behind",
    });
  });

  it("names a recommended node that is not in the order at all", () => {
    expect(checkRecommendedPrefix(["x"], ["a", "b"])).toEqual({
      ok: false,
      nodeId: "x",
      reason: "unpositioned",
    });
    expect(checkRecommendedPrefix(["a"], [])).toEqual({
      ok: false,
      nodeId: "a",
      reason: "unpositioned",
    });
  });
});
