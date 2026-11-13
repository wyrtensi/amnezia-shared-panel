import { describe, expect, it, vi } from "vitest";

import {
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  type ProbeRunRequest,
} from "@amnezia/contracts";
import { inspectAwgVpnLink } from "@amnezia/vpn-config";

import { awgServiceLink } from "./awgArtifact.fixture.js";
import {
  createBridgeCandidateCheck,
  type BridgeCandidateRepository,
  type CandidateContext,
} from "./bridgeCandidateCheck.js";
import type { ProbeClient } from "./probeAgent.js";
import type { ProbeRow } from "./reachabilityTask.js";
import type { OutboxJob } from "./repository.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const ROUTE_ID = "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a";
const NODE_ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const REQUESTED_AT = new Date(NOW.getTime() - 60_000);

const job = (extra: Partial<OutboxJob> = {}): OutboxJob => ({
  id: "job-1",
  type: BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  attempts: 1,
  payload: {
    routeId: ROUTE_ID,
    nodeId: NODE_ID,
    registrationMarker: "m-1",
    requestedAt: REQUESTED_AT.toISOString(),
  },
  ...extra,
});

const probe = (extra: Partial<ProbeRow> = {}): ProbeRow => ({
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
  currentRunStartedAt: null,
  lastResultAt: null,
  lastIngestedRunId: null,
  staleAlertedAt: null,
  enabledAt: NOW,
  timeZone: "UTC",
  capabilities: null,
  candidateRun: null,
  ...extra,
});

const context = (extra: Partial<CandidateContext> = {}): CandidateContext => ({
  routeId: ROUTE_ID,
  nodeId: NODE_ID,
  state: "draft",
  retiringSince: null,
  bridgePublicIpv4: "45.1.2.3",
  publicUdpPort: 41005,
  nodePublicIp: "192.0.2.10",
  serviceConfig: awgServiceLink(),
  ...extra,
});

const setup = (
  options: {
    probe?: ProbeRow | null;
    context?: CandidateContext | null;
    claimed?: boolean;
    supports?: boolean;
    jobsEnabled?: boolean;
    start?: () => Promise<{ runId: string } | "busy">;
  } = {},
) => {
  const candidates: BridgeCandidateRepository = {
    loadCandidateContext: vi.fn(() =>
      Promise.resolve(options.context === undefined ? context() : options.context),
    ),
    claimCandidateRun: vi.fn(() => Promise.resolve(options.claimed ?? true)),
    releaseCandidateRun: vi.fn(() => Promise.resolve(undefined)),
    recordCandidateResult: vi.fn(() => Promise.resolve(true)),
  };
  const jobs = {
    completeJob: vi.fn(() => Promise.resolve(undefined)),
    failJob: vi.fn(() => Promise.resolve(undefined)),
  };
  const client: ProbeClient = {
    latestRun: vi.fn(() => Promise.resolve(null)),
    startRun: vi.fn(
      options.start ??
        ((request: ProbeRunRequest) => Promise.resolve({ runId: request.runId })),
    ),
  };
  const createProbeClient = vi.fn(() => client);
  const handle = createBridgeCandidateCheck({
    candidates,
    loadProbe: () => Promise.resolve(options.probe === undefined ? probe() : options.probe),
    jobs,
    createProbeClient,
    jobsEnabled: options.jobsEnabled ?? true,
    // The real capability lookup lands in Task 4a; forced here.
    ...(options.supports === false ? {} : { supportsBridgeMeasurement: () => true }),
    now: () => NOW,
    newRunId: () => "run-candidate",
  });
  return { handle, candidates, jobs, client, createProbeClient };
};

const recorded = (candidates: BridgeCandidateRepository) =>
  vi.mocked(candidates.recordCandidateResult).mock.calls.map(([write]) => write.outcome.error);

describe("bridge candidate check job", () => {
  it("starts a one-target run with the draft endpoint rendered into the service key", async () => {
    const { handle, candidates, jobs, client } = setup();
    await handle(job());
    expect(candidates.claimCandidateRun).toHaveBeenCalledWith({
      runId: "run-candidate",
      routeId: ROUTE_ID,
      registrationMarker: "m-1",
      requestedAt: REQUESTED_AT,
      startedAt: NOW,
    });
    const request = vi.mocked(client.startRun).mock.calls[0]?.[0];
    expect(request?.runId).toBe("run-candidate");
    expect(request?.targets).toHaveLength(1);
    const target = request?.targets[0];
    expect(target).toMatchObject({
      targetId: `bridge-route:${ROUTE_ID}`,
      protocol: "awg3",
      expectedEgressIp: "192.0.2.10",
    });
    const inspected = inspectAwgVpnLink(target?.config ?? "");
    expect(inspected).toMatchObject({ kind: "awg31", endpoint: { host: "45.1.2.3", port: 41005 } });
    expect(candidates.recordCandidateResult).not.toHaveBeenCalled();
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });

  it("reads the capability from the stored probe column through the shared lookup", async () => {
    const reported = setup({
      supports: false,
      probe: probe({ capabilities: ["bridge-measurement"] }),
    });
    await reported.handle(job());
    expect(reported.client.startRun).toHaveBeenCalledTimes(1);
    const unknown = setup({ supports: false, probe: probe({ capabilities: null }) });
    await unknown.handle(job());
    expect(recorded(unknown.candidates)).toEqual(["BRIDGE_UNSUPPORTED_CAPABILITY"]);
  });

  it("omits the egress comparison target when the node's origin IP is unknown", async () => {
    const { handle, client } = setup({ context: context({ nodePublicIp: null }) });
    await handle(job());
    expect(vi.mocked(client.startRun).mock.calls[0]?.[0].targets[0]).not.toHaveProperty(
      "expectedEgressIp",
    );
  });

  it("fails a malformed payload outright", async () => {
    const { handle, jobs, candidates } = setup();
    await handle(job({ payload: { routeId: ROUTE_ID } }));
    expect(jobs.failJob).toHaveBeenCalledWith("job-1", expect.stringContaining("malformed"));
    expect(candidates.recordCandidateResult).not.toHaveBeenCalled();
  });

  it.each([
    ["the gate is closed", { jobsEnabled: false }, "BRIDGE_JOBS_DISABLED"],
    ["no probe is configured", { probe: null }, "PROBE_UNAVAILABLE"],
    ["the probe is disabled", { probe: probe({ enabled: false }) }, "PROBE_UNAVAILABLE"],
    ["the capability is unknown", { supports: false }, "BRIDGE_UNSUPPORTED_CAPABILITY"],
    ["the node has no service key", { context: context({ serviceConfig: null }) }, "SERVICE_KEY_UNAVAILABLE"],
    [
      "the service key is the 2.0 fallback",
      { context: context({ serviceConfig: awgServiceLink({ protocolVersion: "2" }) }) },
      "SERVICE_KEY_NOT_AWG31",
    ],
  ] as const)("records a failure when %s", async (_label, options, code) => {
    const { handle, candidates, jobs, client } = setup(options);
    await handle(job());
    expect(recorded(candidates)).toEqual([code]);
    const write = vi.mocked(candidates.recordCandidateResult).mock.calls[0]?.[0];
    expect(write).toMatchObject({
      routeId: ROUTE_ID,
      registrationMarker: "m-1",
      requestedAt: REQUESTED_AT,
      outcome: { result: "failure", checkedAt: NOW },
    });
    expect(candidates.claimCandidateRun).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });

  it.each([
    ["released", null],
    ["activated", context({ state: "active" })],
    ["demoted after the request", context({ state: "retiring", retiringSince: NOW })],
    ["on another node", context({ nodeId: "1f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f" })],
  ] as const)("skips a route %s since queuing", async (_label, current) => {
    const { handle, candidates, jobs, client } = setup({ context: current });
    await handle(job());
    expect(candidates.recordCandidateResult).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });

  it("checks a retiring route demoted before the request", async () => {
    const { handle, client } = setup({
      context: context({ state: "retiring", retiringSince: new Date(REQUESTED_AT.getTime() - 1) }),
    });
    await handle(job());
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("retries while a regular run holds the probe, never replacing it", async () => {
    const { handle, candidates, jobs, client } = setup({
      probe: probe({ currentRunId: "run-regular" }),
    });
    await expect(handle(job())).rejects.toThrow("PROBE_BUSY");
    expect(candidates.claimCandidateRun).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
    expect(jobs.completeJob).not.toHaveBeenCalled();
  });

  it("retries when another worker won the claim", async () => {
    const { handle, client } = setup({ claimed: false });
    await expect(handle(job())).rejects.toThrow("PROBE_BUSY");
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it.each([
    ["busy", () => Promise.resolve("busy" as const), "PROBE_BUSY"],
    ["unreachable", () => Promise.reject(new Error("fetch failed")), "PROBE_START_FAILED"],
  ] as const)("gives the probe back when it is %s", async (_label, start, code) => {
    const { handle, candidates, jobs } = setup({ start });
    await expect(handle(job())).rejects.toThrow(code);
    expect(candidates.releaseCandidateRun).toHaveBeenCalledWith("run-candidate");
    expect(jobs.completeJob).not.toHaveBeenCalled();
  });

  it("records the reason on the last attempt instead of retrying", async () => {
    const { handle, candidates, jobs } = setup({ probe: probe({ currentRunId: "run-regular" }) });
    await handle(job({ attempts: 10 }));
    expect(recorded(candidates)).toEqual(["PROBE_BUSY"]);
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });
});
