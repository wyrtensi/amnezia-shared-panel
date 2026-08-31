export type Wait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export const abortableWait: Wait = (milliseconds, signal) =>
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

export type PeriodicTaskOptions = {
  task: () => Promise<void>;
  intervalMs: number;
  signal: AbortSignal;
  wait?: Wait;
  onError?: (error: unknown) => void;
};

export const runPeriodicTask = async ({
  task,
  intervalMs,
  signal,
  wait = abortableWait,
  onError = () => undefined,
}: PeriodicTaskOptions): Promise<void> => {
  while (!signal.aborted) {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    if (!signal.aborted) await wait(intervalMs, signal);
  }
};
