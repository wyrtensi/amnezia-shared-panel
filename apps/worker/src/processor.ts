import { z } from "zod";
import type { NodeAgent } from "./nodeAgent.js";
import type {
  OutboxJob,
  WorkerKeyContext,
  WorkerRepository,
} from "./repository.js";
import { toPeerObservation } from "./telemetry.js";

const keyJobPayloadSchema = z.object({ keyId: z.uuid().or(z.string().min(1)) });
const nodeJobPayloadSchema = z.object({ nodeId: z.uuid().or(z.string().min(1)) });

export type JobProcessorOptions = {
  repository: WorkerRepository;
  createNodeAgent: (node: WorkerKeyContext["node"]) => NodeAgent;
  now?: () => Date;
};

const findPeer = (
  clients: Awaited<ReturnType<NodeAgent["listClients"]>>,
  label: string,
) => clients.find((client) => client.username === label)?.peers[0];

export const createJobProcessor = ({
  repository,
  createNodeAgent,
  now = () => new Date(),
}: JobProcessorOptions) => {
  const reconcileOrphan = async (
    context: WorkerKeyContext,
    agent: NodeAgent,
    reason: string,
  ): Promise<void> => {
    const peer = findPeer(await agent.listClients(), context.nodeLabel);
    if (!peer) return;
    await agent.deleteClient(peer.id, context.protocol);
    throw new Error(`${reason}; reconciled orphan peer`);
  };

  return async (job: OutboxJob): Promise<void> => {
    if (job.type === "node.reconcile") {
      const { nodeId } = nodeJobPayloadSchema.parse(job.payload);
      const context = await repository.loadNodeReconcileContext(nodeId);
      if (!context) {
        await repository.failJob(job.id, "Node reconciliation target not found");
        return;
      }
      const clients = await createNodeAgent(context.node).listClients();
      const observedAt = now();
      const nodePeers = clients.flatMap((client) =>
        client.peers.map((peer) => ({ nodeLabel: client.username, peer })),
      );
      const unmatchedPeerIndexes = new Set(nodePeers.map((_peer, index) => index));
      const peers = context.keys.flatMap((key) => {
        const peerIndex = nodePeers.findIndex(
          ({ nodeLabel, peer }, index) =>
            unmatchedPeerIndexes.has(index) &&
            ((key.publicKey !== null && peer.id === key.publicKey) ||
              nodeLabel === key.nodeLabel),
        );
        if (peerIndex < 0) return [];
        unmatchedPeerIndexes.delete(peerIndex);
        const matched = nodePeers[peerIndex];
        return matched
          ? [toPeerObservation(key.keyId, matched.peer, observedAt)]
          : [];
      });
      await repository.completeNodeReconcile({
        jobId: job.id,
        nodeId,
        observedAt,
        managedKeyIds: context.keys.map((key) => key.keyId),
        peers,
        summary: {
          managedKeyCount: context.keys.length,
          observedPeerCount: nodePeers.length,
          matchedPeerCount: peers.length,
          missingManagedPeerCount: context.keys.length - peers.length,
          orphanNodePeerCount: unmatchedPeerIndexes.size,
        },
      });
      return;
    }
    if (!job.type.startsWith("vpn-key.")) {
      await repository.completeJob(job.id);
      return;
    }
    const { keyId } = keyJobPayloadSchema.parse(job.payload);
    const context = await repository.loadKeyContext(keyId);
    if (!context) {
      await repository.completeJob(job.id);
      return;
    }
    const agent = createNodeAgent(context.node);

    if (job.type === "vpn-key.provision") {
      if (context.state !== "provisioning") {
        await repository.completeJob(job.id);
        return;
      }
      await reconcileOrphan(
        context,
        agent,
        "Peer existed before provisioning attempt",
      );
      try {
        const created = await agent.createClient(
          context.nodeLabel,
          context.protocol,
        );
        await repository.completeProvision({
          jobId: job.id,
          keyId,
          publicKey: created.id,
          vpnConfig: created.config,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown node error";
        await reconcileOrphan(context, agent, reason);
        throw error instanceof Error ? error : new Error(reason);
      }
      return;
    }

    if (job.type === "vpn-key.rotate") {
      // Rotation replaces the peer with fresh key material so the previous
      // config stops working, then issues a new one for the same device.
      if (context.state !== "provisioning") {
        await repository.completeJob(job.id);
        return;
      }
      const oldPeer =
        context.publicKey ??
        findPeer(await agent.listClients(), context.nodeLabel)?.id ??
        null;
      if (oldPeer) await agent.deleteClient(oldPeer, context.protocol);
      const created = await agent.createClient(
        context.nodeLabel,
        context.protocol,
      );
      await repository.completeProvision({
        jobId: job.id,
        keyId,
        publicKey: created.id,
        vpnConfig: created.config,
      });
      return;
    }

    if (job.type === "vpn-key.revoke") {
      const publicKey =
        context.publicKey ??
        findPeer(await agent.listClients(), context.nodeLabel)?.id ??
        null;
      if (publicKey) await agent.deleteClient(publicKey, context.protocol);
      await repository.completeLifecycle(job.id, keyId, "revoked");
      return;
    }
    if (job.type === "vpn-key.disable" || job.type === "vpn-key.enable") {
      if (!context.publicKey) throw new Error("Key has no node public key");
      const enabled = job.type === "vpn-key.enable";
      await agent.setClientStatus(
        context.publicKey,
        context.protocol,
        enabled ? "active" : "disabled",
      );
      await repository.completeLifecycle(
        job.id,
        keyId,
        enabled ? "active" : "disabled",
      );
      return;
    }
    await repository.completeJob(job.id);
  };
};
