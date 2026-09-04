import type {
  NodeAgent,
  NodeAgentUpdateStatus,
  NodeClientRecord,
  NodeServer,
  NodeServerLoad,
} from "./nodeAgent.js";
import { mapWithConcurrency } from "./concurrency.js";
import { createPublicIpResolver, normalizePublicHost } from "./publicAddress.js";

// PEER samples, not host-metric samples. The two periods are different things
// and this file now touches both: peers are downsampled on state change plus
// this floor, while host metrics use the configurable `sampleIntervalMs` option
// below. Two similarly named intervals in one file is exactly how they drift.
const PEER_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;

/** How many nodes the poll talks to at once. */
const DEFAULT_POLL_CONCURRENCY = 4;

export type PeerObservation = {
  keyId: string;
  online: boolean;
  endpoint: string | null;
  latestHandshakeAt: Date | null;
  receivedBytes: bigint;
  sentBytes: bigint;
  observedAt: Date;
};

export type TelemetryNode = {
  id: string;
  baseUrl: string;
  apiKey: string;
  keys: Array<{
    keyId: string;
    publicKey: string | null;
    nodeLabel: string;
  }>;
  /** Last host the stored publicIp was resolved from; null until reported. */
  publicHost: string | null;
  /** Last resolved address; null until the first successful lookup. */
  publicIp: string | null;
  /**
   * The node's last known agent-update state. Only a node in flight is asked
   * about it, so a fleet with nothing to update costs no extra requests.
   */
  agentUpdateState: NodeAgentUpdateStatus["state"];
};

export type NodeSnapshot = {
  nodeId: string;
  observedAt: Date;
  // How long the node's health check took. The one latency figure the panel can
  // honestly report: it is the panel's own round trip to the agent, not a claim
  // about what a user's connection looks like.
  agentLatencyMs: number;
  server: NodeServer;
  load: NodeServerLoad;
  peers: PeerObservation[];
  // The node-agent's SERVER_PUBLIC_HOST as reported (normalised), or null for
  // an agent that does not report it.
  publicHost: string | null;
  // A newly resolved address for `publicHost`, or null when there was nothing
  // to resolve (the address is already known) or the lookup failed.
  publicIp: string | null;
  // The node's own view of the update it was asked to perform. `undefined`
  // means there is no new answer - not asked this tick, or the node could not
  // be reached, which is expected while it restarts - and the stored state must
  // be left alone. `null` is an answer: the agent does not serve the route at
  // all, so nothing will ever arrive and the wait has to end.
  agentUpdate?: NodeAgentUpdateStatus | null;
};

export interface TelemetryRepository {
  listTelemetryNodes: () => Promise<TelemetryNode[]>;
  recordNodeSnapshot: (snapshot: NodeSnapshot) => Promise<void>;
  recordNodeFailure: (
    nodeId: string,
    observedAt: Date,
    reason: string,
  ) => Promise<void>;
}

export const shouldStoreSample = (
  observation: PeerObservation,
  previousSample: PeerObservation | null,
): boolean =>
  !previousSample ||
  observation.online !== previousSample.online ||
  observation.endpoint !== previousSample.endpoint ||
  observation.latestHandshakeAt?.getTime() !==
    previousSample.latestHandshakeAt?.getTime() ||
  observation.observedAt.getTime() - previousSample.observedAt.getTime() >=
    PEER_SAMPLE_INTERVAL_MS;

const cleanReason = (reason: string): string =>
  reason.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);

const toCounter = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Node-agent returned an unsafe traffic counter");
  }
  return BigInt(value);
};

export const toPeerObservation = (
  keyId: string,
  peer: NodeClientRecord["peers"][number],
  observedAt: Date,
): PeerObservation => ({
  keyId,
  online: peer.online,
  endpoint: peer.endpoint,
  latestHandshakeAt:
    peer.lastHandshake > 0 ? new Date(peer.lastHandshake * 1_000) : null,
  receivedBytes: toCounter(peer.traffic.received),
  sentBytes: toCounter(peer.traffic.sent),
  observedAt,
});

export type TelemetryPollerOptions = {
  repository: TelemetryRepository;
  createNodeAgent: (
    node: Pick<TelemetryNode, "baseUrl" | "apiKey">,
  ) => Pick<
    NodeAgent,
    | "getHealth"
    | "getServer"
    | "getServerLoad"
    | "listClients"
    | "getAgentUpdate"
  >;
  // Host → IP for the reported public host. Injectable for tests; the default
  // uses the system resolver with a bounded timeout.
  resolvePublicIp?: (host: string) => Promise<string | null>;
  now?: () => Date;
  /** Nodes contacted at once; bounded so a large fleet cannot exhaust the worker. */
  concurrency?: number;
};

export const createTelemetryPoller = ({
  repository,
  createNodeAgent,
  resolvePublicIp = createPublicIpResolver(),
  now = () => new Date(),
  concurrency = DEFAULT_POLL_CONCURRENCY,
}: TelemetryPollerOptions) => async (): Promise<void> => {
  const telemetryNodes = await repository.listTelemetryNodes();
  await mapWithConcurrency(telemetryNodes, concurrency, async (node) => {
      const observedAt = now();
      try {
        const agent = createNodeAgent(node);
        const healthStartedAt = Date.now();
        const health = await agent.getHealth();
        // Measured around the health call alone: it is the smallest request the
        // agent serves, so it is the closest thing to the transport's own cost
        // rather than a mix of that and however long a client list takes.
        const agentLatencyMs = Math.max(0, Date.now() - healthStartedAt);
        const [server, load, clients] = await Promise.all([
          agent.getServer(),
          agent.getServerLoad(),
          agent.listClients(),
        ]);
        if (!health.ok) throw new Error("Node-agent health check failed");
        const peersByPublicKey = new Map(
          clients.flatMap((client) =>
            client.peers.map((peer) => [peer.id, peer] as const),
          ),
        );
        const clientsByLabel = new Map(
          clients.map((client) => [client.username, client] as const),
        );
        const peers = node.keys.flatMap((key) => {
          const peer =
            (key.publicKey ? peersByPublicKey.get(key.publicKey) : undefined) ??
            clientsByLabel.get(key.nodeLabel)?.peers[0];
          if (!peer) return [];
          return [toPeerObservation(key.keyId, peer, observedAt)];
        });
        const publicHost = normalizePublicHost(server.publicHost);
        // A node's public address is fixed for the life of the server, so this
        // is resolved once and then left alone: only when we have no IP yet, or
        // when the node starts reporting a different host, is a lookup worth a
        // DNS round trip. Steady state is zero lookups per tick.
        const needsLookup =
          publicHost !== null &&
          (node.publicIp === null || node.publicHost !== publicHost);
        const publicIp = needsLookup ? await resolvePublicIp(publicHost) : null;
        // This is what moves an update from "requested" to its outcome. It is
        // done here, not inside the job that asked, because the worker claims
        // jobs one at a time and the swap takes minutes - and because the node
        // is deliberately unreachable in the middle of it, which this loop
        // already tolerates.
        const agentUpdate =
          node.agentUpdateState === "requested" || node.agentUpdateState === "running"
            ? await agent.getAgentUpdate().catch(() => undefined)
            : undefined;
        await repository.recordNodeSnapshot({
          nodeId: node.id,
          observedAt,
          agentLatencyMs,
          server,
          load,
          peers,
          publicHost,
          publicIp,
          agentUpdate,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown polling error";
        await repository.recordNodeFailure(
          node.id,
          observedAt,
          cleanReason(reason),
        );
      }
  });
};
