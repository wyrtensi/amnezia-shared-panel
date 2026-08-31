"use client";

import * as React from "react";
import { messages, type Lang, type MessageKey } from "@/lib/i18n/messages";

const STORAGE_KEY = "amnezia-lang";
const DEFAULT_LANG: Lang = "ru";

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

  // Read the persisted choice after mount so SSR and first paint stay on the
  // server-rendered default (ru) and hydration does not mismatch.
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "ru" || stored === "en") {
        setLangState(stored);
        document.documentElement.lang = stored;
      }
    } catch {
      /* localStorage unavailable — keep the default */
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
