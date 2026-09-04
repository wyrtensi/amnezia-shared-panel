/**
 * Turning command-line arguments into a service check, and a check into a
 * table row.
 *
 * The parsing lives here rather than inline in `main.ts` so it can be tested
 * without a server: an assertion typed wrong on the command line has to be
 * refused with a message that names the mistake, not sent to the API to come
 * back as a schema error the operator has to decode.
 */

export type CheckAssertionInput = Record<string, unknown>;

/** Everything the CLI accepts, and how each one turns into an assertion. */
const ASSERTION_PARSERS: Record<
  string,
  { usage: string; parse: (value: string) => CheckAssertionInput }
> = {
  "status-in": {
    usage: "--status-in=200,204",
    parse: (value) => ({
      type: "statusIn",
      statuses: value.split(",").map((part) => Number(part.trim())),
    }),
  },
  contains: {
    usage: "--contains=<text>",
    parse: (value) => ({ type: "bodyContains", value }),
  },
  omits: {
    usage: "--omits=<text>",
    parse: (value) => ({ type: "bodyOmits", value }),
  },
  "contains-all": {
    usage: "--contains-all=<a>,<b>",
    parse: (value) => ({
      type: "bodyContainsAll",
      values: value.split(",").map((part) => part.trim()),
    }),
  },
  "contains-any": {
    usage: "--contains-any=<a>,<b>",
    parse: (value) => ({
      type: "bodyContainsAny",
      values: value.split(",").map((part) => part.trim()),
    }),
  },
  "contains-at-least": {
    usage: "--contains-at-least=<count>:<text>",
    parse: (value) => {
      const separator = value.indexOf(":");
      if (separator < 1) {
        throw new Error(
          "--contains-at-least needs <count>:<text>, for example --contains-at-least=10:conversation-container",
        );
      }
      return {
        type: "bodyOccurrencesAtLeast",
        count: Number(value.slice(0, separator)),
        value: value.slice(separator + 1),
      };
    },
  },
  "bytes-at-least": {
    usage: "--bytes-at-least=<n>",
    parse: (value) => ({ type: "bodyBytesAtLeast", count: Number(value) }),
  },
  "final-url-contains": {
    usage: "--final-url-contains=<text>",
    parse: (value) => ({ type: "finalUrlContains", value }),
  },
  "final-url-omits": {
    usage: "--final-url-omits=<text>",
    parse: (value) => ({ type: "finalUrlOmits", value }),
  },
  "header-contains": {
    usage: "--header-contains=<name>:<text>",
    parse: (value) => {
      const separator = value.indexOf(":");
      if (separator < 1) {
        throw new Error(
          "--header-contains needs <name>:<text>, for example --header-contains=content-type:text/html",
        );
      }
      return {
        type: "headerContains",
        name: value.slice(0, separator),
        value: value.slice(separator + 1),
      };
    },
  },
};

export const ASSERTION_FLAGS = Object.keys(ASSERTION_PARSERS);

/** One line per flag, for the usage text. Derived, so it cannot drift. */
export const assertionUsageLines = (): string[] =>
  ASSERTION_FLAGS.map((flag) => `    ${ASSERTION_PARSERS[flag]!.usage}`);

/**
 * Every assertion the arguments ask for, in the order they were given.
 *
 * A flag may repeat: three `--omits` are three assertions, all of which must
 * hold. That is why this reads the whole argument list rather than using the
 * single-value flag helper.
 */
export const parseAssertions = (args: string[]): CheckAssertionInput[] => {
  const assertions: CheckAssertionInput[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals < 0) continue;
    const flag = arg.slice(2, equals);
    const parser = ASSERTION_PARSERS[flag];
    if (!parser) continue;
    assertions.push(parser.parse(arg.slice(equals + 1)));
  }
  return assertions;
};

export type ParsedProbe = {
  kind: "http";
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
};

export const parseProbe = (
  url: string | undefined,
  method: string | undefined,
  timeoutMs: string | undefined,
): ParsedProbe => {
  if (!url) throw new Error("--url is required");
  const upper = (method ?? "GET").toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") {
    throw new Error("--method must be GET or HEAD");
  }
  return {
    kind: "http",
    url,
    method: upper,
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
  };
};

/** A check's assertions as one short human-readable cell. */
export const describeAssertions = (
  assertions: ReadonlyArray<Record<string, unknown>>,
): string =>
  assertions
    .map((assertion) => {
      // Every field is read as `unknown` on purpose: this table can hold a rule
      // written by a newer panel, and a cast would turn "print it roughly" into
      // "[object Object]" or a throw over one table row.
      const text = (value: unknown): string =>
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : "";
      const type = text(assertion.type) || "?";
      if (type === "statusIn") {
        return `status in ${(assertion.statuses as number[] | undefined)?.join("/") ?? "?"}`;
      }
      if (type === "bodyOccurrencesAtLeast") {
        return `${text(assertion.value)} x${text(assertion.count)}`;
      }
      if (type === "bodyBytesAtLeast") return `>=${text(assertion.count)}B`;
      if (type === "headerContains") {
        return `${text(assertion.name)}: ${text(assertion.value)}`;
      }
      const marker = Array.isArray(assertion.values)
        ? assertion.values.map(text).join(",")
        : text(assertion.value);
      return `${type} ${marker}`.trim();
    })
    .join("; ");

/**
 * The one-word verdict for a node, from its stored result.
 *
 * `error` is deliberately NOT collapsed into "unavailable": it means the node
 * could not perform the check, so nothing is known about the service. An
 * operator reading a table over SSH needs that distinction as much as a user
 * reading a chip does.
 */
export const resultLabel = (result: {
  status: string;
  detail?: string | null;
}): string => (result.detail ? `${result.status} (${result.detail})` : result.status);
