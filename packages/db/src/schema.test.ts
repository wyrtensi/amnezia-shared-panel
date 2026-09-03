import { getTableName } from "drizzle-orm";
import { deviceTypeSchema } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";
import {
  auditEvents,
  deviceTypeEnum,
  identities,
  jobOutbox,
  nodes,
  peerCurrent,
  peerSamples,
  portalPolicy,
  quotaRequests,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnKeys,
} from "./schema.js";

describe("database schema", () => {
  it("exports every central domain table", () => {
    expect(
      [
        users,
        identities,
        nodes,
        vpnKeys,
        quotaRequests,
        peerCurrent,
        peerSamples,
        trafficRollups,
        routeRuleVersions,
        portalPolicy,
        auditEvents,
        jobOutbox,
      ].map(getTableName),
    ).toEqual([
      "users",
      "identities",
      "nodes",
      "vpn_keys",
      "quota_requests",
      "peer_current",
      "peer_samples",
      "traffic_rollups",
      "route_rule_versions",
      "portal_policy",
      "audit_events",
      "job_outbox",
    ]);
  });
});

// The DB enum used to be a hand-kept second copy of the contract's list. That
// is how "tablet" ended up offered by the UI but storable nowhere. This test is
// the copy's leash.
describe("device_type enum", () => {
  it("matches the contract exactly, in the same order", () => {
    expect(deviceTypeEnum.enumValues).toEqual(deviceTypeSchema.options);
  });
});
