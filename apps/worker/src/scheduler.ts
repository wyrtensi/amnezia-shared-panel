export type Wait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export const abortableWait: Wait = (milliseconds, signal) =>
  new Promise((resolve) => {
    // Checked BEFORE anything is scheduled. A listener added to a signal that
    // has ALREADY aborted never fires, so subscribing first would leave this
    // promise sleeping out the whole period after a SIGTERM -- up to six hours
    // for the rule fetcher. The window is real: a caller checks `signal.aborted`
    // and then awaits a database round trip for the period before it gets here
    // (see `runPeriodicTask`), and a shutdown landing in between would wait on a
    // loop that is no longer listening, so the pool never closes, docker
    // SIGKILLs the container, and a claimed outbox job is left in `processing`.
    if (signal.aborted) {
      resolve();
      return;
    }
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

/**
 * A fixed period, or a function asked for one before every wait.
 *
 * The function form is what makes a period editable without a restart: the loop
 * re-reads it each cycle instead of closing over a number it was given at boot.
 * It costs nothing structurally -- the loop still runs one task at a time, so
 * the single-executor property every caller relies on is untouched.
 *
 * The latency an admin sees is therefore NOT zero and should never be described
 * as instant: a loop that is already waiting out the old period finishes that
 * wait first. Worst case, a change takes effect one old period later.
 */
export type IntervalSource = number | (() => number | Promise<number>);

/**
 * What a loop waits when its resolver has never yet produced a period -- only
 * reachable when the very first lookup fails. A minute, because the alternative
 * to waiting something is a hot loop hammering whatever the task talks to at
 * the exact moment that thing is already unwell.
 */
export const FAILED_RESOLVE_WAIT_MS = 60_000;

export type PeriodicTaskOptions = {
  task: () => Promise<void>;
  intervalMs: IntervalSource;
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
  // The last period that resolved to a usable number. A resolver that throws,
  // or answers with something that is not a positive finite number, must not be
  // able to turn a background loop into a hot loop or stop it forever -- so the
  // loop keeps waiting whatever it waited last time and says so through
  // onError. Seeded from the fixed form, or from FAILED_RESOLVE_WAIT_MS until
  // the resolver answers for the first time.
  let lastResolved =
    typeof intervalMs === "number" ? intervalMs : FAILED_RESOLVE_WAIT_MS;

  const resolveIntervalMs = async (): Promise<number> => {
    if (typeof intervalMs === "number") return intervalMs;
    try {
      const next = await intervalMs();
      if (!Number.isFinite(next) || next <= 0) {
        onError(new Error(`Ignoring an unusable period: ${String(next)}`));
        return lastResolved;
      }
      lastResolved = next;
      return next;
    } catch (error) {
      onError(error);
      return lastResolved;
    }
  };

  while (!signal.aborted) {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    if (signal.aborted) break;
    await wait(await resolveIntervalMs(), signal);
  }
};
