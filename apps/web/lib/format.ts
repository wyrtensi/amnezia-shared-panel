import type { Lang } from "@/lib/i18n/messages";

const BYTE_UNITS: Record<Lang, string[]> = {
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"],
  en: ["B", "KB", "MB", "GB", "TB", "PB"],
};
const LOCALES: Record<Lang, string> = { ru: "ru-RU", en: "en-US" };
const NEVER: Record<Lang, string> = { ru: "Никогда", en: "Never" };

/** A byte count split into its rounded amount and its unit suffix. */
export type ByteParts = { value: string; unit: string };

/** A traffic pair parsed into exact byte counters. */
export type TrafficTotals = { received: bigint; sent: bigint; total: bigint };

type RawTraffic = { receivedBytes: string; sentBytes: string };

/**
 * Format a byte count (given as a numeric string or bigint) into a separate
 * amount and unit, so the UI can style the number and its unit differently.
 * Returns null when the input is not a finite number.
 */
export function formatBytesParts(
  raw: string | bigint,
  lang: Lang = "ru",
): ByteParts | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const units = BYTE_UNITS[lang];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return { value: amount.toFixed(unit > 1 ? 1 : 0), unit: units[unit] ?? "" };
}

/**
 * Exact byte count with grouped digits, used for `title` tooltips where the
 * rounded readout is not precise enough.
 */
export function formatExactBytes(
  raw: string | bigint,
  lang: Lang = "ru",
): string {
  let exact: bigint;
  try {
    exact = typeof raw === "bigint" ? raw : BigInt(raw);
  } catch {
    return "—";
  }
  return `${exact.toLocaleString(LOCALES[lang])} ${BYTE_UNITS[lang][0] ?? ""}`;
}

/**
 * Parse a traffic pair into exact received / sent / total counters. Returns
 * null when the pair is missing or malformed, so callers can tell "no data"
 * apart from "no traffic yet" (`total === 0n`).
 */
export function parseTraffic(
  traffic?: RawTraffic | null,
): TrafficTotals | null {
  if (!traffic) return null;
  try {
    const received = BigInt(traffic.receivedBytes);
    const sent = BigInt(traffic.sentBytes);
    return { received, sent, total: received + sent };
  } catch {
    return null;
  }
}

/**
 * Sum a key's received and sent counters. Returns null when the pair is
 * missing or malformed.
 */
export function trafficTotal(traffic?: RawTraffic | null): bigint | null {
  return parseTraffic(traffic)?.total ?? null;
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
