/** Pure argument helpers, kept out of main.ts so they are unit-testable. */

/** Value of a `--name=value` flag, or undefined. Values may contain `=`. */
export const flagOf = (args: string[], name: string): string | undefined => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : undefined;
};

/** Positional args (everything not starting with `--`). */
export const positionals = (args: string[]): string[] =>
  args.filter((arg) => !arg.startsWith("--"));

/** Split a comma-separated value into a trimmed, non-empty list. */
export const csvList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Parse a node-availability spec for the per-user override:
 *   "all"  -> null  (no restriction: every node)
 *   "none" -> []    (no node available)
 *   "a,b"  -> ["a","b"]
 */
export const parseNodeSpec = (spec: string): string[] | null => {
  if (spec === "all") return null;
  if (spec === "none") return [];
  return csvList(spec);
};

/**
 * Parse a per-node key-limit spec for the per-user override:
 *   ""/"none"/"clear" -> null            (drop every per-node limit)
 *   "<id>:2,<id>:0"   -> { id: 2, id: 0 }
 *
 * Limits must be integers in 0..1000; 0 means "no keys on that node".
 */
export const parseNodeLimits = (
  spec: string,
): Record<string, number> | null => {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "none" || trimmed === "clear") return null;
  const limits: Record<string, number> = {};
  for (const entry of csvList(trimmed)) {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(`Invalid node limit "${entry}" — expected <nodeId>:<n>`);
    }
    const nodeId = entry.slice(0, separator).trim();
    const raw = entry.slice(separator + 1).trim();
    const limit = Number(raw);
    if (!nodeId || raw === "" || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
      throw new Error(
        `Invalid node limit "${entry}" — limit must be an integer 0..1000`,
      );
    }
    limits[nodeId] = limit;
  }
  return limits;
};

/**
 * Shape of `GET /api/admin/update` as far as the rendering below cares. Every
 * field is optional so a host running an older updater (or a run that was
 * refused before it could name an id) still renders.
 */
export type UpdateStatusView = {
  enabled: boolean;
  pending?: { id?: string; requestedAt?: string } | null;
  lastResult?: {
    id?: string;
    ok?: boolean;
    finishedAt?: string;
    /** Written by panel-updater.sh. */
    message?: string;
    /** Alternate spelling accepted so a refusal reason is never dropped. */
    error?: string;
  } | null;
};

/**
 * Human-readable `panel-update --status`. Pure: it prints the timestamps it is
 * handed and never reads a clock, so the output is reproducible under test.
 *
 * The failure line matters most — the host updater can refuse a request and
 * exit without ever running an update, and that outcome is otherwise invisible
 * from the panel and the CLI (there is no TTY on the host).
 */
export const formatUpdateStatus = (status: UpdateStatusView): string => {
  if (!status.enabled) return "update mechanism not configured on this host";
  const lines: string[] = [];
  const pending = status.pending;
  lines.push(
    pending
      ? `pending: ${pending.id ?? "unknown"}${
          pending.requestedAt ? ` (requested ${pending.requestedAt})` : ""
        }`
      : "pending: none",
  );
  const last = status.lastResult;
  if (!last) {
    lines.push("last run: none recorded");
    return lines.join("\n");
  }
  const outcome = last.ok ? "ok" : "FAILED";
  const detail = last.error ?? last.message;
  lines.push(
    `last run: ${outcome} — ${last.id ?? "unknown"}${
      last.finishedAt ? ` at ${last.finishedAt}` : ""
    }${detail ? `: ${detail}` : ""}`,
  );
  return lines.join("\n");
};

/**
 * Device types `--device-type` accepts. A deliberate copy of
 * `deviceTypeSchema.options` in @amnezia/contracts: this CLI ships with no
 * dependencies, so the list is duplicated and each side asserts the same
 * literal array in its own test.
 */
export const DEVICE_TYPES = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
  "unspecified",
] as const;

/**
 * The device types the panel actually offers, in the order the wizard shows
 * them. A copy of `DEVICE_TYPE_ORDER` in @amnezia/contracts, pinned by the same
 * literal on both sides. `unspecified` is deliberately absent: it is storable
 * but never offered.
 */
export const DEVICE_TYPE_ORDER = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
] as const;

/** The `--device-type=…` fragment for a usage string, built from the list. */
export const deviceTypeUsage = (): string =>
  `--device-type=${DEVICE_TYPE_ORDER.join("|")}`;

/**
 * Retired device types and what to use instead. Phrased as advice rather than a
 * mapping: the panel remapped stored rows to "unspecified" because it could not
 * know the platform, but a person running the CLI does know, so the message
 * asks them for it.
 */
export const RETIRED_DEVICE_TYPES: Record<string, string> = {
  iphone: "ios",
  desktop: "windows, macos or linux",
  laptop: "windows, macos or linux",
  phone: "android or ios",
  tablet: "android or ios",
};

/** Validate `--device-type`, naming the replacement for a retired value. */
export const parseDeviceType = (value: string): string => {
  if ((DEVICE_TYPES as readonly string[]).includes(value)) return value;
  const replacement = RETIRED_DEVICE_TYPES[value];
  if (replacement !== undefined) {
    throw new Error(`--device-type="${value}" was retired — use ${replacement}`);
  }
  throw new Error(
    `--device-type expects one of ${DEVICE_TYPES.join(", ")}; got "${value}"`,
  );
};

/**
 * Render a stored device type for a table cell. `unspecified` and a missing
 * value both read as a dash; anything else — including a value retired by a
 * migration this build predates — is printed verbatim rather than hidden.
 */
export const formatDeviceType = (value: string | undefined): string =>
  !value || value === "unspecified" ? "—" : value;
