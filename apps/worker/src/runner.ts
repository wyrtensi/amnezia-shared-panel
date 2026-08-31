import type { OutboxJob, WorkerRepository } from "./repository.js";

export type WorkerRunnerOptions = {
  repository: WorkerRepository;
  processJob: (job: OutboxJob) => Promise<void>;
  signal: AbortSignal;
  idleDelayMs?: number;
  maxAttempts?: number;
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

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
      await delay(idleDelayMs, signal);
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
