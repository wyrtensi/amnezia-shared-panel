import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditEvents,
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
