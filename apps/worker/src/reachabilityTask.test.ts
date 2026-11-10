import { describe, expect, it, vi } from "vitest";

import type { ProbeRunRequest, ProbeRunState } from "@amnezia/contracts";

import type { ProbeClient } from "./probeAgent.js";
import {
  createReachabilityTask,
  type ProbeRow,
  type ReachabilityRepository,
  type RunTarget,
} from "./reachabilityTask.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const probeRow = (extra: Partial<ProbeRow> = {}): ProbeRow => ({
  label: "Testland",
  apiBaseUrl: "http://probe.test:4002",
  apiKey: "k".repeat(32),
  enabled: true,
  controlUrl: "https://example.com/",
  egressUrl: "https://example.org/",
  intervalSec: 3600,
  failThreshold: 2,
  staleAfterSec: 10_800,
  runRequestedAt: null,
  currentRunId: null,
  currentRunStartedAt: hoursAgo(0.5),
  lastResultAt: hoursAgo(0.4),
  lastIngestedRunId: null,
  staleAlertedAt: null,
  createdAt: hoursAgo(48),
  ...extra,
});

const targetA: RunTarget = {
  targetId: "id-node-a:awg3",
  nodeId: "id-node-a",
  nodeName: "node-a",
  publicIp: "192.0.2.10",
  protocol: "awg3",
  unavailableReason: null,
  config: "vpn://config-a",
  expectedEgressIp: "192.0.2.10",
};
const targetB: RunTarget = {
  ...targetA,
  targetId: "id-node-b:awg3",
  nodeId: "id-node-b",
  nodeName: "node-b",
  unavailableReason: "service key is provisioning",
  config: null,
};

const level = { ok: true, detail: null, latencyMs: 5 };
const finished = (runId: string): ProbeRunState => ({
  runId,
  startedAt: hoursAgo(0.5).toISOString(),
  finishedAt: hoursAgo(0.45).toISOString(),
  control: level,
  results: [
    {
      targetId: targetA.targetId,
      protocol: "awg3",
      status: "done",
      detail: null,
      endpointHost: "192.0.2.10",
      egressIp: "192.0.2.10",
      levels: { ping: level, tcp: level, handshake: level, http: level },
    },
  ],
});

const fakeRepository = (probe: ProbeRow | null): ReachabilityRepository => ({
  loadProbe: vi.fn(() => Promise.resolve(probe)),
  recordProbeError: vi.fn(() => Promise.resolve(undefined)),
  syncServiceKeys: vi.fn(() => Promise.resolve(({ created: 0, revoked: 0 }))),
  listTargets: vi.fn(() => Promise.resolve([targetA, targetB])),
  markRunStarted: vi.fn(() => Promise.resolve(undefined)),
  abandonRun: vi.fn(() => Promise.resolve(undefined)),
  loadStates: vi.fn(() => Promise.resolve(new Map())),
  ingest: vi.fn(() => Promise.resolve(undefined)),
  setStaleAlert: vi.fn(() => Promise.resolve(undefined)),
});

const fakeClient = (latest: ProbeRunState | null | Error = null): ProbeClient => ({
  latestRun: vi.fn(() =>
    latest instanceof Error ? Promise.reject(latest) : Promise.resolve(latest),
  ),
  startRun: vi.fn((request: ProbeRunRequest) =>
    Promise.resolve<{ runId: string } | "busy">({ runId: request.runId }),
  ),
});

const tick = async (repository: ReachabilityRepository, client: ProbeClient) => {
  const createProbeClient = vi.fn(() => client);
  await createReachabilityTask({
    repository,
    createProbeClient,
    now: () => NOW,
    newRunId: () => "run-new",
  })();
  return createProbeClient;
};

describe("reachability task", () => {
  it("does nothing without a probe", async () => {
    const repository = fakeRepository(null);
    const create = await tick(repository, fakeClient());
    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing for a disabled probe", async () => {
    const repository = fakeRepository(probeRow({ enabled: false }));
    const create = await tick(repository, fakeClient());
    expect(create).not.toHaveBeenCalled();
  });

  it("ingests the finished current run once", async () => {
    const repository = fakeRepository(probeRow({ currentRunId: "run-1" }));
    await tick(repository, fakeClient(finished("run-1")));
    expect(repository.ingest).toHaveBeenCalledTimes(1);
    const write = vi.mocked(repository.ingest).mock.calls[0]?.[0];
    expect(write?.runId).toBe("run-1");
    expect(write?.states.get("id-node-a")?.status).toBe("ok");
    expect(write?.states.get("id-node-b")?.status).toBe("error");
  });

  it("does not ingest a run already ingested", async () => {
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", lastIngestedRunId: "run-1" }),
    );
    await tick(repository, fakeClient(finished("run-1")));
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it("ignores a run the panel did not start", async () => {
    const repository = fakeRepository(probeRow({ currentRunId: "run-1" }));
    await tick(repository, fakeClient(finished("run-other")));
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it("waits while the current run is still going", async () => {
    const client = fakeClient({ ...finished("run-1"), finishedAt: null });
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: minutesAgo(5) }),
    );
    await tick(repository, client);
    expect(repository.ingest).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("starts a run when the interval has passed, sending only usable targets", async () => {
    const client = fakeClient();
    const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(1.1) }));
    await tick(repository, client);
    expect(repository.syncServiceKeys).toHaveBeenCalledTimes(1);
    const request = vi.mocked(client.startRun).mock.calls[0]?.[0];
    expect(request).toEqual({
      runId: "run-new",
      control: { url: "https://example.com/" },
      egress: { url: "https://example.org/" },
      targets: [
        {
          targetId: "id-node-a:awg3",
          protocol: "awg3",
          config: "vpn://config-a",
          expectedEgressIp: "192.0.2.10",
        },
      ],
    });
    expect(repository.markRunStarted).toHaveBeenCalledWith("run-new", NOW);
  });

  it("does not start before the interval", async () => {
    const client = fakeClient();
    await tick(fakeRepository(probeRow({ currentRunStartedAt: minutesAgo(30) })), client);
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("starts at once on run-now", async () => {
    const client = fakeClient();
    await tick(
      fakeRepository(
        probeRow({ currentRunStartedAt: minutesAgo(30), runRequestedAt: minutesAgo(1) }),
      ),
      client,
    );
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("starts the first run of a new probe", async () => {
    const client = fakeClient();
    await tick(fakeRepository(probeRow({ currentRunStartedAt: null, lastResultAt: null })), client);
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("abandons a run older than 30 minutes and starts a new one", async () => {
    const client = fakeClient(null);
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: hoursAgo(1.5) }),
    );
    await tick(repository, client);
    expect(repository.abandonRun).toHaveBeenCalledWith(NOW);
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("records an unreachable probe and moves no node state", async () => {
    const client = fakeClient(new Error("fetch failed"));
    vi.mocked(client.startRun).mockRejectedValue(new Error("fetch failed"));
    const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(2) }));
    await tick(repository, client);
    expect(repository.recordProbeError).toHaveBeenCalledWith("fetch failed", NOW);
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it("records a malformed reply", async () => {
    const repository = fakeRepository(probeRow());
    await tick(repository, fakeClient(new Error("Probe returned a malformed run")));
    expect(repository.recordProbeError).toHaveBeenCalledWith(
      "Probe returned a malformed run",
      NOW,
    );
  });

  it("records a busy probe without marking a run", async () => {
    const client = fakeClient();
    vi.mocked(client.startRun).mockResolvedValue("busy");
    const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(2) }));
    await tick(repository, client);
    expect(repository.markRunStarted).not.toHaveBeenCalled();
    expect(repository.recordProbeError).toHaveBeenCalled();
  });

  it("raises the stale alert once when the probe is silent", async () => {
    const repository = fakeRepository(
      probeRow({ lastResultAt: hoursAgo(4), currentRunStartedAt: minutesAgo(10) }),
    );
    await tick(repository, fakeClient(new Error("fetch failed")));
    expect(repository.setStaleAlert).toHaveBeenCalledWith(NOW, [
      expect.objectContaining({ dedupKey: `notify.reachability:stale:${NOW.toISOString()}` }),
    ]);
  });

  it("a key sync failure does not stop the run", async () => {
    const client = fakeClient();
    const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(2) }));
    vi.mocked(repository.syncServiceKeys).mockRejectedValue(new Error("db busy"));
    await tick(repository, client);
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });
});
