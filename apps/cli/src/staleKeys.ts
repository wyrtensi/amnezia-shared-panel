/**
 * Structural copy of the staleness rule in `apps/web/lib/activity.ts`.
 *
 * The CLI declares no runtime dependencies on purpose, so it re-states small
 * facts rather than importing a workspace package — the same trade-off
 * `deviceProfiles.ts` makes for `deviceSupportsRouteProfiles` and `args.ts` for
 * `DEVICE_TYPES`. Both copies are pinned by their own test; if the rule changes,
 * this one and its test change with it.
 *
 * The rule, restated:
 *
 *  - staleness is a property of a KEY, read from that key's own last handshake
 *    (`lastUsedAt`, written by the worker from `peer_current.latest_handshake_at`
 *    — there is no second source), never from its owner's most recent key. A
 *    user with one live phone and five abandoned laptops is fully active by the
 *    owner-level reading, and the five dead peers stay invisible;
 *  - a key that has connected, last time longer ago than the window, is stale;
 *  - a key that has NEVER connected is stale only once the key itself is older
 *    than the window. A key issued yesterday has no handshake for the same
 *    reason an abandoned one does, and treating the two alike would put every
 *    freshly provisioned key on the cleanup list;
 *  - only keys that hold a peer on a node are judged at all. `revoking` and
 *    `revoked` are gone or going, `failed` never came into existence, and
 *    `provisioning` has not finished being made (docs/KEY-STATES.md).
 */

/** The window the panel uses, mirroring `INACTIVE_DAYS` in the web app. */
export const STALE_DAYS = 30;

/** Key states that hold a peer on a node. */
export const PEER_HOLDING_KEY_STATES = ["active", "disabled"] as const;

export type KeyActivity = "live" | "fresh" | "idle" | "never" | "other";

export type StaleKeyLike = {
  state: string;
  lastUsedAt?: string | null;
  createdAt?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms of an ISO timestamp, or null when absent or unparseable. */
const epoch = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * Classify one key. The boundary is strict: a key whose last handshake is
 * exactly `days` old is still `live`.
 */
export const classifyKeyActivity = (
  key: StaleKeyLike,
  now: number,
  days: number = STALE_DAYS,
): KeyActivity => {
  if (!(PEER_HOLDING_KEY_STATES as readonly string[]).includes(key.state)) {
    return "other";
  }
  const window = days * DAY_MS;
  const lastUsed = epoch(key.lastUsedAt);
  if (lastUsed !== null) return now - lastUsed > window ? "idle" : "live";
  const created = epoch(key.createdAt);
  // A key with no readable creation date cannot be shown to be old, and the
  // cleanup must never act on a guess, so it counts as fresh.
  if (created === null) return "fresh";
  return now - created > window ? "never" : "fresh";
};

/** The two verdicts the cleanup acts on. */
export const isStaleActivity = (activity: KeyActivity): boolean =>
  activity === "idle" || activity === "never";

/**
 * When a stale key went stale, as epoch ms: its last handshake, or — for one
 * that never connected — when it was created. Null for anything not stale.
 */
export const staleSince = (
  key: StaleKeyLike,
  now: number,
  days: number = STALE_DAYS,
): number | null => {
  const activity = classifyKeyActivity(key, now, days);
  if (activity === "idle") return epoch(key.lastUsedAt);
  if (activity === "never") return epoch(key.createdAt);
  return null;
};

/** The keys a cleanup would act on, longest stale first. */
export const staleKeys = <T extends StaleKeyLike>(
  keys: readonly T[],
  now: number,
  days: number = STALE_DAYS,
): T[] =>
  keys
    .filter((key) => isStaleActivity(classifyKeyActivity(key, now, days)))
    .sort(
      (a, b) =>
        (staleSince(a, now, days) ?? 0) - (staleSince(b, now, days) ?? 0),
    );

export type StaleKeySummary = {
  /** Keys holding a peer — the denominator every other count is out of. */
  held: number;
  live: number;
  fresh: number;
  idle: number;
  never: number;
  /** `idle + never`: what a cleanup would revoke. */
  stale: number;
  /** Oldest `staleSince` across the stale keys; null when there are none. */
  oldestStaleSince: number | null;
};

/** Per-owner tally of the classification above. */
export const summarizeStaleKeys = (
  keys: readonly StaleKeyLike[],
  now: number,
  days: number = STALE_DAYS,
): StaleKeySummary => {
  const summary: StaleKeySummary = {
    held: 0,
    live: 0,
    fresh: 0,
    idle: 0,
    never: 0,
    stale: 0,
    oldestStaleSince: null,
  };
  for (const key of keys) {
    const activity = classifyKeyActivity(key, now, days);
    if (activity === "other") continue;
    summary.held += 1;
    summary[activity] += 1;
    if (!isStaleActivity(activity)) continue;
    summary.stale += 1;
    const since = staleSince(key, now, days);
    if (
      since !== null &&
      (summary.oldestStaleSince === null || since < summary.oldestStaleSince)
    ) {
      summary.oldestStaleSince = since;
    }
  }
  return summary;
};

/**
 * Whole days between `since` and `now`, for a table cell. A dash when there is
 * no timestamp — never a zero, which would read as "today".
 */
export const formatDaysAgo = (since: number | null, now: number): string =>
  since === null ? "—" : `${Math.max(0, Math.floor((now - since) / DAY_MS))}d`;

/**
 * `--days=` / `--stale-days=`. Rejects anything that is not a positive integer
 * rather than silently falling back: a typo that quietly restored the default
 * would report a different set of keys than the operator asked about, right
 * before they revoke them.
 */
export const parseStaleDays = (
  value: string | undefined,
  fallback: number = STALE_DAYS,
): number => {
  if (value === undefined) return fallback;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`--days must be an integer 1..3650; got "${value}"`);
  }
  return days;
};
