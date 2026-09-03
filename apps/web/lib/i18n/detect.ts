import type { Lang } from "./messages";

/**
 * Pure language resolution for the i18n provider. No DOM access here: the
 * provider passes in what it read from localStorage and navigator, and this
 * module decides. Keeping it pure is what makes it unit-testable in Node.
 */

// A Record keyed by Lang, not an array: adding a language to messages.ts
// without listing it here is then a compile error instead of a silent gap.
const SUPPORTED: Record<Lang, true> = { ru: true, en: true };

// Languages the panel does not ship a UI for, mapped to the shipped language
// closest to them. This only picks the FIRST language a visitor sees; the
// toggle overrides it and is remembered.
const ALIASES: Record<string, Lang> = { uk: "ru", be: "ru", kk: "ru" };

/** True for exactly the codes we ship ("ru", "en"); no case folding. */
export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.hasOwn(SUPPORTED, value);
}

/**
 * First entry of `languages` (browser preference order) whose primary
 * subtag — the part before the first "-", lower-cased — is a shipped
 * language or aliases to one. `null` when none does.
 */
export function detectLang(languages: readonly string[]): Lang | null {
  for (const tag of languages) {
    const primary = tag.split("-")[0]?.toLowerCase();
    if (isLang(primary)) return primary;
    if (primary !== undefined && Object.hasOwn(ALIASES, primary)) {
      // noUncheckedIndexedAccess widens the lookup; hasOwn already proved it.
      return ALIASES[primary] as Lang;
    }
  }
  return null;
}

export type LangSource = "stored" | "browser" | "fallback";

export type InitialLang = { lang: Lang; source: LangSource };

/**
 * Stored explicit choice wins; otherwise the browser; otherwise `fallback`.
 * `source` tells the caller whether the result came from the browser and
 * should therefore be persisted.
 */
export function resolveInitialLang(
  stored: string | null,
  languages: readonly string[],
  fallback: Lang,
): InitialLang {
  if (isLang(stored)) return { lang: stored, source: "stored" };
  const detected = detectLang(languages);
  if (detected !== null) return { lang: detected, source: "browser" };
  return { lang: fallback, source: "fallback" };
}
