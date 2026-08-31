"use client";

import * as React from "react";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

/** Small build-version line for the admin sidebar (GET /api/admin/version). */
export function VersionBadge() {
  const { t } = useT();
  const [info, setInfo] = React.useState<{
    version: string;
    commit: string | null;
  } | null>(null);

  React.useEffect(() => {
    apiRequest<{ version: string; commit: string | null }>(
      "/api/admin/version",
    )
      .then((data) => setInfo(data))
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;
  // Prefer the release tag (e.g. v0.4.2); fall back to a short commit for local
  // "dev" builds. The full commit stays available on hover.
  const label =
    info.version && info.version !== "dev"
      ? info.version
      : info.commit
        ? info.commit.slice(0, 7)
        : "dev";
  return (
    <div
      className="px-3 pb-3 text-[11px] text-muted-foreground"
      title={info.commit ?? undefined}
    >
      {t("admin.version")}: <span className="font-mono">{label}</span>
    </div>
  );
}
