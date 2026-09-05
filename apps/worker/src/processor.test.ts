import { describe, expect, it, vi } from "vitest";
import { createJobProcessor } from "./processor.js";
import { runWorker } from "./runner.js";
import type { NodeAgent } from "./nodeAgent.js";
import type { WorkerRepository } from "./repository.js";

const job = {
  id: "job-1",
  type: "vpn-key.provision",
  attempts: 1,
  payload: { keyId: "key-1" },
};

const keyContext = {
  keyId: "key-1",
  state: "provisioning" as const,
  nodeLabel: "ap_deterministic",
  protocol: "awg2" as const,
  publicKey: null,
  node: { id: "node-1", baseUrl: "http://node", apiKey: "node-secret" },
};

const createRepository = (): WorkerRepository => ({
  claimJob: vi.fn(() => Promise.resolve(null)),
  reconcileAccess: vi.fn(() =>
    Promise.resolve({ deactivated: [], skippedAdmins: [] }),
  ),
  recordAccessSyncAborted: vi.fn(() => Promise.resolve()),
  getAccessSyncDesiredDomains: vi.fn(() => Promise.resolve([])),
  getAccessSyncBaselineDomains: vi.fn(() => Promise.resolve([])),
  setAccessSyncBaseline: vi.fn(() => Promise.resolve()),
  armAccessSync: vi.fn(() => Promise.resolve()),
  finishAccessSync: vi.fn(() => Promise.resolve()),
  loadKeyContext: vi.fn(() => Promise.resolve(keyContext)),
  loadNodeReconcileContext: vi.fn(() => Promise.resolve(null)),
  completeNodeReconcile: vi.fn(() => Promise.resolve()),
  completeNodeAgentUpdate: vi.fn(() => Promise.resolve()),
  completeNodeCapacityChange: vi.fn(() => Promise.resolve()),
  saveNodeAgentRelease: vi.fn(() => Promise.resolve()),
  completeProvision: vi.fn(() => Promise.resolve()),
  completeLifecycle: vi.fn(() => Promise.resolve()),
  completeJob: vi.fn(() => Promise.resolve()),
  retryJob: vi.fn(() => Promise.resolve()),
  failJob: vi.fn(() => Promise.resolve()),
});

const createAgent = (): NodeAgent => ({
  getAgentUpdate: vi.fn(() => Promise.resolve(null)),
  getCapacity: vi.fn(() => Promise.resolve(null)),
  requestCapacity: vi.fn((maxPeers: number) =>
    Promise.resolve({ id: "capacity-request", maxPeers }),
  ),
  runChecks: vi.fn(() => Promise.resolve(null)),
  requestAgentUpdate: vi.fn((image: string) =>
    Promise.resolve({ id: "req-1", image }),
  ),
  getHealth: vi.fn(() => Promise.resolve({ ok: true as const })),
  getServer: vi.fn(() =>
    Promise.resolve({
      id: "node-1",
      region: "test",
      weight: 100,
      maxPeers: 500,
      totalPeers: 0,
      protocols: ["amneziawg2"],
    }),
  ),
  getServerLoad: vi.fn(() =>
    Promise.resolve({
      timestamp: "2026-08-20T08:00:00.000Z",
      uptimeSec: 60,
      loadavg: [0, 0, 0] as [number, number, number],
      cpu: { cores: 1 },
      memory: { totalBytes: 1, freeBytes: 1, usedBytes: 0 },
      disk: null,
      network: null,
      docker: null,
    }),
  ),
  listClients: vi.fn(() => Promise.resolve([])),
  createClient: vi.fn(() =>
    Promise.resolve({
      id: "public-key",
      config: "vpn://config",
      protocol: "amneziawg2",
    }),
  ),
  deleteClient: vi.fn(() => Promise.resolve()),
  setClientStatus: vi.fn(() => Promise.resolve()),
});

describe("provision job reconciliation", () => {
  it("stores the config and activates a newly created peer", async () => {
    const repository = createRepository();
    const agent = createAgent();
    const process = createJobProcessor({ repository, createNodeAgent: () => agent });

    await process(job);

    expect(repository.completeProvision).toHaveBeenCalledWith({
      jobId: job.id,
      keyId: keyContext.keyId,
      publicKey: "public-key",
      vpnConfig: "vpn://config",
    });
  });

  it("removes an orphan after an uncertain POST and retries later", async () => {
    const repository = createRepository();
    const agent = createAgent();
    vi.mocked(agent.createClient).mockRejectedValue(new Error("timeout"));
    vi.mocked(agent.listClients)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          username: keyContext.nodeLabel,
          peers: [
            {
              id: "orphan-public-key",
              name: null,
              allowedIps: [],
              lastHandshake: 0,
              traffic: { received: 0, sent: 0 },
              endpoint: null,
              online: false,
              expiresAt: null,
              status: "active",
              protocol: "amneziawg2",
            },
          ],
        },
      ]);
    const process = createJobProcessor({ repository, createNodeAgent: () => agent });

    await expect(process(job)).rejects.toThrow("reconciled orphan");

    expect(agent.deleteClient).toHaveBeenCalledWith(
      "orphan-public-key",
      "awg2",
    );
    expect(repository.retryJob).not.toHaveBeenCalled();
    expect(agent.createClient).toHaveBeenCalledTimes(1);
    expect(repository.completeProvision).not.toHaveBeenCalled();
  });

  it("does not create a second peer when an orphan already exists", async () => {
    const repository = createRepository();
    const agent = createAgent();
    vi.mocked(agent.listClients).mockResolvedValue([
      {
        username: keyContext.nodeLabel,
        peers: [
          {
            id: "orphan-public-key",
            name: null,
            allowedIps: [],
            lastHandshake: 0,
            traffic: { received: 0, sent: 0 },
            endpoint: null,
            online: false,
            expiresAt: null,
            status: "active",
            protocol: "amneziawg2",
          },
        ],
      },
    ]);
    const process = createJobProcessor({ repository, createNodeAgent: () => agent });

    await expect(process(job)).rejects.toThrow("reconciled orphan");

    expect(agent.createClient).not.toHaveBeenCalled();
    expect(agent.deleteClient).toHaveBeenCalledOnce();
    expect(repository.retryJob).not.toHaveBeenCalled();
  });

  it("lets the runner enforce maxAttempts after a provisioning failure", async () => {
    const controller = new AbortController();
    const repository = createRepository();
    vi.mocked(repository.claimJob).mockResolvedValueOnce({ ...job, attempts: 10 });
    vi.mocked(repository.failJob).mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    vi.mocked(repository.retryJob).mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    const agent = createAgent();
    vi.mocked(agent.createClient).mockRejectedValue(new Error("node unavailable"));
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
    });

    await runWorker({
      repository,
      processJob,
      signal: controller.signal,
      idleDelayMs: 0,
      maxAttempts: 10,
    });

    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      "node unavailable",
    );
    expect(repository.retryJob).not.toHaveBeenCalled();
  });

  it("reconciles inventory read-only by public key and node label", async () => {
    const repository = createRepository();
    const loadNodeReconcileContext = vi.fn<
      WorkerRepository["loadNodeReconcileContext"]
    >(() =>
      Promise.resolve({
        node: keyContext.node,
        keys: [
          { keyId: "key-1", publicKey: "public-key-1", nodeLabel: "label-1" },
          { keyId: "key-2", publicKey: null, nodeLabel: "label-2" },
          { keyId: "key-3", publicKey: "missing-key", nodeLabel: "label-3" },
        ],
      }),
    );
    const completeNodeReconcile = vi.fn<
      WorkerRepository["completeNodeReconcile"]
    >(() => Promise.resolve());
    Object.assign(repository, {
      loadNodeReconcileContext,
      completeNodeReconcile,
    });
    const agent = createAgent();
    vi.mocked(agent.listClients).mockResolvedValue([
      {
        username: "unrelated-label",
        peers: [
          {
            id: "public-key-1",
            name: null,
            allowedIps: [],
            lastHandshake: 1_787_213_070,
            traffic: { received: 120, sent: 80 },
            endpoint: "203.0.113.1:51889",
            online: true,
            expiresAt: null,
            status: "active",
            protocol: "amneziawg2",
          },
        ],
      },
      {
        username: "label-2",
        peers: [
          {
            id: "generated-key-2",
            name: null,
            allowedIps: [],
            lastHandshake: 0,
            traffic: { received: 0, sent: 0 },
            endpoint: null,
            online: false,
            expiresAt: null,
            status: "active",
            protocol: "amneziawg2",
          },
        ],
      },
      {
        username: "orphan-label",
        peers: [
          {
            id: "orphan-public-key",
            name: null,
            allowedIps: [],
            lastHandshake: 0,
            traffic: { received: 0, sent: 0 },
            endpoint: null,
            online: false,
            expiresAt: null,
            status: "active",
            protocol: "amneziawg2",
          },
        ],
      },
    ]);
    const now = new Date("2026-08-20T08:05:00.000Z");
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
      now: () => now,
    });

    await processJob({
      id: "reconcile-1",
      type: "node.reconcile",
      attempts: 1,
      payload: { nodeId: "node-1" },
    });

    expect(loadNodeReconcileContext).toHaveBeenCalledWith("node-1");
    expect(completeNodeReconcile).toHaveBeenCalledOnce();
    const result = completeNodeReconcile.mock.calls[0]?.[0];
    expect(result).toMatchObject({
      jobId: "reconcile-1",
      nodeId: "node-1",
      observedAt: now,
      managedKeyIds: ["key-1", "key-2", "key-3"],
      summary: {
        managedKeyCount: 3,
        observedPeerCount: 3,
        matchedPeerCount: 2,
        missingManagedPeerCount: 1,
        orphanNodePeerCount: 1,
      },
    });
    expect(result?.peers).toEqual([
      expect.objectContaining({
        keyId: "key-1",
        online: true,
        receivedBytes: 120n,
        sentBytes: 80n,
      }),
      expect.objectContaining({
        keyId: "key-2",
        online: false,
        receivedBytes: 0n,
        sentBytes: 0n,
      }),
    ]);
    expect(JSON.stringify(result?.summary)).not.toContain("label");
    expect(JSON.stringify(result?.summary)).not.toContain("public-key");
    expect(agent.deleteClient).not.toHaveBeenCalled();
    expect(agent.setClientStatus).not.toHaveBeenCalled();
    expect(agent.createClient).not.toHaveBeenCalled();
    expect(repository.failJob).not.toHaveBeenCalled();
    expect(repository.completeJob).not.toHaveBeenCalled();
  });
});

describe("rotate job", () => {
  it("deletes the old peer and issues fresh key material", async () => {
    const repository = createRepository();
    vi.mocked(repository.loadKeyContext).mockResolvedValue({
      ...keyContext,
      publicKey: "old-public-key",
    });
    const agent = createAgent();
    vi.mocked(agent.createClient).mockResolvedValue({
      id: "new-public-key",
      config: "vpn://rotated",
      protocol: "amneziawg2",
    });
    const process = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
    });

    await process({
      id: "job-rot",
      type: "vpn-key.rotate",
      attempts: 1,
      payload: { keyId: "key-1" },
    });

    expect(agent.deleteClient).toHaveBeenCalledWith("old-public-key", "awg2");
    expect(agent.createClient).toHaveBeenCalledWith("ap_deterministic", "awg2");
    expect(repository.completeProvision).toHaveBeenCalledWith({
      jobId: "job-rot",
      keyId: "key-1",
      publicKey: "new-public-key",
      vpnConfig: "vpn://rotated",
    });
  });
});

describe("manual route-feed refresh job", () => {
  const refreshJob = {
    id: "job-refresh",
    type: "rules.refresh",
    attempts: 0,
    payload: { requestedAt: "2026-09-01T10:00:00.000Z" },
  };

  it("runs every configured feed fetcher and completes the job", async () => {
    const repository = createRepository();
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const process = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      ruleFetchers: [first, second],
    });

    await process(refreshJob);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // An unchanged feed is a no-op by design, so finishing is a success.
    expect(repository.completeJob).toHaveBeenCalledWith(refreshJob.id);
    expect(repository.failJob).not.toHaveBeenCalled();
  });

  it("fails the job with a clear message when no feed is configured", async () => {
    const repository = createRepository();
    const process = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      ruleFetchers: [],
    });

    await process(refreshJob);

    expect(repository.failJob).toHaveBeenCalledWith(
      refreshJob.id,
      "No route-rule feeds are configured (set RULE_FEEDS on the worker)",
    );
    expect(repository.completeJob).not.toHaveBeenCalled();
  });

  it("still attempts every feed when one of them fails, then reports it", async () => {
    const repository = createRepository();
    const broken = vi.fn(() => Promise.reject(new Error("feed 502")));
    const healthy = vi.fn(() => Promise.resolve());
    const process = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      ruleFetchers: [broken, healthy],
    });

    await expect(process(refreshJob)).rejects.toThrowError(
      "Rule feed refresh failed: feed 502",
    );
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(repository.completeJob).not.toHaveBeenCalled();
  });

  it("lets the runner retry a failed refresh instead of losing it", async () => {
    const repository = createRepository();
    const process = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      ruleFetchers: [() => Promise.reject(new Error("feed 502"))],
    });
    const controller = new AbortController();
    vi.mocked(repository.claimJob)
      .mockResolvedValueOnce(refreshJob)
      .mockImplementation(() => {
        controller.abort();
        return Promise.resolve(null);
      });

    await runWorker({
      repository,
      processJob: process,
      signal: controller.signal,
      idleDelayMs: 0,
    });

    expect(repository.retryJob).toHaveBeenCalledWith(
      refreshJob.id,
      "Rule feed refresh failed: feed 502",
    );
  });

  it("asks the node to update and finishes without waiting for the outcome", async () => {
    const repository = createRepository();
    const agent = createAgent();
    vi.mocked(repository.loadNodeReconcileContext).mockResolvedValue({
      node: keyContext.node,
      keys: [],
    });
    const now = new Date("2026-09-03T12:00:00.000Z");
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
      now: () => now,
    });
    const image = `ghcr.io/owner/repo/node-agent@sha256:${"a".repeat(64)}`;

    await processJob({
      id: "update-1",
      type: "node.agent-update",
      attempts: 1,
      payload: { nodeId: "node-1", image },
    });

    expect(agent.requestAgentUpdate).toHaveBeenCalledWith(image);
    // The worker claims jobs one at a time, so waiting here for a pull, a
    // container swap and a health gate would stall every other job for minutes.
    // The telemetry poll is what learns the outcome.
    expect(repository.completeNodeAgentUpdate).toHaveBeenCalledWith({
      jobId: "update-1",
      nodeId: "node-1",
      image,
      requestedAt: now,
    });
    expect(agent.getAgentUpdate).not.toHaveBeenCalled();
  });

  it("asks the node to change its capacity and does not wait for the outcome", async () => {
    const repository = createRepository();
    const agent = createAgent();
    vi.mocked(repository.loadNodeReconcileContext).mockResolvedValue({
      node: keyContext.node,
      keys: [],
    });
    const now = new Date("2026-09-04T12:00:00.000Z");
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
      now: () => now,
    });

    await processJob({
      id: "capacity-1",
      type: "node.set-capacity",
      attempts: 1,
      payload: { nodeId: "node-1", maxPeers: 300 },
    });

    expect(agent.requestCapacity).toHaveBeenCalledWith(300);
    // Same reasoning as the agent update above: the recreate and its health
    // gate take longer than a job slot is worth, and the telemetry poll is what
    // learns the outcome.
    expect(repository.completeNodeCapacityChange).toHaveBeenCalledWith({
      jobId: "capacity-1",
      nodeId: "node-1",
      maxPeers: 300,
      requestedAt: now,
    });
    expect(agent.getCapacity).not.toHaveBeenCalled();
  });

  it("fails a capacity change aimed at a node that is gone", async () => {
    const repository = createRepository();
    const agent = createAgent();
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
    });
    vi.mocked(repository.loadNodeReconcileContext).mockResolvedValue(null);

    await processJob({
      id: "capacity-2",
      type: "node.set-capacity",
      attempts: 1,
      payload: { nodeId: "gone", maxPeers: 300 },
    });

    expect(agent.requestCapacity).not.toHaveBeenCalled();
    expect(repository.failJob).toHaveBeenCalledWith(
      "capacity-2",
      "Node capacity target not found",
    );
  });

  it("fails an update aimed at a node that is gone", async () => {
    const repository = createRepository();
    const agent = createAgent();
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => agent,
    });

    await processJob({
      id: "update-2",
      type: "node.agent-update",
      attempts: 1,
      payload: {
        nodeId: "gone",
        image: `ghcr.io/owner/repo/node-agent@sha256:${"b".repeat(64)}`,
      },
    });

    expect(agent.requestAgentUpdate).not.toHaveBeenCalled();
    expect(repository.failJob).toHaveBeenCalledWith(
      "update-2",
      "Node agent update target not found",
    );
  });
});

describe("Access sync job", () => {
  const syncJob = {
    id: "job-sync",
    type: "access.sync",
    payload: { requestedAt: "2026-09-05T00:00:00.000Z", armId: "arm-1", reason: "timer" },
    attempts: 0,
  };

  it("runs the Access sync job and finishes it with the arm marker it claimed", async () => {
    const repository = createRepository();
    const accessSync = vi.fn(() => Promise.resolve({ outcome: "synced" as const }));
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await processJob(syncJob);

    expect(accessSync).toHaveBeenCalledOnce();
    expect(repository.finishAccessSync).toHaveBeenCalledWith("job-sync", "arm-1");
    expect(repository.failJob).not.toHaveBeenCalled();
  });

  it("fails the sync job when the worker does not have the sync enabled", async () => {
    const repository = createRepository();
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
    });

    await processJob(syncJob);

    expect(repository.failJob).toHaveBeenCalledWith(
      "job-sync",
      expect.stringMatching(/ACCESS_SYNC_ENABLED/),
    );
    expect(repository.finishAccessSync).not.toHaveBeenCalled();
  });

  it("fails the sync job when Cloudflare is not configured", async () => {
    const repository = createRepository();
    const accessSync = vi.fn(() => Promise.resolve({ outcome: "skipped" as const }));
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await processJob(syncJob);

    expect(repository.failJob).toHaveBeenCalledWith(
      "job-sync",
      expect.stringMatching(/not configured/i),
    );
  });

  it("tells the operator the disable already ran, not to run cf-config, when skipped for having no active users", async () => {
    // The two `skipped` reasons must reach the operator distinctly: this one
    // means the run acted (or found nothing due) and only the write-back had
    // nothing to push, so "run cf-config" would be the wrong remedy — unlike
    // the "not configured" case just above, which shares this same outcome
    // string but no `detail`.
    const repository = createRepository();
    const accessSync = vi.fn(() =>
      Promise.resolve({
        outcome: "skipped" as const,
        detail: "No active panel users to write back to Cloudflare.",
      }),
    );
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await processJob(syncJob);

    expect(repository.failJob).toHaveBeenCalledWith(
      "job-sync",
      "No active panel users to write back to Cloudflare.",
    );
  });

  it("fails the sync job, without throwing, when the run aborted on the cap", async () => {
    const repository = createRepository();
    const accessSync = vi.fn(() =>
      Promise.resolve({ outcome: "aborted" as const, detail: "3 account(s) would be disabled" }),
    );
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await expect(processJob(syncJob)).resolves.toBeUndefined();
    expect(repository.failJob).toHaveBeenCalledWith(
      "job-sync",
      expect.stringMatching(/3 account\(s\)/),
    );
  });

  it("lets the runner retry a sync that threw", async () => {
    const repository = createRepository();
    const accessSync = vi.fn(() => Promise.reject(new Error("cloudflare 502")));
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await expect(processJob(syncJob)).rejects.toThrow(/cloudflare 502/);
    expect(repository.failJob).not.toHaveBeenCalled();
  });

  it("logs a throwing sync before letting the runner retry it", async () => {
    // Before this range, the sync ran on a timer whose onError printed every
    // failure through reportBackgroundError. Now the outbox runner turns a
    // throw into retryJob/failJob with no console output (runner.ts), so
    // without this log line a Cloudflare 401/5xx/DNS failure/timeout would be
    // recorded only in job_outbox.last_error and never reach the worker log.
    const repository = createRepository();
    const accessSync = vi.fn(() => Promise.reject(new Error("cloudflare 502")));
    const log = vi.fn();
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
      log,
    });

    await expect(processJob(syncJob)).rejects.toThrow(/cloudflare 502/);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("cloudflare 502"));
    // The rethrow must still be the runner's to catch, unwrapped, so its
    // retry/backoff behaviour is unchanged.
    expect(repository.retryJob).not.toHaveBeenCalled();
    expect(repository.failJob).not.toHaveBeenCalled();
  });

  it("fails the job instead of spinning when the claimed payload has no arm marker", async () => {
    // Only the arm SQL (packages/db) ever writes this row and it always sets
    // a UUID armId, so this is unreachable today. But a silent "" fallback
    // here would make finishAccessSync never match, leaving the row pending
    // and immediately reclaimable — one Cloudflare request per second,
    // forever. It must fail loudly instead.
    const repository = createRepository();
    const accessSync = vi.fn(() => Promise.resolve({ outcome: "synced" as const }));
    const processJob = createJobProcessor({
      repository,
      createNodeAgent: () => createAgent(),
      accessSync,
    });

    await processJob({
      id: "job-sync-no-arm",
      type: "access.sync",
      payload: { requestedAt: "2026-09-05T00:00:00.000Z", reason: "timer" },
      attempts: 0,
    });

    expect(repository.finishAccessSync).not.toHaveBeenCalled();
    expect(repository.failJob).toHaveBeenCalledWith(
      "job-sync-no-arm",
      expect.stringMatching(/armId/i),
    );
  });
});
