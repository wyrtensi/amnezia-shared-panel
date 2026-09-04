/**
 * The assertion registry.
 *
 * One entry per rule. Adding a rule is a function here plus a variant in
 * `checkAssertionSchema` on the panel side - not a column, not a migration, and
 * not a field threaded through four layers.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **An unknown rule is never satisfied.** A node that predates an assertion
 *    type must report `error` for that check, never `ok`. A silent pass here is
 *    a green light that means nothing, which is worse than no light at all.
 * 2. **Every evaluator is linear in the size of the body.** These run inside
 *    the agent on a host with one vCPU that is also carrying the tunnels, so a
 *    rule that can backtrack - a regular expression from an admin-supplied
 *    string - would block the event loop and take the node's API with it. If
 *    one is ever added, it needs a worker thread, and that decision belongs
 *    here rather than inside whoever adds it.
 */

/** What a probe produced, in the shape every evaluator reads. */
export interface ProbeOutcome {
  /** HTTP status, or null for a probe kind that has none. */
  status: number | null;
  /** Where the request finally landed after redirects. */
  finalUrl: string | null;
  /** Lower-cased header names to values. */
  headers: Record<string, string>;
  /** As much of the body as the probe was willing to read. */
  body: string;
  /** Bytes actually read, which is never more than the probe's cap. */
  bodyBytes: number;
}

/** An evaluator returns why it failed, or null when it passed. */
export type AssertionEvaluator = (
  outcome: ProbeOutcome,
  assertion: Record<string, unknown>,
) => string | null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;

/**
 * Occurrences of `needle` in `haystack`. `indexOf` in a loop rather than
 * `split().length - 1`, which allocates the whole array, and rather than a
 * global regular expression, which would have to escape the needle.
 */
export const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/** Quote a marker for a detail line without letting it spill over lines. */
const quote = (value: string): string =>
  JSON.stringify(value.replace(/[\r\n\t]+/g, " ")).slice(0, 120);

export const ASSERTION_EVALUATORS: Record<string, AssertionEvaluator> = {
  statusIn: (outcome, assertion) => {
    const statuses = Array.isArray(assertion.statuses)
      ? assertion.statuses.filter((value): value is number =>
          typeof value === "number",
        )
      : [];
    if (outcome.status !== null && statuses.includes(outcome.status)) {
      return null;
    }
    return `status ${outcome.status ?? "none"} is not one of ${statuses.join(", ")}`;
  },

  bodyContains: (outcome, assertion) => {
    const value = asString(assertion.value);
    return outcome.body.includes(value)
      ? null
      : `body does not contain ${quote(value)}`;
  },

  bodyOmits: (outcome, assertion) => {
    const value = asString(assertion.value);
    return outcome.body.includes(value)
      ? `body contains ${quote(value)}`
      : null;
  },

  bodyContainsAll: (outcome, assertion) => {
    const missing = asStrings(assertion.values).filter(
      (value) => !outcome.body.includes(value),
    );
    return missing.length === 0
      ? null
      : `body does not contain ${missing.map(quote).join(", ")}`;
  },

  bodyContainsAny: (outcome, assertion) => {
    const values = asStrings(assertion.values);
    return values.some((value) => outcome.body.includes(value))
      ? null
      : `body contains none of ${values.map(quote).join(", ")}`;
  },

  bodyOccurrencesAtLeast: (outcome, assertion) => {
    const value = asString(assertion.value);
    const wanted = asNumber(assertion.count);
    const found = countOccurrences(outcome.body, value);
    return found >= wanted
      ? null
      : `body contains ${quote(value)} ${found} times, wanted at least ${wanted}`;
  },

  bodyBytesAtLeast: (outcome, assertion) => {
    const wanted = asNumber(assertion.count);
    return outcome.bodyBytes >= wanted
      ? null
      : `body is ${outcome.bodyBytes} bytes, wanted at least ${wanted}`;
  },

  finalUrlContains: (outcome, assertion) => {
    const value = asString(assertion.value);
    return (outcome.finalUrl ?? "").includes(value)
      ? null
      : `final URL does not contain ${quote(value)}`;
  },

  finalUrlOmits: (outcome, assertion) => {
    const value = asString(assertion.value);
    return (outcome.finalUrl ?? "").includes(value)
      ? `final URL contains ${quote(value)}`
      : null;
  },

  headerContains: (outcome, assertion) => {
    const name = asString(assertion.name).toLowerCase();
    const value = asString(assertion.value);
    const actual = outcome.headers[name];
    if (actual === undefined) return `header ${name} is absent`;
    return actual.includes(value)
      ? null
      : `header ${name} does not contain ${quote(value)}`;
  },
};

/** What this agent advertises, and the only list the runner will evaluate. */
export const SUPPORTED_ASSERTION_TYPES = Object.keys(
  ASSERTION_EVALUATORS,
).sort();

export class UnsupportedAssertionError extends Error {
  constructor(readonly assertionType: string) {
    super(`unsupported assertion type: ${assertionType}`);
    this.name = "UnsupportedAssertionError";
  }
}

/**
 * Evaluate every assertion against one outcome. Returns the FIRST failure, or
 * null when they all pass; throws for a type this agent does not implement, so
 * the caller can report `error` rather than a verdict it has not earned.
 */
export const evaluateAssertions = (
  outcome: ProbeOutcome,
  assertions: ReadonlyArray<Record<string, unknown>>,
): string | null => {
  for (const assertion of assertions) {
    const type = asString(assertion.type);
    const evaluate = ASSERTION_EVALUATORS[type];
    if (!evaluate) throw new UnsupportedAssertionError(type || "(missing)");
    const failure = evaluate(outcome, assertion);
    if (failure) return failure;
  }
  return null;
};
