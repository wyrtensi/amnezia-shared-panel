"use client";

import * as React from "react";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

/** Small build-version line for the admin sidebar (GET /api/admin/version). */
export function VersionBadge() {
  const { t } = useT();
  const [version, setVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    apiRequest<{ version: string; commit: string | null }>(
      "/api/admin/version",
    )
      .then((info) => setVersion(info.commit || info.version))
      .catch(() => setVersion(null));
  }, []);

  if (!version) return null;
  return (
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">
      {t("admin.version")}: <span className="font-mono">{version}</span>
    </div>
  );
}
