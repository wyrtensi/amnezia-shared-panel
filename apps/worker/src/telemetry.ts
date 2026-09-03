import type {
  NodeAgent,
  NodeClientRecord,
  NodeServer,
  NodeServerLoad,
} from "./nodeAgent.js";
import { createPublicIpResolver, normalizePublicHost } from "./publicAddress.js";

const SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;

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
};

export type NodeSnapshot = {
  nodeId: string;
  observedAt: Date;
  server: NodeServer;
  load: NodeServerLoad;
  peers: PeerObservation[];
  // The node-agent's SERVER_PUBLIC_HOST as reported (normalised), or null for
  // an agent that does not report it.
  publicHost: string | null;
  // A newly resolved address for `publicHost`, or null when there was nothing
  // to resolve (the address is already known) or the lookup failed.
  publicIp: string | null;
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
    SAMPLE_INTERVAL_MS;

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
    "getHealth" | "getServer" | "getServerLoad" | "listClients"
  >;
  // Host → IP for the reported public host. Injectable for tests; the default
  // uses the system resolver with a bounded timeout.
  resolvePublicIp?: (host: string) => Promise<string | null>;
  now?: () => Date;
};

export const createTelemetryPoller = ({
  repository,
  createNodeAgent,
  resolvePublicIp = createPublicIpResolver(),
  now = () => new Date(),
}: TelemetryPollerOptions) => async (): Promise<void> => {
  const telemetryNodes = await repository.listTelemetryNodes();
  await Promise.all(
    telemetryNodes.map(async (node) => {
      const observedAt = now();
      try {
        const agent = createNodeAgent(node);
        const [health, server, load, clients] = await Promise.all([
          agent.getHealth(),
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
        await repository.recordNodeSnapshot({
          nodeId: node.id,
          observedAt,
          server,
          load,
          peers,
          publicHost,
          publicIp,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown polling error";
        await repository.recordNodeFailure(
          node.id,
          observedAt,
          cleanReason(reason),
        );
      }
    }),
  );
};
