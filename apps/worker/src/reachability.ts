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

/** The node's active bridge route, which its AWG 3.1 path goes through. */
export type BridgePath = {
  bridgeName: string;
  host: string;
  port: number;
};

/** One (node, protocol) pair the panel asked the probe to test. */
export type ReachabilityTarget = {
  /** `reachabilityTargetId(nodeId, protocol, endpointRevision)`. */
  targetId: string;
  nodeId: string;
  nodeName: string;
  publicIp: string | null;
  protocol: ProtocolKind;
  /** `nodes.vpn_endpoint_revision` the target was built for. */
  endpointRevision: number;
  /**
   * The node's active bridge route, null on Direct. Node level: only the
   * AWG 3.1 target is measured through it (`measuredViaBridge`), AWG 2 keeps
   * the direct path.
   */
  bridgePath: BridgePath | null;
  /** Set when the panel could not send this target (no usable service key). */
  unavailableReason: string | null;
};

/**
 * The probe's target id. The AWG 3.1 id carries the node's endpoint revision:
 * a result measured through an endpoint the node no longer uses never
 * matches a current target, so it is never taken for current evidence. AWG 2
 * always uses the direct path, which an assignment never changes, so its id
 * has no revision and its evidence survives a switch.
 */
export const reachabilityTargetId = (
  nodeId: string,
  protocol: ProtocolKind,
  endpointRevision: number,
): string => (protocol === "awg3" ? `${nodeId}:awg3:r${endpointRevision}` : `${nodeId}:${protocol}`);

/**
 * The identity a reported target id stands for, normalized to
 * `reachabilityTargetId`. An AWG 3.1 id without a revision was dispatched by
 * a worker that predates endpoint revisions, when every node was Direct at
 * revision 0. Null for an id that is not a node target (a candidate check's).
 */
const normalizeTargetId = (targetId: string): { id: string; slot: string } | null => {
  const [nodeId, protocol, revision, ...rest] = targetId.split(":");
  if (!nodeId || !protocol || rest.length > 0) return null;
  const slot = `${nodeId}:${protocol}`;
  if (protocol !== "awg3") return revision === undefined ? { id: slot, slot } : null;
  if (revision === undefined) return { id: `${slot}:r0`, slot };
  return /^r\d+$/.test(revision) ? { id: `${slot}:${revision}`, slot } : null;
};

/** The target goes through the node's bridge: AWG 3.1 on a bridged node. */
export const measuredViaBridge = (target: ReachabilityTarget): boolean =>
  target.protocol === "awg3" && target.bridgePath !== null;

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
  /**
   * Measured through an endpoint the node no longer uses. It counts as
   * unknown in the node verdict and is never stored.
   */
  obsolete?: true;
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

export const OBSOLETE_DETAIL = "measured through a previous endpoint";

const obsolete = (target: ReachabilityTarget): ProtocolOutcome => ({
  ...error(target, OBSOLETE_DETAIL),
  obsolete: true,
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

/**
 * A node is reachable when any protocol it serves is, and unreachable only
 * when every one of them was measured and failed: a protocol the probe could
 * not measure leaves the verdict unknown rather than turning it into a block.
 */
export const nodeStatus = (outcomes: readonly ProtocolOutcome[]): ReachabilityStatus => {
  if (outcomes.some((o) => o.status === "ok")) return "ok";
  if (outcomes.length > 0 && outcomes.every((o) => o.status === "failed")) return "failed";
  return "error";
};

/**
 * "2026-01-01 10:00 UTC", or the same in another IANA zone, named after the
 * time ("2026-01-01 11:00 Europe/Berlin").
 */
export const alertClock = (date: Date, timeZone = "UTC"): string => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}`;
};

const yesNo = (level: ProbeLevel | undefined) =>
  level?.ok === true ? "да" : level?.ok === false ? "нет" : "—";

type NodeLine = { nodeName: string; publicIp: string | null; bridgePath?: BridgePath | null };
/** The node and, when bridged, the bridge path its verdict is about. */
const who = (node: NodeLine) =>
  node.bridgePath
    ? `${node.nodeName} (${node.publicIp ?? "?"}) через мост ${node.bridgePath.bridgeName} (${node.bridgePath.host}:${node.bridgePath.port})`
    : `${node.nodeName} (${node.publicIp ?? "?"})`;

export const formatDown = (
  node: NodeLine,
  label: string,
  levels: ProbeLevels | null,
  since: Date,
  timeZone = "UTC",
): string =>
  `${who(node)} недоступен из ${label}\n` +
  `handshake: ${yesNo(levels?.handshake)}, tcp/22: ${yesNo(levels?.tcp)}, ping: ${yesNo(levels?.ping)}\n` +
  `с ${alertClock(since, timeZone)}`;

export const formatUp = (node: NodeLine, label: string): string =>
  `${who(node)} снова доступен из ${label}`;

export const formatMassDown = (names: readonly string[], label: string): string =>
  `Проверка из ${label}: ни одна нода не ответила (${names.length}): ${names.join(", ")}. ` +
  "Возможно, сломалась сама проверка.";

export const formatMassUp = (names: readonly string[], label: string): string =>
  `Проверка из ${label}: снова доступны ${names.join(", ")}`;

export const formatStale = (label: string, since: Date, timeZone = "UTC"): string =>
  `Проверка из ${label} не присылает результатов с ${alertClock(since, timeZone)}`;

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
  /** IANA zone for the times in the messages; UTC when omitted. */
  timeZone?: string;
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
  /** The run failed everywhere in a shape that points at the probe. */
  massFailure: boolean;
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
  const resultById = new Map<string, ProbeTargetResult>();
  const reportedSlots = new Set<string>();
  for (const result of input.results) {
    const identity = normalizeTargetId(result.targetId);
    if (!identity) continue;
    resultById.set(identity.id, result);
    reportedSlots.add(identity.slot);
  }
  const byNode = new Map<
    string,
    { node: ReachabilityTarget; outcomes: ProtocolOutcome[]; badge: ProtocolOutcome[] }
  >();
  for (const target of input.targets) {
    const identity = normalizeTargetId(target.targetId);
    const result = identity ? resultById.get(identity.id) : undefined;
    // The probe reported this node and protocol, but for another endpoint
    // revision: an assignment changed since the run was dispatched. That
    // evidence is unknown now, whatever it says.
    const outcome =
      !result && identity && reportedSlots.has(identity.slot)
        ? obsolete(target)
        : classifyTarget(target, result, input.controlOk);
    const entry = byNode.get(target.nodeId) ?? { node: target, outcomes: [], badge: [] };
    entry.outcomes.push(outcome);
    // A bridged node is judged on its bridged AWG 3.1 path alone: an AWG 2
    // that works directly must not hide a failed bridge. A Direct node is
    // judged on every protocol it serves.
    if (target.bridgePath === null || target.protocol === "awg3") entry.badge.push(outcome);
    byNode.set(target.nodeId, entry);
  }
  const nodes = [...byNode.values()]
    .map(({ node, outcomes, badge }) => ({ node, outcomes: badge, stored: outcomes }))
    .sort((a, b) => a.node.nodeName.localeCompare(b.node.nodeName));

  // Attempted = the probe measured at least one of its protocols.
  const attempted = nodes.filter((n) => n.outcomes.some((o) => o.levels !== null));
  // Two shapes point at the probe rather than the fleet: no tunnel came up
  // anywhere, or every tunnel came up and the same egress check failed on all
  // of them (the egress service itself is down or refusing the probe).
  const allFailed =
    input.controlOk &&
    attempted.length >= 2 &&
    attempted.every((n) => nodeStatus(n.outcomes) === "failed");
  const noHandshake = attempted.every((n) =>
    n.outcomes.every((o) => o.levels?.handshake.ok !== true),
  );
  const onlyEgressFailed = attempted.every((n) =>
    n.outcomes.every((o) => o.levels?.handshake.ok === true && o.levels.http.ok !== true),
  );
  const massFailure = allFailed && (noHandshake || onlyEgressFailed);

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
        text: formatDown(node, input.label, levels, since, input.timeZone),
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

  const outcomes = nodes.flatMap((n) => n.stored);
  return { outcomes, states, notices, massFailure };
};

export type StaleInput = {
  now: Date;
  label: string;
  /** IANA zone for the time in the message; UTC when omitted. */
  timeZone?: string;
  staleAfterSec: number;
  intervalSec: number;
  lastResultAt: Date | null;
  /** When monitoring (re)started. */
  since: Date;
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
        text: formatStale(
          input.label,
          new Date(Math.max(input.lastResultAt?.getTime() ?? 0, input.since.getTime())),
          input.timeZone,
        ),
      },
    ],
  };
};
