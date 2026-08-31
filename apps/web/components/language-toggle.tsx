"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

/**
 * Compact RU/EN switch. Matches ThemeToggle's outline/icon shape and shows the
 * currently active language; clicking flips to the other one.
 */
export function LanguageToggle() {
  const { lang, setLang, t } = useT();
  const next = lang === "ru" ? "en" : "ru";

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t("lang.switch")}
      title={t("lang.switch")}
      onClick={() => setLang(next)}
      className="text-xs font-semibold uppercase"
    >
      {lang}
    </Button>
  );
}
