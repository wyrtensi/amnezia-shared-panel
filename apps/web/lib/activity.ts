/**
 * Shared "last seen / inactivity" helpers.
 *
 * A user's activity is derived from their keys' `lastUsedAt` telemetry — the
 * most recently used key is the user's last sign of life. A user with no keys,
 * or whose keys have never reported traffic, has no last-seen timestamp.
 */

import type { Lang } from "@/lib/i18n/messages";

export const INACTIVE_DAYS = 30;

type KeyLike = { lastUsedAt: string | null };

/** Most recent `lastUsedAt` across a user's keys, as epoch ms, or null. */
export function lastSeenFromKeys(keys: KeyLike[]): number | null {
  let max: number | null = null;
  for (const key of keys) {
    if (!key.lastUsedAt) continue;
    const time = new Date(key.lastUsedAt).getTime();
    if (!Number.isNaN(time) && (max === null || time > max)) max = time;
  }
  return max;
}

/** True when the last-seen timestamp is missing or older than `days`. */
export function isInactive(
  lastSeen: number | null,
  now: number,
  days: number = INACTIVE_DAYS,
): boolean {
  if (lastSeen === null) return true;
  return now - lastSeen > days * 24 * 60 * 60 * 1000;
}

/** Compact "X days ago" / "Never" label for a last-seen time, localized. */
export function formatLastSeen(
  lastSeen: number | null,
  now: number,
  lang: Lang = "ru",
): string {
  const en = lang === "en";
  if (lastSeen === null) return en ? "Never" : "Никогда";
  const diff = Math.max(0, now - lastSeen);
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(diff / day);
  if (days === 0) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    if (hours === 0) return en ? "Just now" : "Только что";
    return en ? `${hours}h ago` : `${hours} ч назад`;
  }
  if (days === 1) return en ? "Yesterday" : "Вчера";
  if (days < 30) return en ? `${days}d ago` : `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return en ? `${months}mo ago` : `${months} мес назад`;
  const years = Math.floor(months / 12);
  return en ? `${years}y ago` : `${years} г назад`;
}

/**
 * ---------------------------------------------------------------------------
 * Staleness, judged per key.
 * ---------------------------------------------------------------------------
 *
 * `lastSeenFromKeys` above collapses a user to their single most recent key,
 * which answers "has this person disappeared" and nothing else: someone with
 * one phone they use daily and five laptop keys nobody has touched since spring
 * reads as fully active, and the five dead peers stay invisible.
 *
 * The functions below ask the question one key at a time. The input is the
 * key's own last handshake (`lastUsedAt`, written by the worker's telemetry
 * from `peer_current.latest_handshake_at` — there is no second source), and
 * they deliberately distinguish two things a single "no handshake in 30 days"
 * rule would merge:
 *
 *  - a key that HAS connected, last time more than `days` ago — dead weight;
 *  - a key that has NEVER connected. That is only dead weight once the key is
 *    itself older than `days`. A key handed out yesterday has no handshake for
 *    the same reason a key handed out never does, and flagging it would put
 *    every freshly provisioned key on the cleanup list.
 *
 * Only keys that actually hold a peer on a node are judged at all. `revoking`
 * and `revoked` are already gone or going, `failed` never came into existence
 * (docs/KEY-STATES.md), and `provisioning` has not finished being made — none
 * of them is something to clean up, and counting them would inflate the number
 * an operator acts on.
 */

/** Key states that hold a peer on a node. Staleness is only asked about these. */
export const PEER_HOLDING_KEY_STATES = ["active", "disabled"] as const;

/**
 * What one key's handshake history says about it.
 *
 * `live`   — handshaked within the window.
 * `fresh`  — never handshaked, but the key itself is younger than the window.
 * `idle`   — handshaked, last time longer ago than the window. **Stale.**
 * `never`  — never handshaked and older than the window. **Stale.**
 * `other`  — a state that holds no peer, so the question does not apply.
 */
export type KeyActivity = "live" | "fresh" | "idle" | "never" | "other";

export type ActivityKeyLike = {
  state: string;
  lastUsedAt: string | null;
  createdAt: string;
};

/** Epoch ms of an ISO timestamp, or null when it is absent or unparseable. */
function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Classify one key. `days` is the same window `isInactive` uses, and so is the
 * boundary: "older than `days`" is strict, so a key whose last handshake is
 * exactly `days` old is still `live`.
 */
export function classifyKeyActivity(
  key: ActivityKeyLike,
  now: number,
  days: number = INACTIVE_DAYS,
): KeyActivity {
  if (!(PEER_HOLDING_KEY_STATES as readonly string[]).includes(key.state)) {
    return "other";
  }
  const window = days * 24 * 60 * 60 * 1000;
  const lastUsed = epoch(key.lastUsedAt);
  if (lastUsed !== null) return now - lastUsed > window ? "idle" : "live";
  const created = epoch(key.createdAt);
  // A key with no readable creation date cannot be shown to be old, and the
  // cleanup must never act on a guess, so it counts as fresh.
  if (created === null) return "fresh";
  return now - created > window ? "never" : "fresh";
}

/** The two verdicts the cleanup acts on. */
export function isStaleActivity(activity: KeyActivity): boolean {
  return activity === "idle" || activity === "never";
}

/**
 * When a stale key went stale, as epoch ms: its last handshake, or — for one
 * that never connected — when it was created. Null for anything not stale.
 * This is the value the lists sort on, so the worst offender is at the top
 * whichever kind of stale it is.
 */
export function staleSince(
  key: ActivityKeyLike,
  now: number,
  days: number = INACTIVE_DAYS,
): number | null {
  const activity = classifyKeyActivity(key, now, days);
  if (activity === "idle") return epoch(key.lastUsedAt);
  if (activity === "never") return epoch(key.createdAt);
  return null;
}

/** The keys a cleanup would act on, worst (longest stale) first. */
export function staleKeys<T extends ActivityKeyLike>(
  keys: readonly T[],
  now: number,
  days: number = INACTIVE_DAYS,
): T[] {
  return keys
    .filter((key) => isStaleActivity(classifyKeyActivity(key, now, days)))
    .sort(
      (a, b) =>
        (staleSince(a, now, days) ?? 0) - (staleSince(b, now, days) ?? 0),
    );
}

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
export function summarizeStaleKeys(
  keys: readonly ActivityKeyLike[],
  now: number,
  days: number = INACTIVE_DAYS,
): StaleKeySummary {
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
}
