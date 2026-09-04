import type { nodeMetricsCurrent } from "@amnezia/db";

import type { NodeSnapshot } from "./telemetry.js";

export type NodeMetricsRow = typeof nodeMetricsCurrent.$inferInsert;

/**
 * Default only. The live value is `NODE_METRICS_SAMPLE_SEC`, because this
 * number decides how fast a table grows and that is an operator's call.
 */
export const DEFAULT_METRICS_SAMPLE_SEC = 300;

/**
 * A byte counter as bigint, or null.
 *
 * Anything the agent did not report stays null rather than becoming 0: a zero
 * here reads as a measurement ("this host has no swap", "the disk is empty")
 * and would be indistinguishable from one on the card.
 */
const toBigint = (value: number | null | undefined): bigint | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? BigInt(Math.round(value))
    : null;

const toNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One node's `/server` + `/server/load` reply as a row. Every field is
 * null-safe in both directions: an agent that predates a field omits it, and an
 * agent that cannot read one reports null.
 */
export const toNodeMetricsRow = (snapshot: NodeSnapshot): NodeMetricsRow => {
  const load = snapshot.load;
  const swap = load.swap ?? null;
  const awg2 = load.awg?.amneziawg2 ?? null;
  const awg3 = load.awg?.amneziawg3 ?? null;

  return {
    nodeId: snapshot.nodeId,
    observedAt: snapshot.observedAt,
    agentLatencyMs: snapshot.agentLatencyMs,
    uptimeSec: Math.round(load.uptimeSec),
    cpuCores: load.cpu.cores,
    load1: toNumber(load.loadavg[0]),
    load5: toNumber(load.loadavg[1]),
    load15: toNumber(load.loadavg[2]),
    memTotalBytes: toBigint(load.memory.totalBytes),
    memAvailableBytes: toBigint(load.memory.availableBytes),
    swapTotalBytes: toBigint(swap?.totalBytes),
    swapUsedBytes: toBigint(swap?.usedBytes),
    diskTotalBytes: toBigint(load.disk?.totalBytes),
    diskAvailableBytes: toBigint(load.disk?.availableBytes),
    diskUsedPercent: toNumber(load.disk?.usedPercent),
    agentPidsCurrent: toNumber(load.agent?.pidsCurrent),
    agentPidsMax: toNumber(load.agent?.pidsMax),
    awg3Up: awg3 ? awg3.up : null,
    awg3Peers: awg3 ? awg3.peers : null,
    awg2Up: awg2 ? awg2.up : null,
    awg2Peers: awg2 ? awg2.peers : null,
    publicHost: snapshot.publicHost,
    listenPorts: snapshot.server.listenPorts ?? null,
  };
};

/**
 * Whether this observation earns a history row.
 *
 * `node_metrics_samples` grows per node per period forever, so the period is a
 * parameter rather than a constant: it is configurable, and a constant here
 * would be one more place the number lives and drifts.
 */
export const shouldStoreMetricsSample = (
  observedAt: Date,
  previousSampledAt: Date | null,
  sampleIntervalMs: number,
): boolean =>
  previousSampledAt === null ||
  observedAt.getTime() - previousSampledAt.getTime() >= sampleIntervalMs;
