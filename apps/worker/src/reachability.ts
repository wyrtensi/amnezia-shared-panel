import {
  isProbeStale,
  REACHABILITY_NOTIFY_JOB_TYPE,
  type ProbeLevel,
  type ProbeLevels,
  type ProbeTargetResult,
  type ProtocolKind,
  type ReachabilityStatus,
} from "@amnezia/contracts";

/**
 * Status rules and the alert state machine for the external reachability
 * probe. Pure: the worker task loads state, calls these, and writes the result
 * and the queued messages in one transaction.
 */

/** One (node, protocol) pair the panel asked the probe to test. */
export type ReachabilityTarget = {
  targetId: string;
  nodeId: string;
  nodeName: string;
  publicIp: string | null;
  protocol: ProtocolKind;
  /** Set when the panel could not send this target (no usable service key). */
  unavailableReason: string | null;
};

export type NodeState = {
  status: ReachabilityStatus;
  consecutiveFailures: number;
  failingSince: Date | null;
  /** Set while an incident is open: an unavailable message was queued. */
  alertedAt: Date | null;
  alertKind: "node" | "mass" | null;
  checkedAt: Date;
  detail: string | null;
};

export type ProtocolOutcome = {
  nodeId: string;
  protocol: ProtocolKind;
  status: ReachabilityStatus;
  levels: ProbeLevels | null;
  egressIp: string | null;
  detail: string | null;
};

export type Notice = { dedupKey: string; text: string };

const MAX_DETAIL = 300;
const key = (kind: string, ...parts: string[]) =>
  [REACHABILITY_NOTIFY_JOB_TYPE, kind, ...parts].join(":");

const clip = (value: string | null | undefined): string | null =>
  value ? value.slice(0, MAX_DETAIL) : null;

const error = (target: ReachabilityTarget, detail: string): ProtocolOutcome => ({
  nodeId: target.nodeId,
  protocol: target.protocol,
  status: "error",
  levels: null,
  egressIp: null,
  detail: clip(detail),
});

/**
 * The verdict for one target. `failed` is only ever a measurement: the
 * control passed and the tunnel did not work. Anything that stopped the probe
 * from measuring is `error`, which never reads as "blocked".
 */
export const classifyTarget = (
  target: ReachabilityTarget,
  result: ProbeTargetResult | undefined,
  controlOk: boolean,
): ProtocolOutcome => {
  if (!controlOk) return error(target, "control target failed");
  if (target.unavailableReason) return error(target, target.unavailableReason);
  if (!result) return error(target, "probe returned no result");
  if (result.status === "error") return error(target, result.detail ?? "probe error");

  const { handshake, http } = result.levels;
  const ok = handshake.ok === true && http.ok === true;
  const detail = ok
    ? null
    : handshake.ok !== true
      ? "no handshake"
      : (http.detail ?? "no traffic through the tunnel");
  return {
    nodeId: target.nodeId,
    protocol: target.protocol,
    status: ok ? "ok" : "failed",
    levels: result.levels,
    egressIp: result.egressIp,
    detail: clip(detail),
  };
};

/** A node is reachable when any protocol it serves is. */
export const nodeStatus = (outcomes: readonly ProtocolOutcome[]): ReachabilityStatus => {
  if (outcomes.some((o) => o.status === "ok")) return "ok";
  if (outcomes.some((o) => o.status === "failed")) return "failed";
  return "error";
};

const pad = (n: number) => String(n).padStart(2, "0");
const utc = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

const yesNo = (level: ProbeLevel | undefined) =>
  level?.ok === true ? "да" : level?.ok === false ? "нет" : "—";

type NodeLine = { nodeName: string; publicIp: string | null };
const who = (node: NodeLine) => `${node.nodeName} (${node.publicIp ?? "?"})`;

export const formatDown = (
  node: NodeLine,
  label: string,
  levels: ProbeLevels | null,
  since: Date,
): string =>
  `${who(node)} недоступен из ${label}\n` +
  `handshake: ${yesNo(levels?.handshake)}, tcp/22: ${yesNo(levels?.tcp)}, ping: ${yesNo(levels?.ping)}\n` +
  `с ${utc(since)} UTC`;

export const formatUp = (node: NodeLine, label: string): string =>
  `${who(node)} снова доступен из ${label}`;

export const formatMassDown = (names: readonly string[], label: string): string =>
  `Проверка из ${label}: ни одна нода не ответила (${names.length}): ${names.join(", ")}. ` +
  "Возможно, сломалась сама проверка.";

export const formatMassUp = (names: readonly string[], label: string): string =>
  `Проверка из ${label}: снова доступны ${names.join(", ")}`;

export const formatStale = (label: string, since: Date): string =>
  `Проверка из ${label} не присылает результатов с ${utc(since)} UTC`;

export const formatStaleBack = (label: string): string =>
  `Проверка из ${label} снова работает`;

const initialState = (now: Date): NodeState => ({
  status: "error",
  consecutiveFailures: 0,
  failingSince: null,
  alertedAt: null,
  alertKind: null,
  checkedAt: now,
  detail: null,
});

export type IngestInput = {
  runId: string;
  now: Date;
  label: string;
  failThreshold: number;
  controlOk: boolean;
  targets: readonly ReachabilityTarget[];
  results: readonly ProbeTargetResult[];
  previous: ReadonlyMap<string, NodeState>;
};

export type IngestOutput = {
  outcomes: ProtocolOutcome[];
  states: Map<string, NodeState>;
  notices: Notice[];
};

/**
 * Apply one finished run to every node it covered.
 *
 * - `ok` closes an open incident with a recovery message and resets the count;
 * - `failed` counts; reaching `failThreshold` opens an incident with one
 *   unavailable message, and further failures send nothing;
 * - `error` records itself and leaves the count, `failingSince` and any open
 *   incident exactly as they were.
 *
 * When every attempted node (at least two) fails with no handshake anywhere
 * while the control passed, the probe itself is the likelier culprit: the
 * per-node messages become one combined message, and those nodes recover
 * together into one combined message as well.
 */
export const ingestRun = (input: IngestInput): IngestOutput => {
  const resultById = new Map(input.results.map((r) => [r.targetId, r]));
  const byNode = new Map<string, { node: ReachabilityTarget; outcomes: ProtocolOutcome[] }>();
  for (const target of input.targets) {
    const outcome = classifyTarget(target, resultById.get(target.targetId), input.controlOk);
    const entry = byNode.get(target.nodeId) ?? { node: target, outcomes: [] };
    entry.outcomes.push(outcome);
    byNode.set(target.nodeId, entry);
  }
  const nodes = [...byNode.values()].sort((a, b) =>
    a.node.nodeName.localeCompare(b.node.nodeName),
  );

  // Attempted = the probe measured at least one of its protocols.
  const attempted = nodes.filter((n) => n.outcomes.some((o) => o.levels !== null));
  const massFailure =
    input.controlOk &&
    attempted.length >= 2 &&
    attempted.every(
      (n) =>
        nodeStatus(n.outcomes) === "failed" &&
        n.outcomes.every((o) => o.levels?.handshake.ok !== true),
    );

  const states = new Map<string, NodeState>();
  const opened: { node: ReachabilityTarget; levels: ProbeLevels | null; since: Date }[] = [];
  const recovered: { node: ReachabilityTarget; prev: NodeState }[] = [];

  for (const { node, outcomes } of nodes) {
    const prev = input.previous.get(node.nodeId) ?? initialState(input.now);
    const status = nodeStatus(outcomes);
    const detail = clip(outcomes.find((o) => o.status !== "ok")?.detail ?? null);
    const base = { status, checkedAt: input.now, detail: status === "ok" ? null : detail };

    if (status === "ok") {
      if (prev.alertedAt) recovered.push({ node, prev });
      states.set(node.nodeId, {
        ...base,
        consecutiveFailures: 0,
        failingSince: null,
        alertedAt: null,
        alertKind: null,
      });
    } else if (status === "failed") {
      const consecutiveFailures = prev.consecutiveFailures + 1;
      const failingSince = prev.failingSince ?? input.now;
      const opens = consecutiveFailures >= input.failThreshold && !prev.alertedAt;
      if (opens) {
        const failing = outcomes.find((o) => o.status === "failed");
        opened.push({ node, levels: failing?.levels ?? null, since: failingSince });
      }
      states.set(node.nodeId, {
        ...base,
        consecutiveFailures,
        failingSince,
        alertedAt: opens ? input.now : prev.alertedAt,
        alertKind: opens ? (massFailure ? "mass" : "node") : prev.alertKind,
      });
    } else {
      states.set(node.nodeId, {
        ...base,
        consecutiveFailures: prev.consecutiveFailures,
        failingSince: prev.failingSince,
        alertedAt: prev.alertedAt,
        alertKind: prev.alertKind,
      });
    }
  }

  const notices: Notice[] = [];
  const at = input.now.toISOString();
  if (massFailure && opened.length > 0) {
    notices.push({
      dedupKey: key("mass-down", input.runId),
      text: formatMassDown(opened.map((o) => o.node.nodeName), input.label),
    });
  } else {
    for (const { node, levels, since } of opened) {
      notices.push({
        dedupKey: key("down", node.nodeId, at),
        text: formatDown(node, input.label, levels, since),
      });
    }
  }

  const massRecovered = recovered.filter((r) => r.prev.alertKind === "mass");
  const combineRecovery = massRecovered.length >= 2;
  if (combineRecovery) {
    notices.push({
      dedupKey: key("mass-up", input.runId),
      text: formatMassUp(massRecovered.map((r) => r.node.nodeName), input.label),
    });
  }
  for (const { node, prev } of recovered) {
    if (combineRecovery && prev.alertKind === "mass") continue;
    notices.push({
      dedupKey: key("up", node.nodeId, (prev.alertedAt as Date).toISOString()),
      text: formatUp(node, input.label),
    });
  }

  const outcomes = nodes.flatMap((n) => n.outcomes);
  return { outcomes, states, notices };
};

export type StaleInput = {
  now: Date;
  label: string;
  staleAfterSec: number;
  lastResultAt: Date | null;
  createdAt: Date;
  staleAlertedAt: Date | null;
  /** A run was ingested on this tick. */
  ingestedNow: boolean;
};

/** One message when the probe goes silent, one when it reports again. */
export const staleTransition = (
  input: StaleInput,
): { staleAlertedAt: Date | null; notices: Notice[] } => {
  if (input.ingestedNow) {
    if (!input.staleAlertedAt) return { staleAlertedAt: null, notices: [] };
    return {
      staleAlertedAt: null,
      notices: [
        {
          dedupKey: key("stale-back", input.staleAlertedAt.toISOString()),
          text: formatStaleBack(input.label),
        },
      ],
    };
  }
  if (input.staleAlertedAt || !isProbeStale(input)) {
    return { staleAlertedAt: input.staleAlertedAt, notices: [] };
  }
  return {
    staleAlertedAt: input.now,
    notices: [
      {
        dedupKey: key("stale", input.now.toISOString()),
        text: formatStale(input.label, input.lastResultAt ?? input.createdAt),
      },
    ],
  };
};
