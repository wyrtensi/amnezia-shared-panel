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
