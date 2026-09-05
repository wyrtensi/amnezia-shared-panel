import type { OutboxJob, WorkerRepository } from "./repository.js";
// One helper for both loops, so the "already aborted" case is fixed in one
// place: this loop has the same window, around `claimJob()` rather than around
// a period lookup, and had its own copy of the wait to get it wrong in.
import { abortableWait } from "./scheduler.js";

export type WorkerRunnerOptions = {
  repository: WorkerRepository;
  processJob: (job: OutboxJob) => Promise<void>;
  signal: AbortSignal;
  idleDelayMs?: number;
  maxAttempts?: number;
};

export const runWorker = async ({
  repository,
  processJob,
  signal,
  idleDelayMs = 1_000,
  maxAttempts = 10,
}: WorkerRunnerOptions): Promise<void> => {
  while (!signal.aborted) {
    const job = await repository.claimJob();
    if (!job) {
      await abortableWait(idleDelayMs, signal);
      continue;
    }
    try {
      await processJob(job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown worker error";
      if (job.attempts >= maxAttempts) {
        await repository.failJob(job.id, reason);
      } else {
        await repository.retryJob(job.id, reason);
      }
    }
  }
};
