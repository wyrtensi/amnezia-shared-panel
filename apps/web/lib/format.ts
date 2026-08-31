import type { Lang } from "@/lib/i18n/messages";

const BYTE_UNITS: Record<Lang, string[]> = {
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"],
  en: ["B", "KB", "MB", "GB", "TB", "PB"],
};
const LOCALES: Record<Lang, string> = { ru: "ru-RU", en: "en-US" };
const NEVER: Record<Lang, string> = { ru: "Никогда", en: "Never" };

/**
 * Format a byte count (given as a numeric string or bigint) for display.
 */
export function formatBytes(raw: string | bigint, lang: Lang = "ru"): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  const units = BYTE_UNITS[lang];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Sum a key's received and sent counters, returning a formatted total.
 */
export function formatTraffic(
  traffic?: { receivedBytes: string; sentBytes: string } | null,
  lang: Lang = "ru",
): string {
  if (!traffic) return "—";
  try {
    return formatBytes(
      (BigInt(traffic.receivedBytes) + BigInt(traffic.sentBytes)).toString(),
      lang,
    );
  } catch {
    return "—";
  }
}

/**
 * Split a traffic pair into formatted received / sent strings (for the "↓ … ↑ …"
 * display). Returns null when the pair is missing or malformed.
 */
export function formatTrafficParts(
  traffic?: { receivedBytes: string; sentBytes: string } | null,
  lang: Lang = "ru",
): { received: string; sent: string } | null {
  if (!traffic) return null;
  try {
    return {
      received: formatBytes(traffic.receivedBytes, lang),
      sent: formatBytes(traffic.sentBytes, lang),
    };
  } catch {
    return null;
  }
}

/**
 * Format an ISO timestamp as a short localized date.
 */
export function formatDate(iso?: string | null, lang: Lang = "ru"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(LOCALES[lang]);
}

/**
 * Format an ISO timestamp as a localized date and time.
 */
export function formatDateTime(iso?: string | null, lang: Lang = "ru"): string {
  if (!iso) return NEVER[lang];
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? NEVER[lang]
    : date.toLocaleString(LOCALES[lang]);
}
