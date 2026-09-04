import { evaluateAssertions, UnsupportedAssertionError } from "./assertions";
import {
  ProbeRefusedError,
  runProbe,
  UnsupportedProbeError,
} from "./probes";

export interface CheckRequest {
  id: string;
  probe: Record<string, unknown>;
  assertions: Array<Record<string, unknown>>;
  timeoutMs?: number;
}

export type CheckStatus = "ok" | "failed" | "error";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  httpStatus: number | null;
  latencyMs: number;
  finalUrl: string | null;
  detail: string | null;
}

/** How many checks run at once. Small on purpose: one vCPU, shared with tunnels. */
const DEFAULT_CONCURRENCY = 3;

const MAX_DETAIL = 300;

const cleanDetail = (value: string): string =>
  value.replace(/[\r\n\t]+/g, " ").slice(0, MAX_DETAIL);

/**
 * Run one check and turn it into a verdict.
 *
 * The three statuses are not interchangeable and the distinction is the whole
 * value of this endpoint:
 *
 * - `ok`     - the probe ran and every assertion held.
 * - `failed` - the probe ran and an assertion did not. Something is true of the
 *              service, from this node.
 * - `error`  - the probe could not run, or this agent does not implement part
 *              of the check. NOTHING is known about the service. It must never
 *              be reported as `failed`, because the panel collapses `failed` to
 *              "unavailable" for users and `error` to "unknown", and telling a
 *              user a service is blocked when the node could not look is worse
 *              than telling them nothing.
 */
export const runCheck = async (check: CheckRequest): Promise<CheckResult> => {
  const startedAt = Date.now();
  const base = { id: check.id, httpStatus: null, finalUrl: null } as const;
  try {
    const outcome = await runProbe(check.probe, check.timeoutMs ?? 10_000);
    const failure = evaluateAssertions(outcome, check.assertions);
    return {
      id: check.id,
      status: failure ? "failed" : "ok",
      httpStatus: outcome.status,
      latencyMs: Date.now() - startedAt,
      finalUrl: outcome.finalUrl,
      detail: failure ? cleanDetail(failure) : null,
    };
  } catch (error) {
    // An unimplemented rule is an `error`, deliberately and loudly. This node
    // is older than the check; that is a fact about the node, not about the
    // service, and the message names the type so an admin can see which node
    // needs an agent update rather than guessing.
    if (
      error instanceof UnsupportedAssertionError ||
      error instanceof UnsupportedProbeError
    ) {
      return {
        ...base,
        status: "error",
        latencyMs: Date.now() - startedAt,
        detail: cleanDetail(`${error.message} (node-agent cannot run this check)`),
      };
    }
    if (error instanceof ProbeRefusedError) {
      return {
        ...base,
        status: "error",
        latencyMs: Date.now() - startedAt,
        detail: cleanDetail(`refused: ${error.message}`),
      };
    }
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    return {
      ...base,
      status: "error",
      latencyMs: Date.now() - startedAt,
      detail: cleanDetail(message),
    };
  }
};

/** Run a batch with a bounded number in flight, keeping the input order. */
export const runChecks = async (
  checks: readonly CheckRequest[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<CheckResult[]> => {
  const results = new Array<CheckResult>(checks.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, checks.length)) },
    async () => {
      while (next < checks.length) {
        const index = next;
        next += 1;
        results[index] = await runCheck(checks[index] as CheckRequest);
      }
    },
  );
  await Promise.all(lanes);
  return results;
};
