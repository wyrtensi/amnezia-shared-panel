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
  enabledAt: hoursAgo(48),
  timeZone: "UTC",
  candidateRun: null,
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
  syncServiceKeys: vi.fn(() => Promise.resolve(({ created: 0, revoked: 0, provisioning: 0 }))),
  listTargets: vi.fn(() => Promise.resolve([targetA, targetB])),
  markRunStarted: vi.fn(() => Promise.resolve(undefined)),
  abandonRun: vi.fn(() => Promise.resolve(undefined)),
  loadStates: vi.fn(() => Promise.resolve(new Map())),
  ingest: vi.fn(() => Promise.resolve(undefined)),
  setStaleAlert: vi.fn(() => Promise.resolve(undefined)),
  finishCandidateRun: vi.fn(() => Promise.resolve(undefined)),
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

  it("abandons a run the probe no longer reports and starts a new one", async () => {
    const client = fakeClient(null);
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: minutesAgo(70) }),
    );
    await tick(repository, client);
    expect(repository.abandonRun).toHaveBeenCalledWith(NOW, expect.stringContaining("lost"));
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting for its own long run", async () => {
    const client = fakeClient({ ...finished("run-1"), finishedAt: null });
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: hoursAgo(1.5) }),
    );
    await tick(repository, client);
    expect(repository.abandonRun).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("gives up on its own run after six hours", async () => {
    const client = fakeClient({ ...finished("run-1"), finishedAt: null });
    vi.mocked(client.startRun).mockResolvedValue("busy");
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: hoursAgo(6.5) }),
    );
    await tick(repository, client);
    expect(repository.abandonRun).toHaveBeenCalledWith(NOW, expect.stringContaining("6 hours"));
  });

  it("an unreachable probe neither abandons nor starts a run", async () => {
    const client = fakeClient(new Error("fetch failed"));
    const repository = fakeRepository(
      probeRow({ currentRunId: "run-1", currentRunStartedAt: hoursAgo(7) }),
    );
    await tick(repository, client);
    expect(repository.abandonRun).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("waits for freshly created keys before starting", async () => {
    const client = fakeClient();
    const repository = fakeRepository(probeRow({ currentRunStartedAt: null }));
    vi.mocked(repository.syncServiceKeys).mockResolvedValue({
      created: 2,
      revoked: 0,
      provisioning: 2,
    });
    await tick(repository, client);
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("syncs keys on every tick, not only when a run is due", async () => {
    const repository = fakeRepository(probeRow({ currentRunStartedAt: minutesAgo(5) }));
    await tick(repository, fakeClient());
    expect(repository.syncServiceKeys).toHaveBeenCalledTimes(1);
  });

  it("records an unreachable probe and moves no node state", async () => {
    const client = fakeClient(new Error("fetch failed"));
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

  it("writes alert times in the probe's time zone", async () => {
    const repository = fakeRepository(
      probeRow({
        lastResultAt: hoursAgo(4),
        currentRunStartedAt: minutesAgo(10),
        timeZone: "Europe/Belgrade",
      }),
    );
    await tick(repository, fakeClient(new Error("fetch failed")));
    const [, notices] = vi.mocked(repository.setStaleAlert).mock.calls[0] ?? [];
    expect(notices?.[0]?.text).toContain("2026-01-01 09:00 Europe/Belgrade");
  });

  it("a key sync failure does not stop the run", async () => {
    const client = fakeClient();
    const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(2) }));
    vi.mocked(repository.syncServiceKeys).mockRejectedValue(new Error("db busy"));
    await tick(repository, client);
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  describe("with a bridge candidate check holding the probe", () => {
    const candidate = (startedAt = minutesAgo(1)) => ({
      runId: "run-candidate",
      routeId: "route-1",
      registrationMarker: "m-1",
      requestedAt: minutesAgo(3),
      startedAt,
    });
    const candidateRun = (
      levels: Partial<Record<"handshake" | "http", typeof level>> = {},
      finishedAt: string | null = minutesAgo(0.5).toISOString(),
    ): ProbeRunState => ({
      runId: "run-candidate",
      startedAt: minutesAgo(1).toISOString(),
      finishedAt,
      control: level,
      results: [
        {
          targetId: "bridge-route:route-1",
          protocol: "awg3",
          status: "done",
          detail: null,
          endpointHost: "45.1.2.3",
          egressIp: "192.0.2.10",
          levels: {
            ping: { ok: false, detail: "no reply", latencyMs: null },
            tcp: { ok: false, detail: "refused", latencyMs: null },
            handshake: levels.handshake ?? level,
            http: levels.http ?? level,
          },
        },
      ],
    });

    it("waits for an unfinished candidate run and starts nothing", async () => {
      const client = fakeClient(candidateRun({}, null));
      // A regular run would be due by the interval.
      const repository = fakeRepository(
        probeRow({ currentRunStartedAt: hoursAgo(2), candidateRun: candidate() }),
      );
      await tick(repository, client);
      expect(repository.finishCandidateRun).not.toHaveBeenCalled();
      expect(repository.ingest).not.toHaveBeenCalled();
      expect(repository.syncServiceKeys).not.toHaveBeenCalled();
      expect(client.startRun).not.toHaveBeenCalled();
    });

    it("settles a finished candidate run on the route only, then resumes regular runs", async () => {
      const client = fakeClient(candidateRun());
      const repository = fakeRepository(
        probeRow({ currentRunStartedAt: hoursAgo(2), candidateRun: candidate() }),
      );
      await tick(repository, client);
      // Ping and TCP failed, handshake and HTTP passed: a bridge verdict is
      // the tunnel, not the diagnostics.
      expect(repository.finishCandidateRun).toHaveBeenCalledWith(candidate(), {
        result: "success",
        error: null,
        checkedAt: minutesAgo(0.5),
      });
      // Never fed to node state, alerts or the widget.
      expect(repository.ingest).not.toHaveBeenCalled();
      expect(repository.setStaleAlert).not.toHaveBeenCalled();
      // The probe is free again, so the due regular run starts.
      expect(client.startRun).toHaveBeenCalledTimes(1);
      expect(vi.mocked(client.startRun).mock.calls[0]?.[0].runId).toBe("run-new");
    });

    it.each([
      ["handshake", "AWG_HANDSHAKE_FAILED"],
      ["http", "HTTP_THROUGH_TUNNEL_FAILED"],
    ] as const)("records a failed %s as %s", async (failed, code) => {
      const client = fakeClient(
        candidateRun({ [failed]: { ok: false, detail: "timeout", latencyMs: null } }),
      );
      const repository = fakeRepository(probeRow({ candidateRun: candidate() }));
      await tick(repository, client);
      expect(repository.finishCandidateRun).toHaveBeenCalledWith(
        candidate(),
        expect.objectContaining({ result: "failure", error: code }),
      );
      expect(repository.ingest).not.toHaveBeenCalled();
    });

    it("gives up a candidate run the probe lost, after a grace period", async () => {
      const fresh = fakeRepository(probeRow({ candidateRun: candidate(minutesAgo(1)) }));
      await tick(fresh, fakeClient(finished("run-other")));
      expect(fresh.finishCandidateRun).not.toHaveBeenCalled();

      const lost = fakeRepository(probeRow({ candidateRun: candidate(minutesAgo(5)) }));
      await tick(lost, fakeClient(finished("run-other")));
      expect(lost.finishCandidateRun).toHaveBeenCalledWith(
        candidate(minutesAgo(5)),
        { result: "failure", error: "PROBE_RUN_LOST", checkedAt: NOW },
      );
      expect(lost.ingest).not.toHaveBeenCalled();
    });

    it("gives up an unfinished candidate run after its timeout", async () => {
      const repository = fakeRepository(probeRow({ candidateRun: candidate(minutesAgo(20)) }));
      await tick(repository, fakeClient(candidateRun({}, null)));
      expect(repository.finishCandidateRun).toHaveBeenCalledWith(
        candidate(minutesAgo(20)),
        { result: "failure", error: "PROBE_RUN_TIMEOUT", checkedAt: NOW },
      );
    });

    it("does not record a probe error when a candidate took the probe mid-tick", async () => {
      const client = fakeClient();
      vi.mocked(client.startRun).mockResolvedValue("busy");
      const repository = fakeRepository(probeRow({ currentRunStartedAt: hoursAgo(2) }));
      vi.mocked(repository.loadProbe)
        .mockResolvedValueOnce(probeRow({ currentRunStartedAt: hoursAgo(2) }))
        .mockResolvedValueOnce(probeRow({ candidateRun: candidate() }));
      await tick(repository, client);
      expect(repository.recordProbeError).not.toHaveBeenCalled();
      expect(repository.markRunStarted).not.toHaveBeenCalled();
    });
  });
});
