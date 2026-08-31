"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

export default function LoginPage() {
  const { t } = useT();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setError(params.get("error"));
  }, []);

  const message =
    error === "not_allowed"
      ? t("login.notAllowed")
      : error === "unavailable"
        ? t("login.unavailable")
        : error
          ? t("login.failed")
          : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("login.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
        </div>
        {message ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {message}
          </p>
        ) : null}
        <Button asChild className="w-full">
          <a href="/api/auth/google/start">{t("login.google")}</a>
        </Button>
      </div>
    </div>
  );
}
