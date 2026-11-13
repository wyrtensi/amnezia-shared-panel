import { describe, expect, it, vi } from "vitest";

import { createBridgeAgentPoll } from "./bridgePoller.js";

const BRIDGE_ID = "6f1d2c1e-7d0f-4a8e-9f0a-3c3d5e8b1a01";

const setup = (target: Awaited<ReturnType<ReturnType<typeof repositoryFor>["loadPollTarget"]>>) => {
  const repository = repositoryFor(target);
  const jobs = { completeJob: vi.fn(() => Promise.resolve()), failJob: vi.fn(() => Promise.resolve()) };
  const fetchImpl = vi.fn(() => Promise.reject(new Error("no network in unit tests")));
  const poll = createBridgeAgentPoll({
    repository,
    jobs,
    jobsEnabled: true,
    managementHosts: ["host.docker.internal"],
    fetchImpl,
    now: () => new Date("2026-11-13T10:00:00.000Z"),
  });
  return { repository, jobs, fetchImpl, poll };
};

const repositoryFor = (
  target: {
    bridgeId: string;
    apiUrl: string;
    apiKey: string | null;
    enrolledAt: Date;
  } | null,
) => ({
  loadPollTarget: vi.fn((_bridgeId: string) => Promise.resolve(target)),
  recordPoll: vi.fn(() => Promise.resolve("written" as const)),
});

const job = (payload: Record<string, unknown>) => ({
  id: "job-1",
  type: "bridge_agent.poll",
  attempts: 1,
  payload,
});

describe("createBridgeAgentPoll", () => {
  it("fails a malformed payload without touching anything", async () => {
    const { repository, jobs, poll } = setup(null);
    await poll(job({ bridgeId: "not-a-uuid" }));
    expect(jobs.failJob).toHaveBeenCalledWith("job-1", expect.stringContaining("malformed"));
    expect(repository.loadPollTarget).not.toHaveBeenCalled();
  });

  it("completes the job of a bridge that is no longer enrolled", async () => {
    const { repository, jobs, fetchImpl, poll } = setup(null);
    await poll(job({ bridgeId: BRIDGE_ID }));
    expect(repository.recordPoll).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });

  it("records an undecryptable credential as down without a request", async () => {
    const enrolledAt = new Date("2026-11-13T09:00:00.000Z");
    const { repository, jobs, fetchImpl, poll } = setup({
      bridgeId: BRIDGE_ID,
      apiUrl: "http://host.docker.internal:7605",
      apiKey: null,
      enrolledAt,
    });
    await poll(job({ bridgeId: BRIDGE_ID }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repository.recordPoll).toHaveBeenCalledWith({
      bridgeId: BRIDGE_ID,
      enrolledAt,
      startedAt: new Date("2026-11-13T10:00:00.000Z"),
      outcome: { kind: "down", errorCode: "AGENT_CREDENTIAL_UNREADABLE" },
    });
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
  });

  it("records an unreachable agent as down and still completes the job", async () => {
    const { repository, jobs, poll } = setup({
      bridgeId: BRIDGE_ID,
      apiUrl: "http://host.docker.internal:7605",
      apiKey: "k".repeat(40),
      enrolledAt: new Date(),
    });
    await poll(job({ bridgeId: BRIDGE_ID }));
    expect(repository.recordPoll).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "down", errorCode: "AGENT_UNREACHABLE" } }),
    );
    expect(jobs.completeJob).toHaveBeenCalledWith("job-1");
    expect(jobs.failJob).not.toHaveBeenCalled();
  });
});
