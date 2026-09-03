import { describe, expect, it } from "vitest";

import { messages } from "./i18n/messages";
import {
  effectiveKeyLimitMode,
  isAtLimit,
  isNodeFull,
  isPoolExhausted,
} from "./key-quota";

const nodes = [
  { nodeId: "a", used: 2, limit: 2 },
  { nodeId: "b", used: 0, limit: 2 },
];

describe("effectiveKeyLimitMode", () => {
  it("prefers a valid per-user override and falls back to the global mode", () => {
    expect(effectiveKeyLimitMode("per_node", "global")).toBe("global");
    expect(effectiveKeyLimitMode("global", "per_node")).toBe("per_node");
    expect(effectiveKeyLimitMode("global", undefined)).toBe("global");
    expect(effectiveKeyLimitMode(undefined, null)).toBe("per_node");
    expect(effectiveKeyLimitMode("global", "bogus")).toBe("global");
  });
});

describe("isNodeFull / isPoolExhausted / isAtLimit", () => {
  it("per-node mode looks at the node only", () => {
    const totals = { used: 2, limit: 9 };
    expect(isNodeFull("per_node", nodes[0]!, totals)).toBe(true);
    expect(isNodeFull("per_node", nodes[1]!, totals)).toBe(false);
    expect(isAtLimit("per_node", nodes, totals)).toBe(false);
    expect(isAtLimit("per_node", [nodes[0]!], totals)).toBe(true);
  });

  it("global mode looks at the pool only, on every node", () => {
    const full = { used: 2, limit: 2 };
    expect(isPoolExhausted("global", full)).toBe(true);
    expect(isNodeFull("global", nodes[1]!, full)).toBe(true);
    expect(isAtLimit("global", nodes, full)).toBe(true);
    const room = { used: 1, limit: 2 };
    expect(isNodeFull("global", nodes[0]!, room)).toBe(false);
    expect(isAtLimit("global", nodes, room)).toBe(false);
  });

  it("treats no servers as at the limit in both modes", () => {
    expect(isAtLimit("per_node", [], { used: 0, limit: 5 })).toBe(true);
    expect(isAtLimit("global", [], { used: 0, limit: 5 })).toBe(true);
  });

  // The pool is only consulted in global mode: a per-node view must keep
  // working on a payload whose totals are stale or missing a real limit.
  it("ignores the pool entirely in per-node mode", () => {
    expect(isPoolExhausted("per_node", { used: 99, limit: 1 })).toBe(false);
    expect(isNodeFull("per_node", nodes[1]!, { used: 99, limit: 1 })).toBe(
      false,
    );
  });
});

// Tasks 6-9 render these keys; the `satisfies` guard only proves ru and en
// agree, not that a key the UI asks for exists at all.
describe("key limit mode strings", () => {
  it("exist in both languages", () => {
    for (const key of [
      "emp.quotaTotal",
      "quota.cellsIssuedAria",
      "quota.noKeysOnServer",
      "wizard.serverKeys",
      "wizard.serverQuotaHintGlobal",
      "wizard.poolFull",
      "quota.willBecomeTotal",
      "ov.quotaTargetCoerced",
      "users.limitNode",
      "users.limitModeGlobalShort",
      "users.limitModePerNodeShort",
      "users.limitMode",
      "users.limitModeHint",
      "users.limitModeInherit",
      "users.limitModePerNode",
      "users.limitModeGlobal",
      "users.limitLabelGlobal",
      "users.limitLabelGlobalHint",
      "users.limitPerNodeDormant",
      "policy.keyLimitGlobal",
      "policy.keyLimitGlobalHint",
      "gpolicy.keyLimitMode",
      "gpolicy.keyLimitModeHint",
    ]) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });

  it("carries the renamed admin limit button label", () => {
    expect(messages.ru["users.limitNode"]).toBe("Лимиты и серверы:");
    expect(messages.en["users.limitNode"]).toBe("Limits and servers:");
  });
});
