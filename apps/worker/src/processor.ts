import { z } from "zod";
import { ACCESS_SYNC_JOB_TYPE, RULES_REFRESH_JOB_TYPE } from "@amnezia/contracts";
import type { AccessSyncOutcome } from "./accessReconcile.js";
import type { NodeAgent } from "./nodeAgent.js";
import type {
  OutboxJob,
  WorkerKeyContext,
  WorkerRepository,
} from "./repository.js";
import { toPeerObservation } from "./telemetry.js";

const keyJobPayloadSchema = z.object({ keyId: z.uuid().or(z.string().min(1)) });
const nodeJobPayloadSchema = z.object({ nodeId: z.uuid().or(z.string().min(1)) });
// The digest the admin confirmed travels in the payload. The node re-validates
// it, and so does the host-side updater; nothing anywhere re-resolves a tag,
// or the thing installed could differ from the thing that was shown.
const nodeAgentUpdatePayloadSchema = nodeJobPayloadSchema.extend({
  image: z.string().min(1).max(512),
});
// The number the admin typed. The node re-validates it, the host-side applier
// re-validates it, and set-capacity.sh validates it a third time.
const nodeCapacityPayloadSchema = nodeJobPayloadSchema.extend({
  maxPeers: z.number().int().min(1).max(500),
});

export type JobProcessorOptions = {
  repository: WorkerRepository;
  createNodeAgent: (node: WorkerKeyContext["node"]) => NodeAgent;
  /**
   * The same fetchers the periodic timer runs, one per configured feed. An
   * empty list means no feed is configured — a manual refresh then fails with
   * a clear message instead of reporting a successful check that did nothing.
   */
  ruleFetchers?: Array<() => Promise<void>>;
  /**
   * The single `createAccessSync(...)` instance (Task 3), or undefined when
   * the worker does not have `ACCESS_SYNC_ENABLED=true`. The timer only arms
   * the outbox row; this processor is the sole place that runs it.
   */
  accessSync?: () => Promise<AccessSyncOutcome>;
  now?: () => Date;
};

const findPeer = (
  clients: Awaited<ReturnType<NodeAgent["listClients"]>>,
  label: string,
) => clients.find((client) => client.username === label)?.peers[0];

export const createJobProcessor = ({
  repository,
  createNodeAgent,
  ruleFetchers = [],
  accessSync,
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
    if (job.type === RULES_REFRESH_JOB_TYPE) {
      // Operator-triggered "check for updates": run exactly the fetchers the
      // 6-hourly timer runs. A feed whose checksum still matches the active
      // version is a no-op by design, so finishing without a new version is a
      // success.
      if (ruleFetchers.length === 0) {
        // Configuration, not a transient fault: retrying cannot fix it, so the
        // job is failed outright with a message the admin UI can show.
        await repository.failJob(
          job.id,
          "No route-rule feeds are configured (set RULE_FEEDS on the worker)",
        );
        return;
      }
      // Every feed is attempted even if one fails, so a single broken source
      // cannot hide an update on another; the job still reports the failures.
      const results = await Promise.allSettled(
        ruleFetchers.map((fetchRules) => fetchRules()),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            ]
          : [],
      );
      if (failures.length > 0) {
        throw new Error(`Rule feed refresh failed: ${failures.join("; ")}`);
      }
      await repository.completeJob(job.id);
      return;
    }
    if (job.type === ACCESS_SYNC_JOB_TYPE) {
      if (!accessSync) {
        // Configuration, not a transient fault — retrying cannot fix it.
        await repository.failJob(
          job.id,
          "Two-way Access sync is not enabled on this worker (set ACCESS_SYNC_ENABLED=true)",
        );
        return;
      }
      const result = await accessSync();
      if (result.outcome === "skipped") {
        await repository.failJob(
          job.id,
          "Cloudflare Access is not configured — run cf-config and cf-token",
        );
        return;
      }
      if (result.outcome === "aborted") {
        // A run that refused to act is not a success. Failed re-arms on the next
        // trigger and on the next hourly tick, so nothing is stuck.
        await repository.failJob(job.id, `aborted: ${result.detail ?? "blast-radius cap"}`);
        return;
      }
      const armId = typeof job.payload.armId === "string" ? job.payload.armId : "";
      await repository.finishAccessSync(job.id, armId);
      return;
    }
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
    if (job.type === "node.agent-update") {
      const { nodeId, image } = nodeAgentUpdatePayloadSchema.parse(job.payload);
      const context = await repository.loadNodeReconcileContext(nodeId);
      if (!context) {
        await repository.failJob(job.id, "Node agent update target not found");
        return;
      }
      // The job ends here rather than waiting for the outcome. The worker
      // claims jobs one at a time, so holding this one open across a pull, a
      // container swap and a health gate would stop every other job on the
      // panel for minutes. The telemetry poller already visits every node each
      // minute and mirrors the node's own update state onto its row, which also
      // survives a worker restart and tolerates the node being unreachable
      // during the restart it was asked to perform.
      await createNodeAgent(context.node).requestAgentUpdate(image);
      await repository.completeNodeAgentUpdate({
        jobId: job.id,
        nodeId,
        image,
        requestedAt: now(),
      });
      return;
    }
    if (job.type === "node.set-capacity") {
      const { nodeId, maxPeers } = nodeCapacityPayloadSchema.parse(job.payload);
      const context = await repository.loadNodeReconcileContext(nodeId);
      if (!context) {
        await repository.failJob(job.id, "Node capacity target not found");
        return;
      }
      // The job ends here rather than waiting for the outcome, for the same
      // reason the agent update does: the worker claims jobs one at a time, and
      // holding this one open across a container recreate and its health gate
      // would stop every other job on the panel. The telemetry poller visits
      // every node each minute and mirrors the node's own capacity state onto
      // its row - which also survives a worker restart and tolerates the node
      // being unreachable during the recreate it was asked to perform.
      await createNodeAgent(context.node).requestCapacity(maxPeers);
      await repository.completeNodeCapacityChange({
        jobId: job.id,
        nodeId,
        maxPeers,
        requestedAt: now(),
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
