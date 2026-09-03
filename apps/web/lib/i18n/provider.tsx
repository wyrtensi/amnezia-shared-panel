"use client";

import * as React from "react";
import { resolveInitialLang } from "@/lib/i18n/detect";
import { messages, type Lang, type MessageKey } from "@/lib/i18n/messages";

const STORAGE_KEY = "amnezia-lang";
// What the server and the first client render use. Unchanged: changing it
// would change the SSR output and reintroduce the hydration problem.
const DEFAULT_LANG: Lang = "ru";
// What a visitor gets when neither storage nor the browser decides. Separate
// from DEFAULT_LANG on purpose: the first paint stays Russian, but a browser
// that asks for neither Russian nor English lands in English.
const DETECTION_FALLBACK: Lang = "en";

/**
 * The browser's ordered preference list.
 *
 * The DOM types say `languages` is always there, but it is missing on older
 * engines and in some embedded webviews -- and this runs inside the provider's
 * mount effect, where a TypeError takes the whole language context down with
 * it. So neither value is trusted to exist, and an engine that exposes neither
 * simply reports no preference and lands on the fallback.
 */
function browserLanguages(): readonly string[] {
  const list = navigator.languages as readonly string[] | undefined;
  if (list && list.length > 0) return list;
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

/** A message key with autocomplete, while still accepting computed strings. */
type TKey = MessageKey | (string & {});
type TVars = Record<string, string | number>;

function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

function translate(lang: Lang, key: TKey, vars?: TVars): string {
  const dict = messages[lang] as Record<string, string>;
  const template = dict[key];
  // Missing keys fall back to the key itself so they are visible in dev.
  if (template === undefined) return key;
  return interpolate(template, vars);
}

type LanguageContextValue = {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (key: TKey, vars?: TVars) => string;
};

const LanguageContext = React.createContext<LanguageContextValue>({
  lang: DEFAULT_LANG,
  setLang: () => undefined,
  t: (key, vars) => translate(DEFAULT_LANG, key, vars),
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(DEFAULT_LANG);

  // Resolve the language after mount so SSR and the first paint stay on the
  // server-rendered default (ru) and hydration does not mismatch. A stored
  // explicit choice wins; on a first visit the browser's preference list
  // decides and that pick is persisted, so later visits read it as stored.
  // A fallback is not persisted: a browser that gains a supported language
  // later should still be detected.
  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* localStorage unavailable — behave as a first visit */
    }
    const resolved = resolveInitialLang(
      stored,
      browserLanguages(),
      DETECTION_FALLBACK,
    );
    setLangState(resolved.lang);
    document.documentElement.lang = resolved.lang;
    if (resolved.source === "browser") {
      try {
        window.localStorage.setItem(STORAGE_KEY, resolved.lang);
      } catch {
        /* ignore persistence failures */
      }
    }
  }, []);

  const setLang = React.useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore persistence failures */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
  }, []);

  const t = React.useCallback(
    (key: TKey, vars?: TVars) => translate(lang, key, vars),
    [lang],
  );

  const value = React.useMemo<LanguageContextValue>(
    () => ({ lang, setLang, t }),
    [lang, setLang, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useT(): LanguageContextValue {
  return React.useContext(LanguageContext);
}
