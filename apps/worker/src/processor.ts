import { z } from "zod";
import {
  ACCESS_SYNC_JOB_TYPE,
  BRIDGE_AGENT_POLL_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  DEFAULT_IPV6_REJECT_STUB_PREFIX,
  NODE_IPV6_REJECT_STUB_JOB_TYPE,
  NODE_SWITCH_EGRESS_MODE_JOB_TYPE,
  NODE_SYNC_EGRESS_JOB_TYPE,
  nodeEgressModeSchema,
  QUOTA_REQUEST_NOTIFY_JOB_TYPE,
  REACHABILITY_NOTIFY_JOB_TYPE,
  REACHABILITY_WIDGET_JOB_TYPE,
  RULES_REFRESH_JOB_TYPE,
  quotaRequestNotifyPayloadSchema,
  reachabilityNotifyPayloadSchema,
  reachabilityWidgetPayloadSchema,
  type NodeIpv6RejectStubState,
} from "@amnezia/contracts";
import { readBaseClientIpv4 } from "@amnezia/vpn-config";
import { buildNodeEgressDesiredState, extractPeerIpv4 } from "./nodeEgress.js";
import { formatQuotaRequestMessage, type TelegramNotifier } from "./telegram.js";
import type { AccessSyncOutcome } from "./accessReconcile.js";
import type { NodeAgent } from "./nodeAgent.js";
import type { ReachabilityWidget } from "./reachabilityWidgetSender.js";
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
const nodeIpv6RejectStubPayloadSchema = nodeJobPayloadSchema.extend({
  enabled: z.boolean(),
  prefix: z.string().min(1).max(64).optional(),
});
const nodeSwitchEgressModePayloadSchema = nodeJobPayloadSchema.extend({
  mode: nodeEgressModeSchema,
  previousMode: nodeEgressModeSchema.optional(),
});

const tryExtractBaseClientIpv4 = (vpnConfig: string): string | null => {
  try {
    return readBaseClientIpv4(vpnConfig);
  } catch {
    return null;
  }
};

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
  /**
   * Diagnostic log line. Used to surface an `access.sync` failure before it is
   * rethrown for the runner's retry/backoff to handle — without this, a
   * Cloudflare 401/5xx/timeout is recorded only in `job_outbox.last_error`
   * and never reaches the worker's own log. Defaults to a no-op so tests do
   * not need to wire one.
   */
  log?: (message: string) => void;
  /**
   * Where operator notifications go (Telegram), or undefined when the worker
   * has no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Notification jobs then
   * complete without sending.
   */
  notifier?: TelegramNotifier;
  /**
   * The Telegram status widget, or undefined without Telegram. Its refresh
   * jobs then complete without sending.
   */
  reachabilityWidget?: Pick<ReachabilityWidget, "refresh">;
  /** PANEL_PUBLIC_URL, for the link in a notification. */
  panelPublicUrl?: string | null;
  /**
   * The `bridge_route_candidate_check` handler (bridgeCandidateCheck.ts). It
   * completes or fails its own job; a throw is retried by the runner.
   */
  bridgeCandidateCheck?: (job: OutboxJob) => Promise<void>;
  /**
   * The `bridge_agent.poll` handler (bridgePoller.ts). It completes or fails
   * its own job; a throw is retried by the runner.
   */
  bridgeAgentPoll?: (job: OutboxJob) => Promise<void>;
  /** The `bridge_agent.update` handler (bridgeAgentUpdate.ts); same contract. */
  bridgeAgentUpdate?: (job: OutboxJob) => Promise<void>;
  now?: () => Date;
};

const findPeer = (
  clients: Awaited<ReturnType<NodeAgent["listClients"]>>,
  label: string,
) => clients.find((client) => client.username === label)?.peers[0];

type NodeEgressSyncContext = NonNullable<
  Awaited<ReturnType<NonNullable<WorkerRepository["loadNodeEgressSyncContext"]>>>
>;

const hydrateMissingTunnelIpv4s = async (
  syncContext: NodeEgressSyncContext,
  nodeAgent: NodeAgent,
  repository: WorkerRepository,
  observedAt: Date,
): Promise<NodeEgressSyncContext> => {
  const needsBackfill = syncContext.keys.some(
    (key) =>
      key.protocol === "awg3" &&
      (key.state === "active" || key.state === "disabled") &&
      !key.tunnelIpv4,
  );
  if (!needsBackfill) {
    return syncContext;
  }

  const clients = await nodeAgent.listClients();
  const nodePeers = clients.flatMap((client) =>
    client.peers
      .filter((peer) => peer.protocol === "amneziawg3" || peer.protocol === "awg3")
      .map((peer) => ({ nodeLabel: client.username, peer })),
  );
  const unmatchedPeerIndexes = new Set<number>(nodePeers.map((_, idx) => idx));
  const hydratedPublicKeys = new Set(
    syncContext.keys
      .filter((key) => key.protocol === "awg3" && key.tunnelIpv4 && key.publicKey)
      .map((key) => key.publicKey!),
  );
  for (const idx of [...unmatchedPeerIndexes]) {
    const peerId = nodePeers[idx]?.peer.id;
    if (peerId && hydratedPublicKeys.has(peerId)) {
      unmatchedPeerIndexes.delete(idx);
    }
  }
  const backfills: Array<{ keyId: string; tunnelIpv4: string }> = [];
  const backfillByKeyId = new Map<string, string>();

  // Match publicKey first so keys sharing a label never resolve to the wrong peer.
  for (const key of syncContext.keys) {
    if (
      key.protocol !== "awg3" ||
      (key.state !== "active" && key.state !== "disabled") ||
      key.tunnelIpv4 ||
      !key.publicKey
    ) {
      continue;
    }
    let matchedIndex = -1;
    for (const idx of unmatchedPeerIndexes) {
      if (nodePeers[idx]?.peer.id === key.publicKey) {
        matchedIndex = idx;
        break;
      }
    }
    if (matchedIndex === -1) continue;
    unmatchedPeerIndexes.delete(matchedIndex);
    const matched = nodePeers[matchedIndex];
    if (!matched) continue;
    const ipv4 = extractPeerIpv4(matched.peer.allowedIps);
    if (ipv4) {
      backfills.push({ keyId: key.keyId, tunnelIpv4: ipv4 });
      backfillByKeyId.set(key.keyId, ipv4);
    }
  }

  // Fallback to nodeLabel only for legacy rows that lack persisted publicKey.
  for (const key of syncContext.keys) {
    if (
      key.protocol !== "awg3" ||
      (key.state !== "active" && key.state !== "disabled") ||
      key.tunnelIpv4 ||
      backfillByKeyId.has(key.keyId) ||
      !key.nodeLabel
    ) {
      continue;
    }
    let matchedIndex = -1;
    for (const idx of unmatchedPeerIndexes) {
      if (nodePeers[idx]?.nodeLabel === key.nodeLabel) {
        matchedIndex = idx;
        break;
      }
    }
    if (matchedIndex === -1) continue;
    unmatchedPeerIndexes.delete(matchedIndex);
    const matched = nodePeers[matchedIndex];
    if (!matched) continue;
    const ipv4 = extractPeerIpv4(matched.peer.allowedIps);
    if (ipv4) {
      backfills.push({ keyId: key.keyId, tunnelIpv4: ipv4 });
      backfillByKeyId.set(key.keyId, ipv4);
    }
  }

  if (backfills.length === 0) {
    return syncContext;
  }

  await repository.backfillKeyTunnelIpv4s?.(backfills, observedAt);
  return {
    ...syncContext,
    keys: syncContext.keys.map((key) => {
      const hydrated = backfillByKeyId.get(key.keyId);
      return hydrated ? { ...key, tunnelIpv4: hydrated } : key;
    }),
  };
};

export const createJobProcessor = ({
  repository,
  createNodeAgent,
  ruleFetchers = [],
  accessSync,
  log = () => undefined,
  notifier,
  reachabilityWidget,
  panelPublicUrl = null,
  bridgeCandidateCheck,
  bridgeAgentPoll,
  bridgeAgentUpdate,
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
    if (job.type === BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE) {
      if (!bridgeCandidateCheck) {
        await repository.failJob(job.id, "Bridge candidate checks are not wired on this worker");
        return;
      }
      await bridgeCandidateCheck(job);
      return;
    }
    if (job.type === BRIDGE_AGENT_POLL_JOB_TYPE) {
      if (!bridgeAgentPoll) {
        await repository.failJob(job.id, "Bridge-agent polls are not wired on this worker");
        return;
      }
      await bridgeAgentPoll(job);
      return;
    }
    if (job.type === BRIDGE_AGENT_UPDATE_JOB_TYPE) {
      if (!bridgeAgentUpdate) {
        await repository.failJob(job.id, "Bridge-agent updates are not wired on this worker");
        return;
      }
      await bridgeAgentUpdate(job);
      return;
    }
    if (job.type === QUOTA_REQUEST_NOTIFY_JOB_TYPE) {
      // System-generated, unlike the two operator-triggered jobs below: with
      // no chat configured there is nobody to tell, and that is not a failure.
      if (!notifier) {
        await repository.completeJob(job.id);
        return;
      }
      const parsed = quotaRequestNotifyPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        // Retrying cannot fix a payload, so fail it outright.
        await repository.failJob(
          job.id,
          "notify.quota_request job payload is malformed",
        );
        return;
      }
      try {
        await notifier.send(formatQuotaRequestMessage(parsed.data, panelPublicUrl));
      } catch (error) {
        // Same reason as access.sync below: the runner records a throw only in
        // job_outbox.last_error, so log it before the retry/backoff.
        const reason = error instanceof Error ? error.message : "unknown error";
        log(`notify.quota_request: ${reason}`);
        throw error;
      }
      await repository.completeJob(job.id);
      return;
    }
    if (job.type === REACHABILITY_NOTIFY_JOB_TYPE) {
      // Same contract as the quota-request message: the worker composed the
      // text when it decided to alert, so this only relays it.
      if (!notifier) {
        await repository.completeJob(job.id);
        return;
      }
      const parsed = reachabilityNotifyPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        await repository.failJob(job.id, "notify.reachability job payload is malformed");
        return;
      }
      try {
        await notifier.send(parsed.data.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        log(`notify.reachability: ${reason}`);
        throw error;
      }
      await repository.completeJob(job.id);
      return;
    }
    if (job.type === REACHABILITY_WIDGET_JOB_TYPE) {
      // The widget is drawn from the state as it is now; the payload only
      // says whether a node alert came with it. A row from before the flag,
      // or a malformed one, refreshes as a plain run.
      if (!reachabilityWidget) {
        await repository.completeJob(job.id);
        return;
      }
      const parsed = reachabilityWidgetPayloadSchema.safeParse(job.payload);
      try {
        await reachabilityWidget.refresh({ notice: parsed.success && parsed.data.notice === true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        log(`notify.reachability-widget: ${reason}`);
        throw error;
      }
      await repository.completeJob(job.id);
      return;
    }
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
      let result: AccessSyncOutcome;
      try {
        result = await accessSync();
      } catch (error) {
        // The runner turns a throw into retryJob/failJob with no console
        // output (see runner.ts), so without this log line a Cloudflare
        // 401/5xx/DNS failure/timeout would show up only in
        // `job_outbox.last_error`, never in `docker logs worker`. Log, then
        // rethrow the SAME error so the runner's retry/backoff is unchanged.
        const reason = error instanceof Error ? error.message : "Unknown access-sync error";
        log(`access-sync: run failed: ${reason}`);
        throw error;
      }
      if (result.outcome === "skipped") {
        // `detail` is set only for the "no active users" skip, whose disable
        // half may already have run — prefer it over the fixed "not
        // configured" wording, which would send the operator to `cf-config`
        // for a run that never needed it. Same pattern as `aborted` below.
        await repository.failJob(
          job.id,
          result.detail ?? "Cloudflare Access is not configured — run cf-config and cf-token",
        );
        return;
      }
      if (result.outcome === "aborted") {
        // A run that refused to act is not a success. Failed re-arms on the next
        // trigger and on the next hourly tick, so nothing is stuck.
        await repository.failJob(job.id, `aborted: ${result.detail ?? "blast-radius cap"}`);
        return;
      }
      const armId = job.payload.armId;
      if (typeof armId !== "string" || armId === "") {
        // Only the arm SQL (packages/db, untouched here) ever writes this
        // row, and it always sets a UUID, so this is unreachable today. But a
        // silent "" fallback would make `finishAccessSync` never match,
        // leaving the row `pending` and immediately reclaimable — a hot loop
        // of one Cloudflare request per second, forever. Fail loudly instead.
        await repository.failJob(
          job.id,
          "access.sync job payload is missing its arm marker (armId) — refusing to finish it",
        );
        return;
      }
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
      // Two passes, public key first: a node can briefly carry a stale peer
      // and the current one under the same deterministic label (mid-rotation,
      // or a label collision), and a single OR'd pass matched whichever came
      // first in the node's own list order. The public key uniquely
      // identifies the live peer, so it must win whenever it is available;
      // the label is only a fallback for keys that have none. Each peer is
      // still claimed at most once, via the same `unmatchedPeerIndexes`.
      const matchedPeerByKeyId = new Map<string, (typeof nodePeers)[number]>();
      for (const key of context.keys) {
        if (key.publicKey === null) continue;
        const peerIndex = nodePeers.findIndex(
          ({ peer }, index) =>
            unmatchedPeerIndexes.has(index) && peer.id === key.publicKey,
        );
        if (peerIndex < 0) continue;
        unmatchedPeerIndexes.delete(peerIndex);
        matchedPeerByKeyId.set(key.keyId, nodePeers[peerIndex]!);
      }
      for (const key of context.keys) {
        if (matchedPeerByKeyId.has(key.keyId)) continue;
        const peerIndex = nodePeers.findIndex(
          ({ nodeLabel }, index) =>
            unmatchedPeerIndexes.has(index) && nodeLabel === key.nodeLabel,
        );
        if (peerIndex < 0) continue;
        unmatchedPeerIndexes.delete(peerIndex);
        matchedPeerByKeyId.set(key.keyId, nodePeers[peerIndex]!);
      }
      // Order follows `context.keys`, same as before: nothing downstream
      // indexes into this array, `completeNodeReconcile` folds it into a
      // Map keyed by `keyId` before using it.
      const peers = context.keys.flatMap((key) => {
        const matched = matchedPeerByKeyId.get(key.keyId);
        return matched
          ? [toPeerObservation(key.keyId, matched.peer, observedAt)]
          : [];
      });
      // A key whose revoke permanently failed sits in `revoking` with its
      // peer still live on the node -- it is still "managed" above (removing
      // it would freeze its peer_current row), but it should not read as a
      // clean reconcile: the peer is cleanup work, not something the panel
      // is knowingly keeping. Counted separately rather than folded into
      // missing/orphan, which are about the node's inventory disagreeing
      // with the panel's, not about a key stuck mid-delete. A `revoking` key
      // with no peer is the delete having actually succeeded -- not a
      // discrepancy either -- so it is excluded from `missingManagedPeerCount`
      // the same way a matched one is excluded from it already.
      const revokingKeys = context.keys.filter((key) => key.state === "revoking");
      const strandedRevokingPeerCount = revokingKeys.filter((key) =>
        matchedPeerByKeyId.has(key.keyId),
      ).length;
      const missingManagedPeerCount = context.keys.filter(
        (key) => key.state !== "revoking" && !matchedPeerByKeyId.has(key.keyId),
      ).length;
      const tunnelIpv4Backfills = context.keys.flatMap((key) => {
        if (key.protocol !== "awg3" || key.tunnelIpv4) return [];
        const matched = matchedPeerByKeyId.get(key.keyId);
        if (!matched) return [];
        const ip = extractPeerIpv4(matched.peer.allowedIps);
        return ip ? [{ keyId: key.keyId, tunnelIpv4: ip }] : [];
      });
      await repository.completeNodeReconcile({
        jobId: job.id,
        nodeId,
        observedAt,
        managedKeyIds: context.keys.map((key) => key.keyId),
        peers,
        ...(tunnelIpv4Backfills.length > 0 ? { tunnelIpv4Backfills } : {}),
        summary: {
          managedKeyCount: context.keys.length,
          observedPeerCount: nodePeers.length,
          matchedPeerCount: peers.length,
          missingManagedPeerCount,
          orphanNodePeerCount: unmatchedPeerIndexes.size,
          revokingKeyCount: revokingKeys.length,
          strandedRevokingPeerCount,
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
    if (job.type === NODE_IPV6_REJECT_STUB_JOB_TYPE) {
      const { nodeId, enabled, prefix } = nodeIpv6RejectStubPayloadSchema.parse(
        job.payload,
      );
      const context = await repository.loadNodeReconcileContext(nodeId);
      if (!context) {
        await repository.failJob(
          job.id,
          "Node IPv6 reject stub target not found",
        );
        return;
      }
      const outcome = await createNodeAgent(context.node).setIpv6RejectStub({
        enabled,
        prefix,
      });
      const observedAt = now();
      if (!outcome.ok) {
        await repository.completeNodeIpv6RejectStub({
          jobId: job.id,
          nodeId,
          enabled: false,
          prefix: prefix ?? DEFAULT_IPV6_REJECT_STUB_PREFIX,
          state: "unsupported",
          reason: outcome.code,
          observedAt,
        });
        return;
      }
      const { status } = outcome;
      const state: NodeIpv6RejectStubState = !status.supported
        ? status.enabled
          ? "unsupported"
          : "off"
        : status.enabled && status.active
          ? "active"
          : !status.enabled && !status.active
            ? "off"
            : "error";
      await repository.completeNodeIpv6RejectStub({
        jobId: job.id,
        nodeId,
        enabled: status.enabled,
        prefix: status.prefix,
        state,
        reason: status.reason,
        observedAt,
      });
      return;
    }
    if (job.type === NODE_SYNC_EGRESS_JOB_TYPE) {
      const { nodeId } = nodeJobPayloadSchema.parse(job.payload);
      if (!repository.loadNodeEgressSyncContext) {
        await repository.completeJob(job.id);
        return;
      }
      const rawSyncContext = await repository.loadNodeEgressSyncContext(nodeId);
      if (!rawSyncContext) {
        await repository.failJob(job.id, "Node egress sync target not found");
        return;
      }
      const nodeAgent = createNodeAgent(rawSyncContext.node);
      const syncContext = await hydrateMissingTunnelIpv4s(
        rawSyncContext,
        nodeAgent,
        repository,
        now(),
      );
      const desired = buildNodeEgressDesiredState(syncContext);
      const outcome = await nodeAgent.putServerEgress(desired);
      const observedAt = now();
      if (outcome === null) {
        await repository.markNodeEgressUnavailable?.(nodeId, observedAt);
      } else {
        await repository.mirrorNodeEgressReport?.(nodeId, outcome.report, observedAt);
      }
      await repository.completeJob(job.id);
      return;
    }
    if (job.type === NODE_SWITCH_EGRESS_MODE_JOB_TYPE) {
      const { nodeId, mode, previousMode } = nodeSwitchEgressModePayloadSchema.parse(job.payload);
      if (!repository.loadNodeEgressSyncContext || !repository.completeNodeEgressModeSwitch) {
        await repository.failJob(job.id, "Node egress mode switch repository is not wired");
        return;
      }
      const rawSyncContext = await repository.loadNodeEgressSyncContext(nodeId);
      if (!rawSyncContext) {
        await repository.failJob(job.id, "Node egress mode switch target not found");
        return;
      }
      const nodeAgent = createNodeAgent(rawSyncContext.node);
      if (mode === "routed") {
        // Pre-0072 legacy AWG 3.1 keys have tunnelIpv4 === null until backfilled from live node peers.
        // Hydrate them before pushing desired state so fail-closed rules never drop live clients at cutover.
        const syncContext = await hydrateMissingTunnelIpv4s(
          rawSyncContext,
          nodeAgent,
          repository,
          now(),
        );
        const prewarm = await nodeAgent.putServerEgress(buildNodeEgressDesiredState(syncContext));
        if (prewarm === null) {
          await repository.completeNodeEgressModeSwitch({
            jobId: job.id,
            nodeId,
            mode,
            ...(previousMode ? { previousMode } : {}),
            state: "failed",
            message: "node-agent does not serve /server/egress",
            observedAt: now(),
          });
          return;
        }
      }
      const switched = await nodeAgent.switchEgressMode(mode);
      const observedAt = now();
      if (!switched.ok) {
        await repository.completeNodeEgressModeSwitch({
          jobId: job.id,
          nodeId,
          mode,
          ...(previousMode ? { previousMode } : {}),
          state: "failed",
          message: switched.error ?? "Host egress mode switch failed",
          report: switched.report ?? null,
          observedAt,
        });
        return;
      }
      await repository.completeNodeEgressModeSwitch({
        jobId: job.id,
        nodeId,
        mode,
        ...(previousMode ? { previousMode } : {}),
        state: "idle",
        message: null,
        report: switched.report ?? null,
        observedAt,
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
          ...(context.egressHint ? [context.egressHint] : []),
        );
        const tunnelIpv4 =
          context.protocol === "awg3" ? tryExtractBaseClientIpv4(created.config) : null;
        await repository.completeProvision({
          jobId: job.id,
          keyId,
          publicKey: created.id,
          vpnConfig: created.config,
          ...(context.protocol === "awg3" ? { tunnelIpv4 } : {}),
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
      if (oldPeer) {
        try {
          await agent.deleteClient(oldPeer, context.protocol);
        } catch (error) {
          if (!(error instanceof Error && /status 404/.test(error.message))) {
            throw error;
          }
        }
      }
      try {
        const created = await agent.createClient(
          context.nodeLabel,
          context.protocol,
          ...(context.egressHint ? [context.egressHint] : []),
        );
        const tunnelIpv4 =
          context.protocol === "awg3" ? tryExtractBaseClientIpv4(created.config) : null;
        await repository.completeProvision({
          jobId: job.id,
          keyId,
          publicKey: created.id,
          vpnConfig: created.config,
          ...(context.protocol === "awg3" ? { tunnelIpv4 } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown node error";
        await reconcileOrphan(context, agent, reason);
        throw error instanceof Error ? error : new Error(reason);
      }
      return;
    }

    if (job.type === "vpn-key.revoke") {
      const clients = await agent.listClients();
      // Resolve by public key first, label as fallback - the same order the
      // reconcile matcher uses (see telemetry.ts). A label alone is ambiguous
      // when one username carries more than one peer (mid-rotation, or
      // awg2/awg3 peers merged under one username by the node-agent):
      // picking client.peers[0] on a label match could delete the stale peer
      // and leave the live one on the node with no key row pointing at it.
      const client =
        (context.publicKey
          ? clients.find((c) =>
              c.peers.some((peer) => peer.id === context.publicKey),
            )
          : undefined) ?? clients.find((c) => c.username === context.nodeLabel);
      // `vpn_keys` has a unique index on (node_id, node_label), so a label
      // belongs to exactly one key. Delete every peer under it, not just the
      // one that matched, so a stale peer from a rotation or an awg2/awg3
      // merge cannot survive the revoke.
      if (client) {
        for (const peer of client.peers) {
          await agent.deleteClient(peer.id, context.protocol);
        }
      }
      // Absent still means success: the node-agent answers 404 for a peer that
      // is already gone, and a revoke that cannot find its label has nothing
      // to do.
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
        ...(enabled && context.egressHint ? [context.egressHint] : []),
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
