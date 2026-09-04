import type { NodeCheckRequest, NodeCheckResult } from "./nodeAgent.js";

/** A check as stored, in the shape the scheduler needs. */
export type NodeServiceCheck = {
  id: string;
  name: string;
  probe: unknown;
  assertions: unknown[];
  intervalSec: number;
  enabled: boolean;
  /** The "run now" marker, not a schedule. See `selectDueChecks`. */
  nextDueAt: Date | null;
};

export type ServiceCheckStatus = "ok" | "failed" | "error";

/** What THIS node last recorded for a check. */
export type PreviousResult = {
  status: ServiceCheckStatus;
  checkedAt: Date;
  failingSince: Date | null;
};

export type ServiceCheckResultRow = {
  nodeId: string;
  checkId: string;
  status: ServiceCheckStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string | null;
  finalUrl: string | null;
  checkedAt: Date;
  failingSince: Date | null;
};

/** An unperformed check is retried this soon, not after the full period. */
const ERROR_RETRY_MS = 5 * 60 * 1_000;
/** ...but only while the error is fresh, so broken egress settles down. */
const ERROR_RETRY_WINDOW_MS = 60 * 60 * 1_000;

/** The widths of the columns these rows are written into. */
const MAX_DETAIL = 300;
const MAX_FINAL_URL = 500;

const nextRunMs = (
  previous: PreviousResult,
  intervalSec: number,
  now: Date,
): number => {
  // `error` means nothing was measured, so waiting the full period to find out
  // whether a two-second DNS blip is over would turn it into half a day of
  // "unknown". `failed` is a real measurement and holds the full period.
  const erroringRecently =
    previous.status === "error" &&
    previous.failingSince !== null &&
    now.getTime() - previous.failingSince.getTime() < ERROR_RETRY_WINDOW_MS;
  return (
    previous.checkedAt.getTime() +
    (erroringRecently ? ERROR_RETRY_MS : intervalSec * 1_000)
  );
};

/**
 * Which of a node's checks are due right now.
 *
 * The schedule is derived per (node, check) from the stored result rather than
 * from a column, which is why there is no `advanceServiceChecks`: the results
 * ARE the schedule. Three consequences worth keeping:
 *
 * - a node added five minutes ago runs every check on its next tick, because it
 *   has no previous result — rather than showing blank chips for twelve hours;
 * - an `error` is retried in five minutes, bounded to an hour of continuous
 *   errors so a node with broken egress settles at its normal period;
 * - `nextDueAt` is the admin's "run now" and nothing else: it fires only when it
 *   is NEWER than this node's last result, so pressing it once does not make
 *   every check due forever.
 */
export const selectDueChecks = (
  checks: readonly NodeServiceCheck[],
  previousByCheckId: ReadonlyMap<string, PreviousResult>,
  now: Date,
): NodeServiceCheck[] =>
  checks.filter((check) => {
    if (!check.enabled) return false;
    const previous = previousByCheckId.get(check.id);
    if (!previous) return true;
    if (nextRunMs(previous, check.intervalSec, now) <= now.getTime()) return true;
    return (
      check.nextDueAt !== null &&
      check.nextDueAt.getTime() <= now.getTime() &&
      previous.checkedAt.getTime() < check.nextDueAt.getTime()
    );
  });

/** The stored definition, as the node-agent's wire format. */
export const toCheckRequests = (
  checks: readonly NodeServiceCheck[],
): NodeCheckRequest[] =>
  checks.map((check) => ({
    id: check.id,
    probe: check.probe,
    assertions: check.assertions,
  }));

const truncate = (value: string | null | undefined, max: number): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

/**
 * Turn a node's replies into rows, carrying the outage window forward.
 *
 * `failingSince` is the answer to "since when", and an operator needs "broken
 * since 08:00", not "broken since the last tick". It opens on the first
 * non-`ok`, survives a change between `failed` and `error` — a node that cannot
 * reach the service at all is still inside the same outage — and clears only on
 * a recovery.
 */
export const toResultRows = (
  nodeId: string,
  results: readonly NodeCheckResult[],
  previousByCheckId: ReadonlyMap<string, PreviousResult>,
  now: Date,
): ServiceCheckResultRow[] =>
  results.map((result) => {
    const previous = previousByCheckId.get(result.id);
    const wasBroken = previous !== undefined && previous.status !== "ok";
    return {
      nodeId,
      checkId: result.id,
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      latencyMs: result.latencyMs,
      detail: truncate(result.detail, MAX_DETAIL),
      finalUrl: truncate(result.finalUrl, MAX_FINAL_URL),
      checkedAt: now,
      failingSince:
        result.status === "ok"
          ? null
          : wasBroken
            ? (previous.failingSince ?? previous.checkedAt)
            : now,
    };
  });
