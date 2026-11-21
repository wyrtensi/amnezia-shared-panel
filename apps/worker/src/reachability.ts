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
  bridgeId?: string;
  bridgeName: string;
  host: string;
  port: number;
};

/** A registered address whose verdict an AWG 3 address target is. */
export type TargetAddress = {
  id: string;
  ordinal: number;
  address: string;
  name: string;
  /** When the address was last measured; the run limit serves the oldest first. */
  checkedAt: Date | null;
};

/** A legacy node/protocol path or a separately measured direct IPv4 address. */
export type ReachabilityTarget = {
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
  /** An opt-in direct path which never changes the regular node verdict. */
  diagnostic?: true;
  /** Set when the panel could not send this target (no usable service key). */
  unavailableReason: string | null;
  /**
   * The addresses this AWG 3 target measures: one direct address, or the
   * bridged addresses that share one config. Absent on a node target (AWG 2,
   * a node without registered addresses, a legacy artifact).
   */
  addresses?: readonly TargetAddress[];
  /** The node has an active bridge route; set on its direct address targets too. */
  nodeBridged?: true;
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
  if (!nodeId || !protocol) return null;
  const slot = `${nodeId}:${protocol}`;
  if (protocol !== "awg3") return revision === undefined && rest.length === 0 ? { id: slot, slot } : null;
  if (revision === undefined) return { id: `${slot}:r0`, slot };
  if (!/^r\d+$/.test(revision)) return null;
  if (rest.length === 0) return { id: `${slot}:${revision}`, slot };
  return rest.length === 1 && /^c[0-9a-f]{64}$/.test(rest[0] ?? "") ? { id: targetId, slot } : null;
};

/** The target goes through the node's bridge: AWG 3.1 on a bridged node. */
export const measuredViaBridge = (target: ReachabilityTarget): boolean =>
  target.protocol === "awg3" && target.bridgePath !== null && !target.diagnostic;

export const matchesDirectEndpoint = (
  result: ProbeTargetResult | undefined,
  address: string,
): result is ProbeTargetResult =>
  result?.protocol === "awg3" &&
  (result.endpointHost === address || (result.status === "error" && result.endpointHost === null));

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

/** An address's incident, kept in `node_vpn_endpoints` like a node's. */
export type AddressState = {
  consecutiveFailures: number;
  failingSince: Date | null;
  alertedAt: Date | null;
  alertKind: "node" | "mass" | null;
};

export const EMPTY_ADDRESS_STATE: AddressState = {
  consecutiveFailures: 0,
  failingSince: null,
  alertedAt: null,
  alertKind: null,
};

/** The verdict of one address in this run and its incident after it. */
export type AddressOutcome = {
  endpointId: string;
  status: ReachabilityStatus;
  levels: ProbeLevels | null;
  detail: string | null;
  state: AddressState;
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

const levelsLine = (levels: ProbeLevels | null) =>
  `handshake: ${yesNo(levels?.handshake)}, tcp/22: ${yesNo(levels?.tcp)}, ping: ${yesNo(levels?.ping)}`;

export const formatDown = (
  node: NodeLine,
  label: string,
  levels: ProbeLevels | null,
  since: Date,
  timeZone = "UTC",
): string =>
  `${who(node)} недоступен из ${label}\n${levelsLine(levels)}\nс ${alertClock(since, timeZone)}`;

export const formatUp = (node: NodeLine, label: string): string =>
  `${who(node)} снова доступен из ${label}`;

type AddressLine = { name: string; address: string; bridgePath: BridgePath | null };
/** The address and, when bridged, the bridge its verdict is about. */
const addressWho = (line: AddressLine) =>
  line.bridgePath
    ? `${line.name} (${line.address}) через мост ${line.bridgePath.bridgeName} (${line.bridgePath.host}:${line.bridgePath.port})`
    : `${line.name} (${line.address})`;

/** One message for the addresses of one node that went down in one run. */
export const formatAddressesDown = (
  nodeName: string,
  down: readonly (AddressLine & { levels: ProbeLevels | null; since: Date })[],
  label: string,
  timeZone = "UTC",
): string => {
  const [only] = down;
  if (down.length === 1 && only) {
    return `Адрес ${addressWho(only)} недоступен из ${label}\n${levelsLine(only.levels)}\n` +
      `с ${alertClock(only.since, timeZone)}`;
  }
  return `${nodeName}: недоступны адреса из ${label}\n` + down
    .map((line) => `${addressWho(line)}: ${levelsLine(line.levels)}, с ${alertClock(line.since, timeZone)}`)
    .join("\n");
};

/** One message for the addresses of one node that recovered in one run. */
export const formatAddressesUp = (nodeName: string, up: readonly AddressLine[], label: string): string => {
  const [only] = up;
  return up.length === 1 && only
    ? `Адрес ${addressWho(only)} снова доступен из ${label}`
    : `${nodeName}: снова доступны адреса из ${label}: ${up.map(addressWho).join(", ")}`;
};

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
  /** Incidents of the addresses as stored before this run, by address id. */
  previousAddresses?: ReadonlyMap<string, AddressState>;
};

export type IngestOutput = {
  /**
   * Stored per node and protocol: AWG 2, a node target's AWG 3, and for an
   * address node its AWG 3 path (`pathOutcome`).
   */
  outcomes: ProtocolOutcome[];
  addressOutcomes: AddressOutcome[];
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
 * A mass failure combines notices when the control passed and failures
 * across at least two attempted nodes point to a probe problem. A successful
 * address on a direct node rules out a mass failure. Diagnostics on bridged
 * nodes do not change bridge alerts. Nodes in a mass incident that
 * recover together get a combined recovery notice as well.
 */
export const NO_BRIDGED_ADDRESS_DETAIL = "no address uses the bridge";
export const NO_RESULT_DETAIL = "probe returned no result";

const STATUS_ORDER: Record<ReachabilityStatus, number> = { ok: 0, failed: 1, error: 2 };

/**
 * The AWG 3 row of an address node: on a node with an active bridge route
 * the best bridged measurement, so a direct address never vouches for the
 * bridge path (route verification and the rotation gate read this row); on a
 * direct node the best address. Candidates arrive in address order.
 */
const pathOutcome = (
  node: ReachabilityTarget,
  targets: readonly ReachabilityTarget[],
  measured: readonly { target: ReachabilityTarget; outcome: ProtocolOutcome }[],
): ProtocolOutcome => {
  const bridged = targets.some((target) => target.nodeBridged === true || measuredViaBridge(target));
  const onPath = (target: ReachabilityTarget) => !bridged || measuredViaBridge(target);
  const best = measured.filter(({ target }) => onPath(target)).reduce<ProtocolOutcome | null>(
    (chosen, { outcome }) =>
      !chosen || STATUS_ORDER[outcome.status] < STATUS_ORDER[chosen.status] ? outcome : chosen,
    null,
  );
  if (best) return best;
  // No address uses the active bridge: nothing vouches for that path.
  if (!targets.some(onPath)) return error(node, NO_BRIDGED_ADDRESS_DETAIL);
  // Sent but not measured in this run (another path's reply, the run limit):
  // the stored row stays as it was.
  return obsolete(node);
};

/**
 * The best of several outcomes for one node: ok, then failed, then unknown,
 * the first of equals. The opt-in direct diagnostics of a bridged node's
 * addresses summarize this way, like the node verdict.
 */
export const bestOutcome = (outcomes: readonly ProtocolOutcome[]): ProtocolOutcome | undefined =>
  outcomes.reduce<ProtocolOutcome | undefined>(
    (chosen, outcome) => !chosen || STATUS_ORDER[outcome.status] < STATUS_ORDER[chosen.status] ? outcome : chosen,
    undefined,
  );

/** Today's node incident rules, for one address. */
const advanceAddress = (
  previous: AddressState,
  status: ReachabilityStatus,
  now: Date,
  threshold: number,
  mass: boolean,
): { state: AddressState; opened: boolean; recovered: boolean } => {
  if (status === "error") return { state: previous, opened: false, recovered: false };
  if (status === "ok") {
    return { state: EMPTY_ADDRESS_STATE, opened: false, recovered: previous.alertedAt !== null };
  }
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const opened = consecutiveFailures >= threshold && previous.alertedAt === null;
  return {
    state: {
      consecutiveFailures,
      failingSince: previous.failingSince ?? now,
      alertedAt: opened ? now : previous.alertedAt,
      alertKind: opened ? (mass ? "mass" : "node") : previous.alertKind,
    },
    opened,
    recovered: false,
  };
};

export const ingestRun = (input: IngestInput): IngestOutput => {
  const resultById = new Map<string, ProbeTargetResult>();
  const reportedSlots = new Set<string>();
  for (const result of input.results) {
    resultById.set(result.targetId, result);
    const identity = normalizeTargetId(result.targetId);
    if (!identity) continue;
    resultById.set(identity.id, result);
    reportedSlots.add(identity.slot);
  }
  type Measured = { target: ReachabilityTarget; outcome: ProtocolOutcome };
  const byNode = new Map<string, {
    node: ReachabilityTarget;
    outcomes: ProtocolOutcome[];
    badge: ProtocolOutcome[];
    addressBased: boolean;
    addressTargets: ReachabilityTarget[];
    measured: Measured[];
  }>();
  const entryOf = (target: ReachabilityTarget) => {
    const entry = byNode.get(target.nodeId) ??
      { node: target, outcomes: [], badge: [], addressBased: false, addressTargets: [], measured: [] };
    byNode.set(target.nodeId, entry);
    return entry;
  };
  let healthyDirectAddress = false;
  for (const target of input.targets) {
    if (target.diagnostic) continue;
    const identity = normalizeTargetId(target.targetId);
    const result = resultById.get(identity?.id ?? target.targetId);
    if (target.addresses !== undefined) {
      const entry = entryOf(target);
      entry.addressBased = true;
      entry.addressTargets.push(target);
      // A sent target without a result waited for a free slot or was lost:
      // its addresses keep their saved observation. A direct reply only
      // counts for the address it was sent to.
      const [first] = target.addresses;
      const sent = target.unavailableReason === null && input.controlOk;
      if (sent && (!result || (target.bridgePath === null && first &&
        !matchesDirectEndpoint(result, first.address)))) continue;
      const outcome = classifyTarget(target, result, input.controlOk);
      entry.measured.push({ target, outcome });
      entry.badge.push(outcome);
      if (outcome.status === "ok" && target.bridgePath === null) healthyDirectAddress = true;
      continue;
    }
    // The probe reported this node and protocol, but for another endpoint
    // revision: an assignment changed since the run was dispatched. That
    // evidence is unknown now, whatever it says.
    const outcome =
      !result && identity && reportedSlots.has(identity.slot)
        ? obsolete(target)
        : classifyTarget(target, result, input.controlOk);
    const entry = entryOf(target);
    entry.outcomes.push(outcome);
    // A bridged node is judged on its bridged AWG 3.1 path alone: an AWG 2
    // that works directly must not hide a failed bridge. A Direct node is
    // judged on every protocol it serves.
    if (target.bridgePath === null || target.protocol === "awg3") entry.badge.push(outcome);
  }
  const nodes = [...byNode.values()]
    .map((entry) => ({
      ...entry,
      stored: entry.addressBased
        ? [...entry.outcomes, pathOutcome(entry.node, entry.addressTargets, entry.measured)]
        : entry.outcomes,
    }))
    .sort((a, b) => a.node.nodeName.localeCompare(b.node.nodeName));

  // Attempted = the probe measured at least one of its protocols.
  const attempted = nodes.filter((n) => n.badge.some((o) => o.levels !== null));
  // Two shapes point at the probe rather than the fleet: no tunnel came up
  // anywhere, or every tunnel came up and the same egress check failed on all
  // of them (the egress service itself is down or refusing the probe).
  const allFailed =
    input.controlOk &&
    attempted.length >= 2 &&
    attempted.every((n) => nodeStatus(n.badge) === "failed");
  const noHandshake = attempted.every((n) =>
    n.badge.every((o) => o.levels?.handshake.ok !== true),
  );
  const onlyEgressFailed = attempted.every((n) =>
    n.badge.every((o) => o.levels?.handshake.ok === true && o.levels.http.ok !== true),
  );
  const massFailure =
    allFailed &&
    (noHandshake || onlyEgressFailed) &&
    !healthyDirectAddress;

  const states = new Map<string, NodeState>();
  const addressOutcomes: AddressOutcome[] = [];
  type AddressEvent = AddressLine & { levels: ProbeLevels | null; since: Date; kind: AddressState["alertKind"] };
  const opened: { node: ReachabilityTarget; levels: ProbeLevels | null; since: Date }[] = [];
  const recovered: { node: ReachabilityTarget; prev: NodeState }[] = [];
  const addressDown = new Map<string, { node: ReachabilityTarget; lines: AddressEvent[] }>();
  const addressUp = new Map<string, { node: ReachabilityTarget; lines: AddressEvent[] }>();
  const push = (
    groups: Map<string, { node: ReachabilityTarget; lines: AddressEvent[] }>,
    node: ReachabilityTarget,
    line: AddressEvent,
  ) => {
    const group = groups.get(node.nodeId) ?? { node, lines: [] };
    group.lines.push(line);
    groups.set(node.nodeId, group);
  };

  for (const { node, badge, addressBased, measured } of nodes) {
    const prev = input.previous.get(node.nodeId) ?? initialState(input.now);
    const status = nodeStatus(badge);
    const detail = clip(badge.find((o) => o.status !== "ok")?.detail ?? null);
    const base = { status, checkedAt: input.now, detail: status === "ok" ? null : detail };

    if (addressBased) {
      for (const { target, outcome } of measured) {
        for (const address of target.addresses ?? []) {
          const previous = input.previousAddresses?.get(address.id) ?? EMPTY_ADDRESS_STATE;
          const step = advanceAddress(previous, outcome.status, input.now, input.failThreshold, massFailure);
          addressOutcomes.push({
            endpointId: address.id,
            status: outcome.status,
            levels: outcome.levels,
            detail: outcome.detail,
            state: step.state,
          });
          const line = {
            name: address.name,
            address: address.address,
            bridgePath: measuredViaBridge(target) ? target.bridgePath : null,
            levels: outcome.levels,
            since: step.state.failingSince ?? input.now,
          };
          if (step.opened) push(addressDown, node, { ...line, kind: step.state.alertKind });
          if (step.recovered) push(addressUp, node, { ...line, kind: previous.alertKind });
        }
      }
      // The node is a summary of its addresses and opens no incident of its
      // own; one it had before addresses were judged closes once.
      if (status === "ok" && prev.alertedAt) recovered.push({ node, prev });
      states.set(node.nodeId, {
        ...base,
        consecutiveFailures: status === "ok" ? 0 : status === "failed" ? prev.consecutiveFailures + 1 : prev.consecutiveFailures,
        failingSince: status === "ok" ? null : status === "failed" ? prev.failingSince ?? input.now : prev.failingSince,
        alertedAt: status === "ok" ? null : prev.alertedAt,
        alertKind: status === "ok" ? null : prev.alertKind,
      });
      continue;
    }

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
        const failing = badge.find((o) => o.status === "failed");
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
  const label = (line: AddressLine) => `${line.name} (${line.address})`;
  const downGroups = [...addressDown.values()];
  if (massFailure && (opened.length > 0 || downGroups.length > 0)) {
    notices.push({
      dedupKey: key("mass-down", input.runId),
      text: formatMassDown([
        ...opened.map((o) => o.node.nodeName),
        ...downGroups.flatMap((group) => group.lines.map(label)),
      ], input.label),
    });
  } else {
    for (const { node, levels, since } of opened) {
      notices.push({
        dedupKey: key("down", node.nodeId, at),
        text: formatDown(node, input.label, levels, since, input.timeZone),
      });
    }
    for (const { node, lines } of downGroups) {
      notices.push({
        dedupKey: key("addresses-down", node.nodeId, at),
        text: formatAddressesDown(node.nodeName, lines, input.label, input.timeZone),
      });
    }
  }

  const upGroups = [...addressUp.values()];
  const massNames = [
    ...recovered.filter((r) => r.prev.alertKind === "mass").map((r) => r.node.nodeName),
    ...upGroups.flatMap((group) => group.lines.filter((line) => line.kind === "mass").map(label)),
  ];
  const combineRecovery = massNames.length >= 2;
  if (combineRecovery) {
    notices.push({
      dedupKey: key("mass-up", input.runId),
      text: formatMassUp(massNames, input.label),
    });
  }
  for (const { node, prev } of recovered) {
    if (combineRecovery && prev.alertKind === "mass") continue;
    notices.push({
      dedupKey: key("up", node.nodeId, (prev.alertedAt as Date).toISOString()),
      text: formatUp(node, input.label),
    });
  }
  for (const { node, lines } of upGroups) {
    const individual = combineRecovery ? lines.filter((line) => line.kind !== "mass") : lines;
    if (individual.length === 0) continue;
    notices.push({
      dedupKey: key("addresses-up", node.nodeId, at),
      text: formatAddressesUp(node.nodeName, individual, input.label),
    });
  }

  const outcomes = nodes.flatMap((n) => n.stored);
  return { outcomes, addressOutcomes, states, notices, massFailure };
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
