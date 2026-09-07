import { describe, expect, it } from "vitest";
import {
  AUDIT_CATEGORIES as CONTRACT_CATEGORIES,
  auditCategoryOf,
  auditScopeOf,
  isPurgeableKeyState,
} from "@amnezia/contracts";

import {
  AUDIT_CATEGORIES,
  auditEventMatches,
  cliAuditCategoryOf,
  cliAuditScopeOf,
} from "./auditFilter.js";
import { cliIsPurgeableKeyState } from "./main.js";

// The actual cross-check for the structural copy, not two literals each pinning
// their own side: the CLI ships dependency-free, so this is the only thing that
// catches the contract's mapping moving without it.
describe("the copy agrees with @amnezia/contracts", () => {
  it("folds every target spelling the same way", () => {
    const targets = [
      "vpn_key",
      "keys",
      "user",
      "users",
      "node",
      "nodes",
      "portal_policy",
      "portal-policy",
      "route_rule",
      "rule_version",
      "rules",
      "access_policy",
      "access-sync",
      "service_check",
      "service-checks",
      "quota_request",
      "quota-requests",
      "something_the_cli_has_never_seen",
      "",
    ];
    for (const target of targets) {
      expect(cliAuditCategoryOf(target), target).toBe(auditCategoryOf(target));
    }
  });

  it("splits actors the same way", () => {
    for (const actor of ["system", "user", "admin", ""]) {
      expect(cliAuditScopeOf(actor), actor).toBe(auditScopeOf(actor));
    }
  });

  it("offers the same category list", () => {
    expect(AUDIT_CATEGORIES).toEqual([...CONTRACT_CATEGORIES]);
  });
});

describe("auditEventMatches", () => {
  const event = { actorType: "user", targetType: "vpn_key" };

  it("passes everything when nothing is asked for", () => {
    expect(auditEventMatches(event, {})).toBe(true);
  });

  it("separates the panel's own work from a person's", () => {
    expect(auditEventMatches(event, { actor: "people" })).toBe(true);
    expect(auditEventMatches(event, { actor: "system" })).toBe(false);
    expect(
      auditEventMatches({ ...event, actorType: "system" }, { actor: "system" }),
    ).toBe(true);
  });

  it("matches a category across both spellings of its target", () => {
    for (const targetType of ["vpn_key", "keys"]) {
      expect(
        auditEventMatches({ ...event, targetType }, { category: "keys" }),
      ).toBe(true);
    }
    expect(
      auditEventMatches({ ...event, targetType: "node" }, { category: "keys" }),
    ).toBe(false);
  });

  it("ands the two filters rather than oring them", () => {
    expect(
      auditEventMatches(
        { actorType: "system", targetType: "vpn_key" },
        { actor: "people", category: "keys" },
      ),
    ).toBe(false);
  });
});

// `keys-purge-revoked` decides locally which keys to LIST, so its idea of
// "purgeable" has to be the server's or the preview lies about what the run
// will do. Same cross-check as the mappings above, for the same reason.
describe("cliIsPurgeableKeyState", () => {
  it("agrees with isPurgeableKeyState in @amnezia/contracts", () => {
    for (const state of [
      "revoked",
      "active",
      "disabled",
      "provisioning",
      "revoking",
      "failed",
      "",
    ]) {
      expect(cliIsPurgeableKeyState(state), state).toBe(
        isPurgeableKeyState(state),
      );
    }
  });
});
